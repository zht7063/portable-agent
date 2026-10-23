import { useEffect, useState } from 'react';
import type { ClientConfig, SessionView } from '@pa/core/contract';
import { call } from './api';
import { AuthPanel } from './panels/AuthPanel';
import { BillingPanel } from './panels/BillingPanel';
import { KeysPanel } from './panels/KeysPanel';
import { ChatPanel } from './panels/ChatPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { HarnessPanel } from './panels/HarnessPanel';

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [keyId, setKeyId] = useState<number | undefined>();

  useEffect(() => {
    void call('auth:session', {}).then(setSession);
    void call('config:get', {}).then(setConfig);
    return window.pa.on('session:changed', setSession);
  }, []);

  const authed = session?.status === 'authenticated' || session?.status === 'refreshing';
  return (
    <main style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 960, margin: '0 auto' }}>
      {config?.insecureTransport && (
        <div role="alert" style={{ background: '#fde68a', padding: 8, marginBottom: 8 }}>
          ⚠️ 明文 HTTP 原型：仅限测试账号（{config.serverUrl}）
        </div>
      )}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Portable Agent</h2>
        <span>
          {session?.username ? `${session.username} · ` : ''}{session?.status ?? '…'} · 存储 {session?.storage ?? '…'}
          {authed && <button style={{ marginLeft: 8 }} onClick={() => void call('auth:logout', {}).then(setSession)}>退出</button>}
        </span>
      </header>
      <SettingsPanel config={config} onChange={setConfig} />
      {!authed ? (
        <AuthPanel onSession={setSession} />
      ) : (
        <>
          <BillingPanel />
          <KeysPanel selected={keyId} onSelect={setKeyId} />
          <ChatPanel keyId={keyId} defaultMaxTokens={config?.defaultMaxTokens ?? 2048} />
          <HarnessPanel keyId={keyId} serverUrl={config?.serverUrl} harness="pi" />
          <HarnessPanel keyId={keyId} serverUrl={config?.serverUrl} harness="claude" />
          <HarnessPanel keyId={keyId} serverUrl={config?.serverUrl} harness="codex" />
        </>
      )}
    </main>
  );
}
