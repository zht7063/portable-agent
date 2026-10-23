import { useEffect, useState } from 'react';
import type { Balance, TopupInfo } from '@pa/core/contract';
import { call, errText } from '../api';
import { Err, Section } from './ui';

export function BillingPanel() {
  const [bal, setBal] = useState<Balance | null>(null);
  const [info, setInfo] = useState<TopupInfo | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = () => Promise.all([call('billing:balance', {}).then(setBal), call('billing:topupInfo', {}).then(setInfo)]).catch((e) => setMsg(errText(e)));
  useEffect(() => { void load(); }, []);
  const redeem = async () => {
    setMsg(null); setNote(null);
    try {
      const r = await call('billing:redeem', { code });
      setNote(`兑换成功：+${r.added} quota`); setCode(''); await load();
    } catch (e) { setMsg(errText(e)); }
  };
  return (
    <Section title="余额">
      <p>
        {bal ? <>余额 <b>${bal.usd.toFixed(4)}</b>（quota {bal.quota}，已用 {bal.usedQuota}）</> : '…'}{' '}
        <button onClick={() => void load()}>刷新</button>
      </p>
      <small>计费为分时段（工作日高峰时段倍率更高），以实际扣费为准。</small>
      {info?.enableRedemption ? (
        <p>
          <input placeholder="兑换码" value={code} onChange={(e) => setCode(e.target.value)} />{' '}
          <button disabled={!code.trim()} onClick={() => void redeem()}>兑换</button>
        </p>
      ) : info && <p>服务器未开启兑换码</p>}
      {note && <p>{note}</p>}
      <Err msg={msg} />
    </Section>
  );
}
