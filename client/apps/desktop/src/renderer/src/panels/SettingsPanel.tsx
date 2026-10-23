import { useEffect, useState } from 'react';
import type { ClientConfig } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err } from './ui';

export function SettingsPanel({ config, onChange }: { config: ClientConfig | null; onChange: (c: ClientConfig) => void }) {
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (config) setUrl(config.serverUrl); }, [config]);
  return (
    <details style={{ marginTop: 8 }}>
      <summary>服务器设置</summary>
      <input style={{ width: 320 }} value={url} onChange={(e) => setUrl(e.target.value)} />{' '}
      <button onClick={() => { setMsg(null); call('config:set', { serverUrl: url }).then(onChange).catch((e) => setMsg(errText(e))); }}>保存（会退出当前登录）</button>
      <Err msg={msg} />
    </details>
  );
}
