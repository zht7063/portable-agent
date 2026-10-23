import { useEffect, useState } from 'react';
import type { ConflictResolution, Detection, HarnessChannelStatus, HarnessHistory, HarnessId, HarnessProfile, KeyMode, KeyringStatus, ModelInfo, Plan, RollbackPreview, RollbackTarget } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

const KIND: Record<string, string> = { create: '新增', modify: '修改', remove: '移除', unchanged: '不变' };
const ACTION: Record<string, string> = { apply: '应用前', rollback: '回滚前', detach: '移除前' };
const fileName = (f: string) => f.split(/[\\/]/).pop() ?? f;
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
const dim = { color: '#6b7280' } as const;
const warn = { color: '#b45309' } as const;

/** Masked per-setting diff table shared by apply previews and rollback previews. */
function DiffTable({ changes, label }: { changes: Plan['changes']; label: string }) {
  const shown = changes.filter((c) => c.kind !== 'unchanged');
  if (!shown.length) return <p style={dim}>没有托管设置的变更</p>;
  return (
    <table aria-label={label} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead><tr><th align="left">文件</th><th align="left">设置</th><th align="left">变更</th><th align="left">之前</th><th align="left">之后</th></tr></thead>
      <tbody>{shown.map((c) => (
        <tr key={`${c.file}#${c.setting}`} style={{ borderTop: '1px solid #eee' }}>
          <td title={c.file}>{fileName(c.file)}</td><td><code>{c.setting}</code></td><td>{KIND[c.kind]}</td>
          <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.before ?? '—'}</td>
          <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.after ?? '—'}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

const META: Record<HarnessId, { title: string; bin: string; small: string | null }> = {
  pi: { title: 'Pi', bin: 'pi', small: '备选' },
  claude: { title: 'Claude Code', bin: 'claude', small: 'Haiku（后台）' },
  codex: { title: 'Codex', bin: 'codex', small: null },
};
const CHANNEL: Record<HarnessChannelStatus['state'], string> = {
  'not-checked': '服务端渠道未就绪（未探测）',
  'no-profile': '服务端渠道未就绪（先预览一次以保存配置）',
  unreachable: '服务端渠道未就绪（无法探测）',
  'model-missing': '服务端渠道未就绪（/v1/models 中没有该模型）',
  'model-listed': '模型已上架（Responses 通道未经 live 验证）',
};

/** Harness card (Pi, Claude Code, Codex) with apply/rollback previews. Only masked values ever reach this component; keys stay in main. */
export function HarnessPanel({ keyId, serverUrl, harness = 'pi' }: { keyId?: number; serverUrl?: string; harness?: HarnessId }) {
  const meta = META[harness];
  const [det, setDet] = useState<Detection | null>(null);
  const [kr, setKr] = useState<KeyringStatus | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [main, setMain] = useState('');
  const [small, setSmall] = useState('');
  const [mode, setMode] = useState<KeyMode>('command');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [acks, setAcks] = useState<Record<string, ConflictResolution>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [channel, setChannel] = useState<HarnessChannelStatus>({ state: 'not-checked', checkedAt: '' });
  const isCodex = harness === 'codex';
  const [cxDefault, setCxDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<HarnessHistory | null>(null);
  const [rb, setRb] = useState<{ label: string; preview: RollbackPreview } | null>(null);

  const run = async (fn: () => Promise<unknown>) => { setMsg(null); setNote(null); setBusy(true); try { await fn(); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); } };
  const loadData = async () => {
    const d = await call('harness:detect', {});
    setDet(d.harnesses.find((h) => h.id === harness) ?? null);
    const k = await call('harness:keyring:status', { profileId: 'default' });
    setKr(k);
    if (!k.available) setMode('env');
    const p = (await call('harness:profile:list', {})).profiles.find((x) => x.id === 'default');
    if (p) { setMain(isCodex ? (p.models.codex ?? p.models.main) : p.models.main); setSmall(p.models.small ?? ''); setMode(p.keyMode === 'plaintext' ? 'command' : p.keyMode); setCxDefault(p.codex?.setDefault === true); }
    setHist(await call('harness:history', { id: harness }).catch(() => null));
    const m = await call('models:list', {}).catch(() => [] as ModelInfo[]);
    setModels(m);
    if (!p && m[0]) setMain(m[0].id);
  };
  const load = () => run(loadData);
  useEffect(() => { void load(); }, []);

  const doPlan = () => run(async () => {
    if (keyId === undefined || !serverUrl) { setMsg('请先在 API Keys 中选择一个 key'); return; }
    const prev = (await call('harness:profile:list', {})).profiles.find((x) => x.id === 'default');
    // One shared profile: keep the other harness's options, only replace what this card edits.
    const profile: HarnessProfile = { ...(prev ?? {}), id: 'default', serverUrl, keyId, keyMode: mode, models: isCodex ? { ...(prev?.models ?? {}), main: prev?.models.main ?? main, codex: main } : { ...(prev?.models ?? {}), main, ...(small ? { small } : { small: undefined }) } };
    if (isCodex) profile.codex = { ...(prev?.codex ?? {}), setDefault: cxDefault };
    await call('harness:profile:upsert', profile);
    setAcks({}); setRb(null);
    setPlan(await call('harness:plan', { id: harness, profileId: 'default' }));
  });
  const doApply = () => {
    if (!plan || !window.confirm(`将修改 ${meta.title} 的配置文件（已自动备份）。继续？`)) return;
    void run(async () => {
      const r = await call('harness:apply', { id: harness, plan, acknowledge: Object.entries(acks).map(([conflictId, resolution]) => ({ conflictId, resolution })), confirm: true });
      setPlan(null);
      await loadData();
      setNote(r.written.length ? `已写入：${r.written.join(', ')}` : '没有需要写入的变更');
    });
  };
  /** Step 1: read-only dry run, shown inline. Nothing is written until the user confirms. */
  const previewRollback = (target: RollbackTarget, label: string) => run(async () => {
    setPlan(null);
    setRb({ label, preview: await call('harness:rollback:preview', { id: harness, target }) });
  });
  /** Step 2: confirm (and, for files edited after our last write, confirm again) then roll back. */
  const confirmRollback = () => {
    if (!rb || rb.preview.blocked) return;
    const { label, preview } = rb;
    if (!window.confirm(`${label}？当前配置会先做快照，可再次回滚。`)) return;
    const edited = preview.externalEdits ?? [];
    // Aegis #1: files edited after our last write are only overwritten after a second, explicit confirmation.
    if (edited.length && !window.confirm(`以下文件在上次写入后被修改过，${label}会丢弃这些修改（修改前会先快照）：\n${edited.join('\n')}\n确定覆盖？`)) return;
    void run(async () => {
      const r = await call('harness:rollback', { id: harness, target: preview.target, confirm: true, ...(edited.length ? { overwriteExternal: true } : {}) });
      setRb(null); await loadData();
      setNote(`${label}完成：${r.written.map(fileName).join(', ') || '无变更'}`);
    });
  };
  const probe = () => run(async () => setChannel(await call('harness:channel:probe', { profileId: 'default' })));
  const unresolved = plan?.conflicts.some((c) => !acks[c.id] || acks[c.id] === 'cancel') ?? false;

  return (
    <Section title={`Harness · ${meta.title}`}>
      <p>
        {det ? (det.installed ? `已安装 ${det.version ?? ''}` : `未检测到 ${meta.bin}`) : '…'} · 配置目录 <code>{det?.configDir ?? '…'}</code>
        {' '}· 钥匙串 {kr ? (kr.available ? kr.backend : `不可用（使用环境变量模式）`) : '…'}
        {hist && <> · <span aria-label="接管状态">{hist.attached ? '已接管' : '未接管'}</span></>}{' '}
        <button disabled={busy} onClick={() => void load()}>刷新</button>{busy && <span role="progressbar" style={dim}> 处理中…</span>}
      </p>
      {isCodex && (
        <p role="status" style={{ color: channel.state === 'model-listed' ? '#047857' : '#b45309' }}>
          {CHANNEL[channel.state]}{channel.model ? `：${channel.model}` : ''}{channel.checkedAt ? <span style={dim}>（{when(channel.checkedAt)}）</span> : null}{' '}
          <button disabled={busy} onClick={() => void probe()}>探测服务端渠道</button>
        </p>
      )}
      {det && !det.installed && <p style={warn}>未检测到 {meta.bin}：仍可写入配置，安装后即可使用。</p>}
      {kr && !kr.available && <p style={warn}>系统钥匙串不可用：请在 shell 中 export PA_API_KEY（值为所选 key），再启动 {meta.bin}。</p>}
      {det?.notes.map((n) => <p key={n} style={dim}>{n}</p>)}
      <p>
        {isCodex ? 'Codex 模型' : '主模型'} <select aria-label="主模型" value={main} onChange={(e) => setMain(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}{main && !models.some((m) => m.id === main) && <option value={main}>{main}</option>}</select>{' '}
        {meta.small && <>{meta.small} <select aria-label="备选模型" value={small} onChange={(e) => setSmall(e.target.value)}><option value="">（无）</option>{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</select>{' '}</>}
        取 key 方式 <select aria-label="取 key 方式" value={mode} onChange={(e) => setMode(e.target.value as KeyMode)}>
          <option value="command" disabled={kr?.available === false}>钥匙串（pa-key）</option>
          <option value="env">环境变量 PA_API_KEY</option>
        </select>{' '}
        {isCodex && <><label><input type="checkbox" aria-label="设为 Codex 默认" checked={cxDefault} onChange={(e) => setCxDefault(e.target.checked)} /> 设为 Codex 默认（改写 model / model_provider）</label>{' '}</>}
        <button disabled={!main || busy} onClick={() => void doPlan()}>预览变更</button>
      </p>
      {plan && (
        <div>
          <DiffTable changes={plan.changes} label="变更预览" />
          {plan.conflicts.map((c) => (
            <p key={c.id} role="alert" style={{ color: '#b45309' }}>
              冲突：{c.message}{' '}
              <select aria-label={`冲突处理 ${c.id}`} value={acks[c.id] ?? 'cancel'} onChange={(e) => setAcks({ ...acks, [c.id]: e.target.value as ConflictResolution })}>
                <option value="cancel">取消</option><option value="overwrite">覆盖</option><option value="keep-external">保留外部修改</option>
              </select>
            </p>
          ))}
          {plan.externalUnownedChange.length > 0 && <p style={dim}>文件有其他（非托管）修改，将保留并合并。</p>}
          {plan.warnings.map((w) => <p key={w} style={warn}>{w}</p>)}
          <button disabled={unresolved || busy} onClick={doApply}>应用</button>{' '}
          <button onClick={() => setPlan(null)}>取消</button>
          {unresolved && <span style={warn}> 请先处理所有冲突</span>}
        </div>
      )}
      <details open={!!rb}>
        <summary>回滚与恢复</summary>
        <p>
          <button disabled={busy || !hist?.snapshots.some((x) => x.action === 'apply')} onClick={() => void previewRollback('last', '回滚到上一版')}>回滚到上一版</button>{' '}
          <button disabled={busy || hist?.firstWrite === false} onClick={() => void previewRollback('first-write', '恢复到首次写入前')}>恢复到首次写入前</button>{' '}
          <button disabled={busy || hist?.attached === false} onClick={() => void previewRollback('detach', '移除我们的配置')}>移除我们的配置</button>
        </p>
        {hist && (hist.snapshots.length ? (
          <ul aria-label="快照列表" style={{ fontSize: 13 }}>
            {hist.snapshots.map((x) => (
              <li key={x.snapshotId}>
                {when(x.at)} · {ACTION[x.action]}快照 <code style={dim}>{x.snapshotId.slice(-6)}</code>{' '}
                {x.available ? <button disabled={busy} onClick={() => void previewRollback({ snapshotId: x.snapshotId }, `恢复到 ${when(x.at)} 的快照`)}>预览恢复</button> : <span style={dim}>（已清理）</span>}
              </li>
            ))}
          </ul>
        ) : <p style={dim}>还没有快照（首次应用后出现）</p>)}
        {rb && (
          <div role="region" aria-label="回滚预览" style={{ borderLeft: '3px solid #b45309', paddingLeft: 8 }}>
            <p><strong>{rb.label}</strong> · 预览（尚未写入）</p>
            {rb.preview.files.length > 0 && <p style={dim}>文件：{rb.preview.files.map((f) => `${fileName(f.path)}（${KIND[f.kind]}）`).join('，')}</p>}
            <DiffTable changes={rb.preview.changes} label="回滚预览变更" />
            {rb.preview.warnings.map((w) => <p key={w} style={warn}>{w}</p>)}
            {rb.preview.externalEdits?.length ? <p role="alert" style={warn}>这些文件在上次写入后被修改过，继续将丢弃这些修改（会先快照）：{rb.preview.externalEdits.map(fileName).join('，')}</p> : null}
            {rb.preview.blocked && <p role="alert" style={{ color: '#b91c1c' }}>无法执行：{rb.preview.blocked}</p>}
            <button disabled={busy || !!rb.preview.blocked} onClick={confirmRollback}>确认{rb.label}</button>{' '}
            <button onClick={() => setRb(null)}>取消</button>
          </div>
        )}
      </details>
      {note && <p>{note}</p>}
      <Err msg={msg} />
    </Section>
  );
}
