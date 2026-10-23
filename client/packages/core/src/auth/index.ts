import type { LoginReq, RegisterReq, Empty } from '../contract/ipc.js';
import type { SessionView } from '../contract/session.js';
import { notImplemented } from '../stub.js';

/** M1a: register/login/refresh/logout via /api/user/*. */
export interface AuthModule {
  register(req: RegisterReq): Promise<Empty>;
  login(req: LoginReq): Promise<SessionView>;
  logout(): Promise<SessionView>;
}
export const createAuthStub = (): AuthModule => ({
  register: () => notImplemented('auth.register'),
  login: () => notImplemented('auth.login'),
  logout: () => notImplemented('auth.logout'),
});
