// Shared data model used by both the JMAP and IMAP providers and the REST API.

export interface EmailAddress {
  name?: string;
  email: string;
}

export type MailboxRole =
  | 'inbox'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'all'
  | 'flagged'
  | 'important';

export interface MailboxInfo {
  id: string;
  name: string;
  parentId: string | null;
  role: MailboxRole | null;
  totalMessages: number;
  unreadMessages: number;
  sortOrder: number;
}

export interface MessageSummary {
  id: string;
  threadId?: string;
  mailboxId: string;
  from: EmailAddress[];
  to: EmailAddress[];
  subject: string;
  preview: string;
  date: string; // ISO 8601
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachment: boolean;
  size: number;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  type: string;
  size: number;
  cid?: string;
  inline: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  messageIdHeader?: string;
  html?: string;
  text?: string;
  attachments: AttachmentInfo[];
}

export interface MessagePage {
  total: number;
  messages: MessageSummary[];
}

export interface OutgoingMessage {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string; // Message-ID header value of the message being replied to
}

export interface AccountInfo {
  id: string;
  kind: 'jmap' | 'imap';
  name: string;
  email: string;
  primary: boolean;
}

export interface AttachmentContent {
  name: string;
  type: string;
  content: Buffer;
}

/**
 * A reminder attached to a message. Alarms live in the session (like accounts):
 * the server stores and validates them, the client rings them when due.
 */
export interface Alarm {
  id: string;
  accountId: string;
  mailboxId: string;
  messageId: string;
  /** When the alarm should ring (ISO 8601). */
  dueAt: string;
  note?: string;
  /** Snapshot of the message so the alarm can be listed without refetching it. */
  subject: string;
  from: EmailAddress[];
  createdAt: string;
}

/** Common interface implemented by the JMAP (Stalwart) and IMAP providers. */
export interface MailProvider {
  readonly kind: 'jmap' | 'imap';
  listMailboxes(): Promise<MailboxInfo[]>;
  listMessages(
    mailboxId: string,
    opts: { limit: number; offset: number; query?: string }
  ): Promise<MessagePage>;
  getMessage(mailboxId: string, messageId: string): Promise<MessageDetail>;
  setFlags(
    mailboxId: string,
    messageIds: string[],
    flags: { seen?: boolean; flagged?: boolean }
  ): Promise<void>;
  move(mailboxId: string, messageIds: string[], targetMailboxId: string): Promise<void>;
  /** Moves to Trash when a trash mailbox exists (and the source isn't Trash); otherwise deletes permanently. */
  delete(mailboxId: string, messageIds: string[]): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  getAttachment(
    mailboxId: string,
    messageId: string,
    attachmentId: string
  ): Promise<AttachmentContent>;
  close(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
