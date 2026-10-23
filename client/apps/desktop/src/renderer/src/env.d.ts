import type { PaBridge } from '@pa/core/contract';
declare global {
  interface Window { pa: PaBridge }
}
export {};
