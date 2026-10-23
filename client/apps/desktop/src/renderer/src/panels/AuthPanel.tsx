import { useState } from 'react';
import type { SessionView } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

export function AuthPanel({ onSession }: { onSession: (s: SessionView) => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setMsg(null); setInfo(null);
    try {
      if (mode === 'register') {
        await call('auth:register', { username, password });
        setInfo('注册成功，请登录'); setMode('login');
      } else {
        onSession(await call('auth:login', { username, password }));
      }
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); setP(''); }
  };
  return (
    <Section title={mode === 'login' ? '登录' : '注册'}>
      <input placeholder="用户名" value={username} onChange={(e) => setU(e.target.value)} />{' '}
      <input placeholder="密码（8-128 位）" type="password" value={password} onChange={(e) => setP(e.target.value)} />{' '}
      <button disabled={busy} onClick={() => void submit()}>{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册'}</button>{' '}
      <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? '去注册' : '去登录'}</button>
      {info && <p>{info}</p>}
      <Err msg={msg} />
    </Section>
  );
}
