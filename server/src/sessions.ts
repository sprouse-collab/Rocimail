// In-memory session store. Each browser session holds a primary JMAP account
// plus any number of secondary IMAP accounts. Sessions expire after idling.

import { randomBytes } from 'node:crypto';
import { AccountInfo, Alarm, ApiError, MailProvider } from './types.js';

export interface SessionAccount {
  info: AccountInfo;
  provider: MailProvider;
}

export interface Session {
  token: string;
  accounts: Map<string, SessionAccount>;
  alarms: Map<string, Alarm>;
  lastUsed: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

class SessionStore {
  private sessions = new Map<string, Session>();

  constructor() {
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref();
  }

  create(): Session {
    const token = randomBytes(32).toString('base64url');
    const session: Session = { token, accounts: new Map(), alarms: new Map(), lastUsed: Date.now() };
    this.sessions.set(token, session);
    return session;
  }

  get(token: string | undefined): Session {
    const session = token ? this.sessions.get(token) : undefined;
    if (!session) {
      throw new ApiError(401, 'Not signed in');
    }
    session.lastUsed = Date.now();
    return session;
  }

  async destroy(token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) return;
    this.sessions.delete(token);
    await Promise.allSettled([...session.accounts.values()].map((a) => a.provider.close()));
  }

  newAccountId(): string {
    return randomBytes(8).toString('hex');
  }

  newAlarmId(): string {
    return randomBytes(8).toString('hex');
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.lastUsed > SESSION_TTL_MS) {
        void this.destroy(token);
      }
    }
  }
}

export const sessionStore = new SessionStore();

export function getAccount(session: Session, accountId: string): SessionAccount {
  const account = session.accounts.get(accountId);
  if (!account) {
    throw new ApiError(404, 'Account not found');
  }
  return account;
}
