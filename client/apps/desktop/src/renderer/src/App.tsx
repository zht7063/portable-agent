import { useEffect, useState } from 'react';
import type { ClientConfig, SessionView } from '@pa/core/contract';

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);

  useEffect(() => {
    void window.pa.invoke('auth:session', {}).then((r) => r.ok && setSession(r.data));
    void window.pa.invoke('config:get', {}).then((r) => r.ok && setConfig(r.data));
    return window.pa.on('session:changed', setSession);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      {config?.insecureTransport && (
        <div role="alert" style={{ background: '#fde68a', padding: 8 }}>
          ⚠️ 明文 HTTP 原型：仅限测试账号（{config.serverUrl}）
        </div>
      )}
      <h1>Portable Agent（M0 原型）</h1>
      <p>会话状态：{session?.status ?? '…'} · 存储：{session?.storage ?? '…'}</p>
    </main>
  );
}
