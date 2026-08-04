// IMAP/SMTP mail provider for secondary accounts, built on imapflow for IMAP
// access, mailparser for message parsing, and nodemailer for SMTP submission.

import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import nodemailer, { type Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import {
  AccountInfo,
  ApiError,
  AttachmentContent,
  EmailAddress,
  MailProvider,
  MailboxInfo,
  MailboxRole,
  MessageDetail,
  MessagePage,
  MessageSummary,
  OutgoingMessage,
} from './types.js';

export interface ImapAccountConfig {
  name: string;
  email: string;
  imap: { host: string; port: number; secure: boolean; username: string; password: string };
  smtp: { host: string; port: number; secure: boolean; username: string; password: string };
}

const SPECIAL_USE_ROLES: Record<string, MailboxRole> = {
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  '\\Important': 'important',
};

const encodePath = (path: string): string => Buffer.from(path, 'utf8').toString('base64url');
const decodePath = (id: string): string => Buffer.from(id, 'base64url').toString('utf8');

function mapParsedAddresses(addr?: AddressObject | AddressObject[]): EmailAddress[] {
  if (!addr) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  const out: EmailAddress[] = [];
  for (const obj of objects) {
    for (const value of obj.value ?? []) {
      if (value.address) {
        out.push({ name: value.name || undefined, email: value.address });
      }
    }
  }
  return out;
}

function mapEnvelopeAddresses(
  list?: Array<{ name?: string; address?: string }> | null
): EmailAddress[] {
  if (!list) return [];
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name || undefined, email: a.address! }));
}

function structureHasAttachment(node: any): boolean {
  if (!node) return false;
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some((child: any) => structureHasAttachment(child));
  }
  const disposition = (node.disposition ?? '').toLowerCase();
  if (disposition === 'attachment') return true;
  const type = (node.type ?? '').toLowerCase();
  return Boolean(type) && !type.startsWith('text/') && !type.startsWith('multipart/');
}

export class ImapProvider implements MailProvider {
  readonly kind = 'imap' as const;

  private client: ImapFlow | null = null;
  private opChain: Promise<unknown> = Promise.resolve();
  private mailboxCache: MailboxInfo[] | null = null;
  private transporter: Transporter | null = null;

  constructor(private config: ImapAccountConfig) {}

  /** Verifies the IMAP credentials by connecting and listing mailboxes. */
  static async connect(config: ImapAccountConfig): Promise<ImapProvider> {
    const provider = new ImapProvider(config);
    await provider.listMailboxes();
    return provider;
  }

  /** Serializes IMAP operations — an ImapFlow connection is single-channel. */
  private run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const next = this.opChain.then(
      async () => fn(await this.ensureConnected()),
      async () => fn(await this.ensureConnected())
    );
    this.opChain = next.catch(() => undefined);
    return next;
  }

  private async ensureConnected(): Promise<ImapFlow> {
    if (this.client && this.client.usable) {
      return this.client;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* connection already gone */
      }
    }
    const { imap } = this.config;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.username, pass: imap.password },
      logger: false,
    });
    try {
      await client.connect();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (/auth|login|credentials/i.test(message)) {
        throw new ApiError(401, `IMAP authentication failed for ${this.config.email}`);
      }
      throw new ApiError(502, `Could not connect to IMAP server ${imap.host}:${imap.port} — ${message}`);
    }
    this.client = client;
    return client;
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    return this.run(async (client) => {
      const entries = await client.list();
      const result: MailboxInfo[] = [];
      let sortOrder = 0;
      for (const entry of entries) {
        const flags: Set<string> = (entry.flags as Set<string>) ?? new Set();
        if (flags.has('\\NonExistent') || flags.has('\\Noselect')) continue;
        let total = 0;
        let unseen = 0;
        try {
          const status = await client.status(entry.path, { messages: true, unseen: true });
          total = status.messages ?? 0;
          unseen = status.unseen ?? 0;
        } catch {
          // Some servers refuse STATUS on certain folders; show zero counts.
        }
        const specialUse = (entry as any).specialUse as string | undefined;
        const role: MailboxRole | null =
          entry.path.toUpperCase() === 'INBOX'
            ? 'inbox'
            : (specialUse && SPECIAL_USE_ROLES[specialUse]) || null;
        const delimiter = entry.delimiter || '/';
        const idx = entry.path.lastIndexOf(delimiter);
        const parentPath = idx > 0 ? entry.path.slice(0, idx) : null;
        result.push({
          id: encodePath(entry.path),
          name: entry.name || entry.path,
          parentId: parentPath ? encodePath(parentPath) : null,
          role,
          totalMessages: total,
          unreadMessages: unseen,
          sortOrder: sortOrder++,
        });
      }
      this.mailboxCache = result;
      return result;
    });
  }

  private async mailboxByRole(role: MailboxRole): Promise<MailboxInfo | undefined> {
    const boxes = this.mailboxCache ?? (await this.listMailboxes());
    return boxes.find((m) => m.role === role);
  }

  async listMessages(
    mailboxId: string,
    opts: { limit: number; offset: number; query?: string }
  ): Promise<MessagePage> {
    const path = decodePath(mailboxId);
    return this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const mailbox = client.mailbox;
        const exists = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0;

        let uids: number[];
        let total: number;
        if (opts.query) {
          const q = opts.query;
          let found: number[] | false = false;
          try {
            found = await client.search(
              { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] },
              { uid: true }
            );
          } catch {
            found = false;
          }
          const all = (found || []).sort((a, b) => b - a);
          total = all.length;
          uids = all.slice(opts.offset, opts.offset + opts.limit);
        } else {
          total = exists;
          if (exists === 0) return { total: 0, messages: [] };
          // Newest messages have the highest sequence numbers.
          const end = exists - opts.offset;
          if (end < 1) return { total, messages: [] };
          const start = Math.max(1, end - opts.limit + 1);
          const summaries = await this.fetchSummaries(client, `${start}:${end}`, false, mailboxId);
          summaries.sort((a, b) => (a.date < b.date ? 1 : -1));
          return { total, messages: summaries };
        }

        if (uids.length === 0) return { total, messages: [] };
        const summaries = await this.fetchSummaries(client, uids.join(','), true, mailboxId);
        summaries.sort((a, b) => (a.date < b.date ? 1 : -1));
        return { total, messages: summaries };
      } finally {
        lock.release();
      }
    });
  }

  private async fetchSummaries(
    client: ImapFlow,
    range: string,
    byUid: boolean,
    mailboxId: string
  ): Promise<MessageSummary[]> {
    const summaries: MessageSummary[] = [];
    for await (const msg of client.fetch(
      range,
      { uid: true, envelope: true, flags: true, bodyStructure: true, size: true },
      { uid: byUid }
    )) {
      const flags: Set<string> = (msg.flags as Set<string>) ?? new Set();
      const envelope = msg.envelope;
      summaries.push({
        id: String(msg.uid),
        mailboxId,
        from: mapEnvelopeAddresses(envelope?.from),
        to: mapEnvelopeAddresses(envelope?.to),
        subject: envelope?.subject ?? '',
        preview: '',
        date: (envelope?.date ?? new Date(0)).toISOString(),
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        draft: flags.has('\\Draft'),
        hasAttachment: structureHasAttachment(msg.bodyStructure),
        size: msg.size ?? 0,
      });
    }
    return summaries;
  }

  private async fetchParsed(client: ImapFlow, path: string, uid: number): Promise<ParsedMail> {
    const lock = await client.getMailboxLock(path);
    try {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg || !msg.source) {
        throw new ApiError(404, 'Message not found');
      }
      return simpleParser(msg.source);
    } finally {
      lock.release();
    }
  }

  async getMessage(mailboxId: string, messageId: string): Promise<MessageDetail> {
    const path = decodePath(mailboxId);
    const uid = Number(messageId);
    return this.run(async (client) => {
      // Fetch flags alongside the raw source.
      const lock = await client.getMailboxLock(path);
      let source: Buffer;
      let flags: Set<string>;
      try {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, flags: true, size: true },
          { uid: true }
        );
        if (!msg || !msg.source) {
          throw new ApiError(404, 'Message not found');
        }
        source = msg.source;
        flags = (msg.flags as Set<string>) ?? new Set();
      } finally {
        lock.release();
      }
      const parsed = await simpleParser(source);

      const attachments = (parsed.attachments ?? []).map((att, index) => ({
        id: String(index),
        name: att.filename ?? 'attachment',
        type: att.contentType ?? 'application/octet-stream',
        size: att.size ?? att.content?.length ?? 0,
        cid: att.cid ?? undefined,
        inline: att.contentDisposition === 'inline' && Boolean(att.cid),
      }));

      let html = typeof parsed.html === 'string' ? parsed.html : undefined;
      const text = parsed.text ?? undefined;
      // Embed inline cid images as data URIs (bounded to keep payloads sane).
      if (html) {
        for (let i = 0; i < attachments.length; i++) {
          const meta = attachments[i];
          const raw = parsed.attachments[i];
          if (meta.cid && html.includes(`cid:${meta.cid}`) && raw.content && raw.content.length <= 2 * 1024 * 1024) {
            const dataUri = `data:${meta.type};base64,${raw.content.toString('base64')}`;
            html = html.split(`cid:${meta.cid}`).join(dataUri);
          }
        }
      }

      return {
        id: messageId,
        mailboxId,
        from: mapParsedAddresses(parsed.from),
        to: mapParsedAddresses(parsed.to),
        cc: mapParsedAddresses(parsed.cc),
        bcc: mapParsedAddresses(parsed.bcc),
        replyTo: mapParsedAddresses(parsed.replyTo),
        messageIdHeader: parsed.messageId ?? undefined,
        subject: parsed.subject ?? '',
        preview: (parsed.text ?? '').slice(0, 160),
        date: (parsed.date ?? new Date(0)).toISOString(),
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        draft: flags.has('\\Draft'),
        hasAttachment: attachments.some((a) => !a.inline),
        size: source.length,
        html,
        text,
        attachments,
      };
    });
  }

  async setFlags(
    mailboxId: string,
    messageIds: string[],
    flags: { seen?: boolean; flagged?: boolean }
  ): Promise<void> {
    const path = decodePath(mailboxId);
    const range = messageIds.join(',');
    await this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        const add: string[] = [];
        const remove: string[] = [];
        if (flags.seen !== undefined) (flags.seen ? add : remove).push('\\Seen');
        if (flags.flagged !== undefined) (flags.flagged ? add : remove).push('\\Flagged');
        if (add.length > 0) await client.messageFlagsAdd(range, add, { uid: true });
        if (remove.length > 0) await client.messageFlagsRemove(range, remove, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async move(mailboxId: string, messageIds: string[], targetMailboxId: string): Promise<void> {
    const path = decodePath(mailboxId);
    const targetPath = decodePath(targetMailboxId);
    await this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        await client.messageMove(messageIds.join(','), targetPath, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async delete(mailboxId: string, messageIds: string[]): Promise<void> {
    const trash = await this.mailboxByRole('trash');
    if (trash && trash.id !== mailboxId) {
      await this.move(mailboxId, messageIds, trash.id);
      return;
    }
    const path = decodePath(mailboxId);
    await this.run(async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        await client.messageDelete(messageIds.join(','), { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async send(message: OutgoingMessage): Promise<void> {
    const { smtp } = this.config;
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.username, pass: smtp.password },
      });
    }
    const mailOptions = {
      from: { name: this.config.name, address: this.config.email },
      to: message.to.map((a) => ({ name: a.name ?? '', address: a.email })),
      cc: message.cc.map((a) => ({ name: a.name ?? '', address: a.email })),
      bcc: message.bcc.map((a) => ({ name: a.name ?? '', address: a.email })),
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyTo,
      references: message.inReplyTo,
    };
    // Build the raw message once so the copy appended to Sent matches exactly
    // what went out over SMTP.
    const composer = new MailComposer(mailOptions);
    const raw: Buffer = await new Promise((resolve, reject) => {
      composer.compile().build((err, buffer) => (err ? reject(err) : resolve(buffer)));
    });
    const envelopeTo = [...message.to, ...message.cc, ...message.bcc].map((a) => a.email);
    try {
      await this.transporter.sendMail({
        envelope: { from: this.config.email, to: envelopeTo },
        raw,
      });
    } catch (err) {
      throw new ApiError(502, `SMTP send failed: ${(err as Error).message}`);
    }
    // Best effort: store a copy in the Sent mailbox.
    const sent = await this.mailboxByRole('sent');
    if (sent) {
      try {
        await this.run(async (client) => {
          await client.append(decodePath(sent.id), raw, ['\\Seen']);
        });
      } catch {
        // Message was sent; failing to save the copy is not fatal.
      }
    }
  }

  async getAttachment(
    mailboxId: string,
    messageId: string,
    attachmentId: string
  ): Promise<AttachmentContent> {
    const path = decodePath(mailboxId);
    const uid = Number(messageId);
    return this.run(async (client) => {
      const parsed = await this.fetchParsed(client, path, uid);
      const index = Number(attachmentId);
      const att = (parsed.attachments ?? [])[index];
      if (!att || !att.content) {
        throw new ApiError(404, 'Attachment not found');
      }
      return {
        name: att.filename ?? 'attachment',
        type: att.contentType ?? 'application/octet-stream',
        content: att.content,
      };
    });
  }

  toAccountInfo(id: string): AccountInfo {
    return {
      id,
      kind: 'imap',
      name: this.config.name || this.config.email,
      email: this.config.email,
      primary: false,
    };
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* already disconnected */
      }
      this.client = null;
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}
