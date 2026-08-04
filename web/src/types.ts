// Mirrors the server-side data model (server/src/types.ts).

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
  date: string;
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

export interface AccountInfo {
  id: string;
  kind: 'jmap' | 'imap';
  name: string;
  email: string;
  primary: boolean;
}

export interface ComposerDraft {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}
