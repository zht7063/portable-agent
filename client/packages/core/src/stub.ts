import { PaException } from './contract/errors.js';

export const notImplemented = (what: string): never => {
  throw new PaException({ code: 'NOT_IMPLEMENTED', message: `${what} not implemented (M0 stub)` });
};
