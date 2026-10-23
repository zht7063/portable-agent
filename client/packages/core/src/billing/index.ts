import { PaException } from '../contract/errors.js';
import type { Balance, RedeemReq, RedeemRes, TopupInfo } from '../contract/ipc.js';
import type { HttpClient } from '../http/client.js';

export const QUOTA_PER_USD = 500_000;
export const quotaToUsd = (quota: number): number => quota / QUOTA_PER_USD;

export interface BillingModule {
  balance(): Promise<Balance>;
  topupInfo(): Promise<TopupInfo>;
  redeem(req: RedeemReq): Promise<RedeemRes>;
}

interface SelfData { quota: number; used_quota: number; request_count?: number }

export function createBilling(http: HttpClient): BillingModule {
  const balance = async (): Promise<Balance> => {
    const d = await http.api<SelfData>('GET', '/api/user/self');
    return { quota: d.quota, usedQuota: d.used_quota, usd: quotaToUsd(d.quota), requestCount: d.request_count };
  };
  return {
    balance,
    async topupInfo() {
      const d = await http.api<{ enable_redemption?: boolean; payment_compliance_confirmed?: boolean }>('GET', '/api/user/topup/info');
      return { enableRedemption: !!d.enable_redemption, paymentComplianceConfirmed: !!d.payment_compliance_confirmed };
    },
    async redeem({ code }) {
      const key = code.trim();
      if (!key) throw new PaException({ code: 'VALIDATION', message: 'Redeem code required' });
      const added = await http.api<number>('POST', '/api/user/topup', { body: { key } });
      const b = await balance();
      return { added, quota: b.quota };
    },
  };
}
