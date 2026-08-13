// Mail bridge: turns alert emails into dashboard events.
//
// Telus SmartHome / Alarm.com has no public API or webhooks, but the app can
// send an email for any event (motion, door opened, alarm, arming changes —
// configured under Notifications in the Telus/Alarm.com app). Point those
// notifications at a mailbox, give the dashboard IMAP access to it, and every
// matching email becomes an event — an alarm-level one when the subject reads
// like an actual alarm.
//
// Configuration (bridge is disabled unless the first three are set):
//   ALARM_DASH_MAIL_HOST / ALARM_DASH_MAIL_USER / ALARM_DASH_MAIL_PASSWORD
//   ALARM_DASH_MAIL_PORT      default 993
//   ALARM_DASH_MAIL_SECURE    default true ("false" for STARTTLS-less 143)
//   ALARM_DASH_MAIL_FOLDER    default INBOX
//   ALARM_DASH_MAIL_FROM      comma-separated sender filters,
//                             default "alarm.com,telus"
//   ALARM_DASH_MAIL_POLL_SECONDS  default 60

import { ImapFlow } from 'imapflow';
import { classifyLevel } from './classify.js';
import type { EventBus } from './events.js';

export interface MailBridgeConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  folder: string;
  from: string[];
  pollMs: number;
}

export function mailBridgeConfigFromEnv(env = process.env): MailBridgeConfig | null {
  const host = env.ALARM_DASH_MAIL_HOST || '';
  const user = env.ALARM_DASH_MAIL_USER || '';
  const password = env.ALARM_DASH_MAIL_PASSWORD || '';
  if (host === '' || user === '' || password === '') return null;
  return {
    host,
    user,
    password,
    port: Number(env.ALARM_DASH_MAIL_PORT) || 993,
    secure: env.ALARM_DASH_MAIL_SECURE !== 'false',
    folder: env.ALARM_DASH_MAIL_FOLDER || 'INBOX',
    from: (env.ALARM_DASH_MAIL_FROM || 'alarm.com,telus')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    pollMs: (Number(env.ALARM_DASH_MAIL_POLL_SECONDS) || 60) * 1000,
  };
}

export class MailBridge {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private seenMessageIds = new Set<string>();

  constructor(
    private config: MailBridgeConfig,
    private events: EventBus
  ) {
    void this.tick();
  }

  get status(): { host: string; user: string; from: string[]; lastError: string | null } {
    return {
      host: this.config.host,
      user: this.config.user,
      from: this.config.from,
      lastError: this.lastError,
    };
  }

  private async tick(): Promise<void> {
    try {
      await this.poll();
      this.lastError = null;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastError) {
        console.error(`[mail-bridge] poll failed: ${message}`);
      }
      this.lastError = message;
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.tick(), this.config.pollMs);
    }
  }

  private async poll(): Promise<void> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
    await client.connect();
    try {
      await client.mailboxOpen(this.config.folder);
      for (const from of this.config.from) {
        const uids = await client.search({ seen: false, from }, { uid: true });
        if (!uids || uids.length === 0) continue;
        for (const uid of uids) {
          const message = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
          if (!message) continue;
          const envelope = message.envelope;
          const messageId = envelope?.messageId ?? `${this.config.host}:${this.config.folder}:${uid}`;
          if (!this.seenMessageIds.has(messageId)) {
            this.seenMessageIds.add(messageId);
            if (this.seenMessageIds.size > 2000) {
              this.seenMessageIds = new Set([...this.seenMessageIds].slice(-1000));
            }
            const subject = envelope?.subject?.trim() || '(no subject)';
            const sender = envelope?.from?.[0]?.address ?? from;
            this.events.emit({
              level: classifyLevel(subject),
              type: 'external',
              message: subject.slice(0, 500),
              source: `mail:${sender}`,
            });
          }
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
