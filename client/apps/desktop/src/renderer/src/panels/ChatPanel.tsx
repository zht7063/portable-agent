import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ModelInfo, Usage } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

export function ChatPanel({ keyId, defaultMaxTokens }: { keyId?: number; defaultMaxTokens: number }) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState('');
  const [maxTokens, setMaxTokens] = useState(defaultMaxTokens);
  const [stream, setStream] = useState(true);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [reasoning, setReasoning] = useState('');
  const [answer, setAnswer] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [reqId, setReqId] = useState<string | null>(null);
  const acc = useRef('');

  useEffect(() => {
    call('models:list', {}).then((m) => { setModels(m); setModel((cur) => cur || m[0]?.id || ''); }).catch((e) => setMsg(errText(e)));
  }, []);

  useEffect(() => window.pa.on('chat:stream:event', (e) => {
    if (e.reqId !== reqId) return;
    if (e.type === 'reasoning') setReasoning((r) => r + e.delta);
    else if (e.type === 'content') { acc.current += e.delta; setAnswer(acc.current); }
    else if (e.type === 'usage') setUsage(e.usage);
    else if (e.type === 'done') {
      if (e.warning) setWarn('输出被截断且正文为空（模型把 token 用在了推理上），请调大 max_tokens');
      setHistory((h) => [...h, { role: 'assistant', content: acc.current }]);
      setReqId(null);
    } else if (e.type === 'error') { setMsg(errText(e.error)); setReqId(null); }
  }), [reqId]);

  const send = async () => {
    if (!input.trim()) return;
    const messages: ChatMessage[] = [...history, { role: 'user', content: input }];
    setHistory(messages); setInput(''); setReasoning(''); setAnswer(''); acc.current = ''; setUsage(null); setWarn(null); setMsg(null);
    try {
      if (stream) {
        const id = crypto.randomUUID();
        setReqId(id);
        await call('chat:stream:start', { reqId: id, model, messages, maxTokens, keyId });
      } else {
        const r = await call('chat:complete', { model, messages, maxTokens, keyId });
        setReasoning(r.reasoning ?? ''); setAnswer(r.content); setUsage(r.usage ?? null);
        if (r.warning) setWarn('输出被截断且正文为空，请调大 max_tokens');
        setHistory([...messages, { role: 'assistant', content: r.content }]);
      }
    } catch (e) { setMsg(errText(e)); setReqId(null); }
  };

  return (
    <Section title="对话">
      <p>
        模型 <select value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m.id}>{m.id}</option>)}</select>{' '}
        max_tokens <input type="number" style={{ width: 80 }} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value) || defaultMaxTokens)} />{' '}
        <label><input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> 流式</label>{' '}
        {keyId === undefined && <b>请先在上方选择一个 key</b>}
      </p>
      <div style={{ maxHeight: 200, overflow: 'auto' }}>
        {history.slice(0, reqId ? undefined : -1).map((m, i) => <p key={i}><b>{m.role}:</b> {m.content}</p>)}
      </div>
      {reasoning && <details><summary>推理过程</summary><pre style={{ whiteSpace: 'pre-wrap', color: '#555' }}>{reasoning}</pre></details>}
      {(answer || reqId) && <p><b>assistant:</b> {answer}{reqId ? ' ▍' : ''}</p>}
      {usage && <small>tokens：{usage.promptTokens} + {usage.completionTokens} = {usage.totalTokens}</small>}
      {warn && <p style={{ color: '#b45309' }}>{warn}</p>}
      <p>
        <textarea rows={3} style={{ width: '100%' }} value={input} onChange={(e) => setInput(e.target.value)} />
        <button disabled={!!reqId || !model || keyId === undefined} onClick={() => void send()}>发送</button>{' '}
        {reqId && <button onClick={() => void call('chat:stream:cancel', { reqId })}>停止</button>}{' '}
        <button onClick={() => { setHistory([]); setAnswer(''); setReasoning(''); }}>清空</button>
      </p>
      <Err msg={msg} />
    </Section>
  );
}
