import type { Balance, RedeemReq, RedeemRes, TopupInfo } from '../contract/ipc.js';
import { notImplemented } from '../stub.js';

export const QUOTA_PER_USD = 500_000;
export const quotaToUsd = (quota: number): number => quota / QUOTA_PER_USD;

/** M1b: /api/user/self, /api/user/topup/info, POST /api/user/topup. */
export interface BillingModule {
  balance(): Promise<Balance>;
  topupInfo(): Promise<TopupInfo>;
  redeem(req: RedeemReq): Promise<RedeemRes>;
}
export const createBillingStub = (): BillingModule => ({
  balance: () => notImplemented('billing.balance'),
  topupInfo: () => notImplemented('billing.topupInfo'),
  redeem: () => notImplemented('billing.redeem'),
});
