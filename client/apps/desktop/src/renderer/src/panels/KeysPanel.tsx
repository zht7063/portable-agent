import { useEffect, useState } from 'react';
import type { KeySummary } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

const STATUS: Record<number, string> = { 1: '启用', 2: '禁用', 3: '过期', 4: '耗尽' };

export function KeysPanel({ selected, onSelect }: { selected?: number; onSelect: (id: number | undefined) => void }) {
  const [keys, setKeys] = useState<KeySummary[] | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Full key shown only after an explicit reveal click; cleared on hide/reload. */
  const [revealed, setRevealed] = useState<{ id: number; secret: string } | null>(null);

  const run = async (fn: () => Promise<unknown>) => { setMsg(null); setNote(null); try { await fn(); } catch (e) { setMsg(errText(e)); } };
  const load = () => run(async () => {
    const list = await call('keys:list', {});
    setKeys(list);
    if (selected === undefined && list[0]) onSelect(list.find((k) => k.status === 1)?.id);
  });
  useEffect(() => { void load(); }, []);

  return (
    <Section title="API Keys">
      <p>
        <input placeholder="新 key 名称" value={name} onChange={(e) => setName(e.target.value)} />{' '}
        <button disabled={!name.trim()} onClick={() => void run(async () => { const k = await call('keys:create', { name }); setName(''); onSelect(k.id); await load(); })}>新建</button>{' '}
        <button onClick={() => void load()}>刷新</button>
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">用于对话</th><th align="left">名称</th><th align="left">Key</th><th align="left">状态</th><th align="left">额度</th><th /></tr></thead>
        <tbody>
          {keys?.map((k) => (
            <tr key={k.id} style={{ borderTop: '1px solid #eee' }}>
              <td><input type="radio" checked={selected === k.id} onChange={() => onSelect(k.id)} /></td>
              <td>{k.name}</td>
              <td style={{ fontFamily: 'monospace' }}>
                {revealed?.id === k.id ? <span style={{ userSelect: 'all' }}>{revealed.secret}</span> : k.maskedKey}
              </td>
              <td>{STATUS[k.status] ?? k.status}</td>
              {/* unlimited keys show negative remain_quota on rc.46: show user balance instead */}
              <td>{k.unlimitedQuota ? '不限（以账户余额为准）' : k.remainQuota}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button style={{ fontWeight: 600 }} onClick={() => void run(async () => { await call('keys:copy', { id: k.id }); setNote(`已复制 ${k.name} 到剪贴板`); })}>复制</button>{' '}
                {revealed?.id === k.id ? (
                  <button onClick={() => setRevealed(null)}>隐藏</button>
                ) : (
                  <button
                    onClick={() => {
                      if (!window.confirm(`显示 ${k.name} 的完整 key？请勿在他人可见时操作。`)) return;
                      void run(async () => setRevealed(await call('keys:reveal', { id: k.id, confirm: true })));
                    }}
                  >显示</button>
                )}{' '}
                <button onClick={() => void run(async () => { await call('keys:update', { id: k.id, status: k.status === 1 ? 2 : 1 }); await load(); })}>{k.status === 1 ? '禁用' : '启用'}</button>{' '}
                <button onClick={() => { if (window.confirm(`删除 ${k.name}？`)) void run(async () => { await call('keys:delete', { id: k.id }); if (revealed?.id === k.id) setRevealed(null); if (selected === k.id) onSelect(undefined); await load(); }); }}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys === null && !msg && <p>加载中…</p>}
      {keys?.length === 0 && <p>还没有 API key，输入名称后点“新建”。</p>}
      {note && <p>{note}</p>}
      <Err msg={msg} />
    </Section>
  );
}
