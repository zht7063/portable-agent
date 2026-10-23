import { useEffect, useState } from 'react';
import type { ConflictResolution, Detection, HarnessId, HarnessProfile, KeyMode, KeyringStatus, ModelInfo, Plan } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

const KIND: Record<string, string> = { create: '新增', modify: '修改', remove: '移除', unchanged: '不变' };

const META: Record<'pi' | 'claude', { title: string; bin: string; small: string }> = {
  pi: { title: 'Pi', bin: 'pi', small: '备选' },
  claude: { title: 'Claude Code', bin: 'claude', small: 'Haiku（后台）' },
};

/** Harness card (H1 Pi, H2 Claude Code). Only masked values ever reach this component; keys stay in main. */
export function HarnessPanel({ keyId, serverUrl, harness = 'pi' }: { keyId?: number; serverUrl?: string; harness?: Extract<HarnessId, 'pi' | 'claude'> }) {
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

  const run = async (fn: () => Promise<unknown>) => { setMsg(null); setNote(null); try { await fn(); } catch (e) { setMsg(errText(e)); } };
  const loadData = async () => {
    const d = await call('harness:detect', {});
    setDet(d.harnesses.find((h) => h.id === harness) ?? null);
    const k = await call('harness:keyring:status', { profileId: 'default' });
    setKr(k);
    if (!k.available) setMode('env');
    const p = (await call('harness:profile:list', {})).profiles.find((x) => x.id === 'default');
    if (p) { setMain(p.models.main); setSmall(p.models.small ?? ''); setMode(p.keyMode === 'plaintext' ? 'command' : p.keyMode); }
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
    const profile: HarnessProfile = { ...(prev ?? {}), id: 'default', serverUrl, keyId, keyMode: mode, models: { ...(prev?.models ?? {}), main, ...(small ? { small } : { small: undefined }) } };
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
    void run(async () => { const r = await call('harness:rollback', { id: harness, target, confirm: true }); setPlan(null); await loadData(); setNote(`${label}完成：${r.written.join(', ') || '无变更'}`); });
  };
  const unresolved = plan?.conflicts.some((c) => !acks[c.id] || acks[c.id] === 'cancel') ?? false;

  return (
    <Section title={`Harness · ${meta.title}`}>
      <p>
        {det ? (det.installed ? `已安装 ${det.version ?? ''}` : `未检测到 ${meta.bin}`) : '…'} · 配置目录 <code>{det?.configDir ?? '…'}</code>
        {' '}· 钥匙串 {kr ? (kr.available ? kr.backend : `不可用（使用环境变量模式）`) : '…'}{' '}
        <button onClick={() => void load()}>刷新</button>
      </p>
      {det?.notes.map((n) => <p key={n} style={{ color: '#6b7280' }}>{n}</p>)}
      <p>
        主模型 <select aria-label="主模型" value={main} onChange={(e) => setMain(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}{main && !models.some((m) => m.id === main) && <option value={main}>{main}</option>}</select>{' '}
        {meta.small} <select aria-label="备选模型" value={small} onChange={(e) => setSmall(e.target.value)}><option value="">（无）</option>{models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</select>{' '}
        取 key 方式 <select aria-label="取 key 方式" value={mode} onChange={(e) => setMode(e.target.value as KeyMode)}>
          <option value="command" disabled={kr?.available === false}>钥匙串（pa-key）</option>
          <option value="env">环境变量 PA_API_KEY</option>
        </select>{' '}
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
