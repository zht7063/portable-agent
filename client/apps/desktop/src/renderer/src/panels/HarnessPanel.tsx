import { useEffect, useState } from 'react';
import type { ConflictResolution, Detection, HarnessChannelStatus, HarnessId, HarnessProfile, KeyMode, KeyringStatus, ModelInfo, Plan } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

const KIND: Record<string, string> = { create: '新增', modify: '修改', remove: '移除', unchanged: '不变' };

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

/** Harness card (H1 Pi, H2 Claude Code). Only masked values ever reach this component; keys stay in main. */
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

  const run = async (fn: () => Promise<unknown>) => { setMsg(null); setNote(null); try { await fn(); } catch (e) { setMsg(errText(e)); } };
  const loadData = async () => {
    const d = await call('harness:detect', {});
    setDet(d.harnesses.find((h) => h.id === harness) ?? null);
    const k = await call('harness:keyring:status', { profileId: 'default' });
    setKr(k);
    if (!k.available) setMode('env');
    const p = (await call('harness:profile:list', {})).profiles.find((x) => x.id === 'default');
    if (p) { setMain(isCodex ? (p.models.codex ?? p.models.main) : p.models.main); setSmall(p.models.small ?? ''); setMode(p.keyMode === 'plaintext' ? 'command' : p.keyMode); setCxDefault(p.codex?.setDefault === true); }
    const m = await call('models:list', {}).catch(() => [] as ModelInfo[]);
    setModels(m);
    if (!p && m[0]) setMain(m[0].id);
  };
  const load = () => run(loadData);
  useEffect(() => { void load(); }, []);

  const doPlan = () => run(async () => {
    if (keyId === undefined || !serverUrl) throw new Error('请先在 API Keys 中选择一个 key');
    const prev = (await call('harness:profile:list', {})).profiles.find((x) => x.id === 'default');
    // One shared profile: keep the other harness's options, only replace what this card edits.
    const profile: HarnessProfile = { ...(prev ?? {}), id: 'default', serverUrl, keyId, keyMode: mode, models: isCodex ? { ...(prev?.models ?? {}), main: prev?.models.main ?? main, codex: main } : { ...(prev?.models ?? {}), main, ...(small ? { small } : { small: undefined }) } };
    if (isCodex) profile.codex = { ...(prev?.codex ?? {}), setDefault: cxDefault };
    await call('harness:profile:upsert', profile);
    setAcks({});
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
  const doRollback = (target: 'last' | 'first-write' | 'detach', label: string) => {
    if (!window.confirm(`${label}？当前配置会先做快照。`)) return;
    void run(async () => {
      // Aegis #1: files edited after our last write are only overwritten after a second, explicit confirmation.
      const pv = target === 'detach' ? null : await call('harness:rollback:preview', { id: harness, target });
      const overwriteExternal = !!pv?.externalEdits?.length;
      if (overwriteExternal && !window.confirm(`以下文件在上次写入后被修改过，${label}会丢弃这些修改（修改前会先快照）：\n${pv!.externalEdits!.join('\n')}\n确定覆盖？`)) return;
      const r = await call('harness:rollback', { id: harness, target, confirm: true, ...(overwriteExternal ? { overwriteExternal: true } : {}) });
      setPlan(null); await loadData(); setNote(`${label}完成：${r.written.join(', ') || '无变更'}`);
    });
  };
  const probe = () => run(async () => setChannel(await call('harness:channel:probe', { profileId: 'default' })));
  const unresolved = plan?.conflicts.some((c) => !acks[c.id] || acks[c.id] === 'cancel') ?? false;

  return (
    <Section title={`Harness · ${meta.title}`}>
      <p>
        {det ? (det.installed ? `已安装 ${det.version ?? ''}` : `未检测到 ${meta.bin}`) : '…'} · 配置目录 <code>{det?.configDir ?? '…'}</code>
        {' '}· 钥匙串 {kr ? (kr.available ? kr.backend : `不可用（使用环境变量模式）`) : '…'}{' '}
        <button onClick={() => void load()}>刷新</button>
      </p>
      {isCodex && (
        <p role="status" style={{ color: channel.state === 'model-listed' ? '#047857' : '#b45309' }}>
          {CHANNEL[channel.state]}{channel.model ? `：${channel.model}` : ''}{' '}
          <button onClick={() => void probe()}>探测服务端渠道</button>
        </p>
      )}
      {det?.notes.map((n) => <p key={n} style={{ color: '#6b7280' }}>{n}</p>)}
      <p>
        {isCodex ? 'Codex 模型' : '主模型'} <select aria-label="主模型" value={main} onChange={(e) => setMain(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}{main && !models.some((m) => m.id === main) && <option value={main}>{main}</option>}</select>{' '}
        {meta.small && <>{meta.small} <select aria-label="备选模型" value={small} onChange={(e) => setSmall(e.target.value)}><option value="">（无）</option>{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</select>{' '}</>}
        取 key 方式 <select aria-label="取 key 方式" value={mode} onChange={(e) => setMode(e.target.value as KeyMode)}>
          <option value="command" disabled={kr?.available === false}>钥匙串（pa-key）</option>
          <option value="env">环境变量 PA_API_KEY</option>
        </select>{' '}
        {isCodex && <><label><input type="checkbox" aria-label="设为 Codex 默认" checked={cxDefault} onChange={(e) => setCxDefault(e.target.checked)} /> 设为 Codex 默认（改写 model / model_provider）</label>{' '}</>}
        <button disabled={!main} onClick={() => void doPlan()}>预览变更</button>
      </p>
      {plan && (
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th align="left">文件</th><th align="left">设置</th><th align="left">变更</th><th align="left">之前</th><th align="left">之后</th></tr></thead>
            <tbody>{plan.changes.map((c) => (
              <tr key={`${c.file}#${c.setting}`} style={{ borderTop: '1px solid #eee' }}>
                <td>{c.file.split(/[\\/]/).pop()}</td><td><code>{c.setting}</code></td><td>{KIND[c.kind]}</td>
                <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.before ?? '—'}</td>
                <td style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.after ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          {plan.conflicts.map((c) => (
            <p key={c.id} role="alert" style={{ color: '#b45309' }}>
              冲突：{c.message}{' '}
              <select aria-label={`冲突处理 ${c.id}`} value={acks[c.id] ?? 'cancel'} onChange={(e) => setAcks({ ...acks, [c.id]: e.target.value as ConflictResolution })}>
                <option value="cancel">取消</option><option value="overwrite">覆盖</option><option value="keep-external">保留外部修改</option>
              </select>
            </p>
          ))}
          {plan.externalUnownedChange.length > 0 && <p style={{ color: '#6b7280' }}>文件有其他（非托管）修改，将保留并合并。</p>}
          {plan.warnings.map((w) => <p key={w} style={{ color: '#b45309' }}>{w}</p>)}
          <button disabled={unresolved} onClick={doApply}>应用</button>
        </div>
      )}
      <p>
        <button onClick={() => doRollback('last', '回滚到上一版')}>回滚到上一版</button>{' '}
        <button onClick={() => doRollback('first-write', '恢复到首次写入前')}>恢复到首次写入前</button>{' '}
        <button onClick={() => doRollback('detach', '移除我们的配置')}>移除我们的配置</button>
      </p>
      {note && <p>{note}</p>}
      <Err msg={msg} />
    </Section>
  );
}
