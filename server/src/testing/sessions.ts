import { randomBytes } from 'node:crypto';
import type { Identity, SessionWriter, Visitor } from '../auth/sessions.js';

/** A session writer for tests that need no database: it remembers who signed in and which tokens ended. */
export function recordingSessions() {
  const started: { token: string; identity: Identity; visitor: Visitor }[] = [];
  const ended: string[] = [];
  const writer: SessionWriter = {
    start(identity, visitor) {
      const token = randomBytes(32).toString('base64url');
      started.push({ token, identity, visitor });
      return Promise.resolve({ token, expiresAt: new Date(Date.now() + 12 * 3_600_000) });
    },
    end(token) {
      ended.push(token);
      return Promise.resolve();
    },
  };
  return { writer, started, ended };
}

export const devAuth = () => ({ mode: 'dev' as const, sessions: recordingSessions().writer, signingKey: randomBytes(32) });
