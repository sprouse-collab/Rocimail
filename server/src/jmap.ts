// JMAP mail provider (RFC 8620 / RFC 8621), built for Stalwart but works with
// any spec-compliant JMAP server. Uses HTTP Basic authentication.

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

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_MAIL = 'urn:ietf:params:jmap:mail';
const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  username: string;
  accounts: Record<string, { name: string; isPersonal?: boolean }>;
  primaryAccounts: Record<string, string>;
}

type MethodCall = [string, Record<string, unknown>, string];

const SUMMARY_PROPERTIES = [
  'id',
  'threadId',
  'mailboxIds',
  'keywords',
  'from',
  'to',
  'subject',
  'receivedAt',
  'preview',
  'hasAttachment',
  'size',
];

const DETAIL_PROPERTIES = [
  ...SUMMARY_PROPERTIES,
  'cc',
  'bcc',
  'replyTo',
  'messageId',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
];

interface JmapEmailAddress {
  name?: string | null;
  email: string;
}

interface JmapBodyPart {
  partId?: string | null;
  blobId?: string | null;
  name?: string | null;
  type?: string | null;
  size?: number;
  cid?: string | null;
  disposition?: string | null;
}

interface JmapEmail {
  id: string;
  threadId?: string;
  mailboxIds: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  from?: JmapEmailAddress[] | null;
  to?: JmapEmailAddress[] | null;
  cc?: JmapEmailAddress[] | null;
  bcc?: JmapEmailAddress[] | null;
  replyTo?: JmapEmailAddress[] | null;
  messageId?: string[] | null;
  subject?: string | null;
  receivedAt?: string;
  preview?: string;
  hasAttachment?: boolean;
  size?: number;
  bodyValues?: Record<string, { value: string; isTruncated?: boolean }>;
  textBody?: JmapBodyPart[];
  htmlBody?: JmapBodyPart[];
  attachments?: JmapBodyPart[];
}

function mapAddresses(list?: JmapEmailAddress[] | null): EmailAddress[] {
  if (!list) return [];
  return list
    .filter((a) => a && a.email)
    .map((a) => ({ name: a.name ?? undefined, email: a.email }));
}

function toSummary(email: JmapEmail, mailboxId: string): MessageSummary {
  const keywords = email.keywords ?? {};
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxId,
    from: mapAddresses(email.from),
    to: mapAddresses(email.to),
    subject: email.subject ?? '',
    preview: email.preview ?? '',
    date: email.receivedAt ?? new Date(0).toISOString(),
    seen: Boolean(keywords['$seen']),
    flagged: Boolean(keywords['$flagged']),
    answered: Boolean(keywords['$answered']),
    draft: Boolean(keywords['$draft']),
    hasAttachment: Boolean(email.hasAttachment),
    size: email.size ?? 0,
  };
}

export class JmapProvider implements MailProvider {
  readonly kind = 'jmap' as const;

  private mailboxCache: MailboxInfo[] | null = null;

  private constructor(
    private session: JmapSession,
    private authHeader: string,
    private accountId: string,
    public readonly userEmail: string
  ) {}

  /** Discovers the JMAP session (RFC 8620 §2) and validates credentials. */
  static async connect(serverUrl: string, username: string, password: string): Promise<JmapProvider> {
    const base = serverUrl.replace(/\/+$/, '');
    const sessionUrl = /\/\.well-known\/jmap$|\/jmap\/session$/.test(base)
      ? base
      : `${base}/.well-known/jmap`;
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(sessionUrl, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
        redirect: 'follow',
      });
    } catch (err) {
      throw new ApiError(502, `Could not reach JMAP server at ${sessionUrl}: ${(err as Error).message}`);
    }
    if (res.status === 401) {
      throw new ApiError(401, 'Invalid email address or password');
    }
    if (!res.ok) {
      throw new ApiError(502, `JMAP session discovery failed (HTTP ${res.status})`);
    }
    const session = (await res.json()) as JmapSession;
    if (!session.apiUrl || !session.primaryAccounts) {
      throw new ApiError(502, 'Server did not return a valid JMAP session object');
    }
    const accountId = session.primaryAccounts[JMAP_MAIL] ?? Object.keys(session.accounts ?? {})[0];
    if (!accountId) {
      throw new ApiError(502, 'No JMAP mail account available for this user');
    }
    // Resolve relative URLs against the session URL origin.
    const origin = new URL(sessionUrl);
    session.apiUrl = new URL(session.apiUrl, origin).toString();
    session.downloadUrl = new URL(session.downloadUrl, origin).toString();
    session.uploadUrl = new URL(session.uploadUrl, origin).toString();
    return new JmapProvider(session, authHeader, accountId, session.username || username);
  }

  private async request(methodCalls: MethodCall[]): Promise<[string, any, string][]> {
    const res = await fetch(this.session.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        using: [JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION],
        methodCalls,
      }),
    });
    if (res.status === 401) {
      throw new ApiError(401, 'JMAP session is no longer authorized');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(502, `JMAP request failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { methodResponses: [string, any, string][] };
    for (const [name, args] of data.methodResponses) {
      if (name === 'error') {
        throw new ApiError(502, `JMAP method error: ${args.type}${args.description ? ` — ${args.description}` : ''}`);
      }
    }
    return data.methodResponses;
  }

  private findResponse(responses: [string, any, string][], name: string, callId?: string): any {
    const match = responses.find(
      ([n, , id]) => n === name && (callId === undefined || id === callId)
    );
    if (!match) {
      throw new ApiError(502, `JMAP response missing expected ${name}`);
    }
    return match[1];
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const responses = await this.request([
      ['Mailbox/get', { accountId: this.accountId, ids: null }, 'm0'],
    ]);
    const { list } = this.findResponse(responses, 'Mailbox/get') as {
      list: Array<{
        id: string;
        name: string;
        parentId: string | null;
        role: string | null;
        totalEmails?: number;
        unreadEmails?: number;
        sortOrder?: number;
      }>;
    };
    const mailboxes = list.map((m) => ({
      id: m.id,
      name: m.name,
      parentId: m.parentId ?? null,
      role: (m.role as MailboxRole | null) ?? null,
      totalMessages: m.totalEmails ?? 0,
      unreadMessages: m.unreadEmails ?? 0,
      sortOrder: m.sortOrder ?? 0,
    }));
    this.mailboxCache = mailboxes;
    return mailboxes;
  }

  private async mailboxes(): Promise<MailboxInfo[]> {
    return this.mailboxCache ?? (await this.listMailboxes());
  }

  private async mailboxByRole(role: MailboxRole): Promise<MailboxInfo | undefined> {
    return (await this.mailboxes()).find((m) => m.role === role);
  }

  async listMessages(
    mailboxId: string,
    opts: { limit: number; offset: number; query?: string }
  ): Promise<MessagePage> {
    const filter = opts.query
      ? { operator: 'AND', conditions: [{ inMailbox: mailboxId }, { text: opts.query }] }
      : { inMailbox: mailboxId };
    const responses = await this.request([
      [
        'Email/query',
        {
          accountId: this.accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position: opts.offset,
          limit: opts.limit,
          calculateTotal: true,
        },
        'q0',
      ],
      [
        'Email/get',
        {
          accountId: this.accountId,
          '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
          properties: SUMMARY_PROPERTIES,
        },
        'g0',
      ],
    ]);
    const query = this.findResponse(responses, 'Email/query');
    const got = this.findResponse(responses, 'Email/get') as { list: JmapEmail[] };
    // Preserve query order (Email/get does not guarantee it).
    const byId = new Map(got.list.map((e) => [e.id, e]));
    const messages = (query.ids as string[])
      .map((id) => byId.get(id))
      .filter((e): e is JmapEmail => Boolean(e))
      .map((e) => toSummary(e, mailboxId));
    return { total: query.total ?? messages.length, messages };
  }

  async getMessage(mailboxId: string, messageId: string): Promise<MessageDetail> {
    const responses = await this.request([
      [
        'Email/get',
        {
          accountId: this.accountId,
          ids: [messageId],
          properties: DETAIL_PROPERTIES,
          fetchAllBodyValues: true,
          maxBodyValueBytes: 1024 * 1024,
        },
        'g0',
      ],
    ]);
    const { list } = this.findResponse(responses, 'Email/get') as { list: JmapEmail[] };
    const email = list[0];
    if (!email) {
      throw new ApiError(404, 'Message not found');
    }
    const bodyValues = email.bodyValues ?? {};
    const joinParts = (parts?: JmapBodyPart[]): string | undefined => {
      if (!parts || parts.length === 0) return undefined;
      const chunks = parts
        .filter((p) => p.partId && bodyValues[p.partId])
        .map((p) => bodyValues[p.partId!].value);
      return chunks.length > 0 ? chunks.join('\n') : undefined;
    };
    let html = joinParts(email.htmlBody);
    const text = joinParts(email.textBody);

    const attachments = (email.attachments ?? [])
      .filter((a) => a.blobId)
      .map((a) => ({
        id: a.blobId!,
        name: a.name ?? 'attachment',
        type: a.type ?? 'application/octet-stream',
        size: a.size ?? 0,
        cid: a.cid ?? undefined,
        inline: (a.disposition ?? '').toLowerCase() === 'inline' && Boolean(a.cid),
      }));

    // Embed small inline images referenced by cid: as data URIs so they render
    // inside the sandboxed message iframe without needing authenticated URLs.
    if (html) {
      for (const att of attachments) {
        if (att.cid && html.includes(`cid:${att.cid}`) && att.size <= 2 * 1024 * 1024) {
          try {
            const blob = await this.downloadBlob(att.id, att.name, att.type);
            const dataUri = `data:${att.type};base64,${blob.content.toString('base64')}`;
            html = html.split(`cid:${att.cid}`).join(dataUri);
          } catch {
            // Leave the cid reference in place if the blob can't be fetched.
          }
        }
      }
    }

    return {
      ...toSummary(email, mailboxId),
      cc: mapAddresses(email.cc),
      bcc: mapAddresses(email.bcc),
      replyTo: mapAddresses(email.replyTo),
      messageIdHeader: email.messageId?.[0],
      html,
      text,
      attachments,
    };
  }

  async setFlags(
    _mailboxId: string,
    messageIds: string[],
    flags: { seen?: boolean; flagged?: boolean }
  ): Promise<void> {
    const patch: Record<string, boolean | null> = {};
    if (flags.seen !== undefined) patch['keywords/$seen'] = flags.seen ? true : null;
    if (flags.flagged !== undefined) patch['keywords/$flagged'] = flags.flagged ? true : null;
    const update: Record<string, unknown> = {};
    for (const id of messageIds) update[id] = patch;
    await this.request([
      ['Email/set', { accountId: this.accountId, update }, 's0'],
    ]);
  }

  async move(_mailboxId: string, messageIds: string[], targetMailboxId: string): Promise<void> {
    const update: Record<string, unknown> = {};
    for (const id of messageIds) {
      update[id] = { mailboxIds: { [targetMailboxId]: true } };
    }
    await this.request([
      ['Email/set', { accountId: this.accountId, update }, 's0'],
    ]);
  }

  async delete(mailboxId: string, messageIds: string[]): Promise<void> {
    const trash = await this.mailboxByRole('trash');
    if (trash && trash.id !== mailboxId) {
      await this.move(mailboxId, messageIds, trash.id);
    } else {
      await this.request([
        ['Email/set', { accountId: this.accountId, destroy: messageIds }, 's0'],
      ]);
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    // Pick the identity matching the account email, falling back to the first.
    const identityResponses = await this.request([
      ['Identity/get', { accountId: this.accountId, ids: null }, 'i0'],
    ]);
    const identities = this.findResponse(identityResponses, 'Identity/get') as {
      list: Array<{ id: string; email: string; name?: string }>;
    };
    const identity =
      identities.list.find((i) => i.email?.toLowerCase() === this.userEmail.toLowerCase()) ??
      identities.list[0];
    if (!identity) {
      throw new ApiError(502, 'No JMAP sending identity available');
    }

    const drafts = await this.mailboxByRole('drafts');
    const sent = await this.mailboxByRole('sent');
    const initialMailbox = drafts ?? sent ?? (await this.mailboxes())[0];
    if (!initialMailbox) {
      throw new ApiError(502, 'No mailbox available to store the outgoing message');
    }

    const bodyValues: Record<string, { value: string }> = {
      text: { value: message.text },
    };
    const bodyParts: Record<string, unknown> = {
      bodyValues,
      textBody: [{ partId: 'text', type: 'text/plain' }],
    };
    if (message.html) {
      bodyValues.html = { value: message.html };
      bodyParts.htmlBody = [{ partId: 'html', type: 'text/html' }];
    }

    const emailCreate: Record<string, unknown> = {
      mailboxIds: { [initialMailbox.id]: true },
      keywords: { $seen: true, $draft: true },
      from: [{ name: identity.name || undefined, email: identity.email }],
      to: message.to,
      cc: message.cc.length > 0 ? message.cc : undefined,
      bcc: message.bcc.length > 0 ? message.bcc : undefined,
      subject: message.subject,
      ...bodyParts,
    };
    if (message.inReplyTo) {
      emailCreate.inReplyTo = [message.inReplyTo];
      emailCreate.references = [message.inReplyTo];
    }

    const onSuccessUpdateEmail: Record<string, unknown> = {
      'keywords/$draft': null,
    };
    if (sent && sent.id !== initialMailbox.id) {
      onSuccessUpdateEmail[`mailboxIds/${initialMailbox.id}`] = null;
      onSuccessUpdateEmail[`mailboxIds/${sent.id}`] = true;
    }

    const responses = await this.request([
      ['Email/set', { accountId: this.accountId, create: { draft: emailCreate } }, 'e0'],
      [
        'EmailSubmission/set',
        {
          accountId: this.accountId,
          create: { sub: { emailId: '#draft', identityId: identity.id } },
          onSuccessUpdateEmail: { '#sub': onSuccessUpdateEmail },
        },
        'sub0',
      ],
    ]);
    const emailSet = this.findResponse(responses, 'Email/set', 'e0');
    if (!emailSet.created?.draft) {
      const detail = emailSet.notCreated?.draft;
      throw new ApiError(
        502,
        `Failed to create outgoing message${detail ? `: ${detail.type} ${detail.description ?? ''}` : ''}`
      );
    }
    const subSet = this.findResponse(responses, 'EmailSubmission/set', 'sub0');
    if (!subSet.created?.sub) {
      const detail = subSet.notCreated?.sub;
      throw new ApiError(
        502,
        `Message submission failed${detail ? `: ${detail.type} ${detail.description ?? ''}` : ''}`
      );
    }
  }

  async getAttachment(
    _mailboxId: string,
    _messageId: string,
    attachmentId: string
  ): Promise<AttachmentContent> {
    return this.downloadBlob(attachmentId);
  }

  async downloadBlob(blobId: string, name = 'attachment', type = 'application/octet-stream'): Promise<AttachmentContent> {
    const url = this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(this.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{name}', encodeURIComponent(name))
      .replace('{type}', encodeURIComponent(type));
    const res = await fetch(url, { headers: { Authorization: this.authHeader } });
    if (!res.ok) {
      throw new ApiError(res.status === 404 ? 404 : 502, `Attachment download failed (HTTP ${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? type;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { name, type: contentType, content: buffer };
  }

  toAccountInfo(id: string): AccountInfo {
    return { id, kind: 'jmap', name: this.userEmail, email: this.userEmail, primary: true };
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to tear down.
  }
}
