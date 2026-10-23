import { err, type Result } from '@pa/core/contract';

/** Minimal structural views of Electron objects so this stays unit-testable without electron. */
export interface FrameLike { url: string; parent: FrameLike | null }
export interface SenderEventLike { sender: unknown; senderFrame: FrameLike | null }
export interface WindowLike { isDestroyed?(): boolean; webContents: { mainFrame: FrameLike } }

const stripUrl = (u: string) => { try { const x = new URL(u); x.hash = ''; x.search = ''; return x.href; } catch { return null; } };

/**
 * Accept IPC only from the top-level frame of our own BrowserWindow, showing our bundled renderer.
 * Rejects: other webContents, sub-frames/iframes, destroyed or not-yet-created windows, any other URL.
 */
export function isTrustedSender(e: SenderEventLike, win: WindowLike | null | undefined, allowedUrl: string): boolean {
  if (!win || win.isDestroyed?.()) return false;
  const frame = e.senderFrame;
  if (!frame) return false; // frame navigated away or was destroyed
  if (e.sender !== win.webContents) return false;
  if (frame !== win.webContents.mainFrame || frame.parent !== null) return false;
  const want = stripUrl(allowedUrl);
  return want !== null && stripUrl(frame.url) === want;
}

export const untrustedSender = (): Result<never> => err('UNAUTHORIZED', 'Untrusted IPC sender');
