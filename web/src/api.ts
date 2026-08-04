import type {
  AccountInfo,
  EmailAddress,
  MailboxInfo,
  MessageDetail,
  MessagePage,
} from './types';

const TOKEN_KEY = 'rocimail_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, { ...options, headers });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    setToken(null);
    onUnauthorized?.();
    throw new ApiError(401, 'Session expired — please sign in again');
  }
  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  login(server: string, email: string, password: string) {
    return request<{ token: string; account: AccountInfo }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ server, email, password }),
    });
  },
  logout() {
    return request<{ ok: boolean }>('/auth/logout', { method: 'POST' });
  },
  listAccounts() {
    return request<{ accounts: AccountInfo[] }>('/accounts');
  },
  addImapAccount(payload: {
    name: string;
    email: string;
    imap: { host: string; port: number; secure: boolean; username: string; password: string };
    smtp: { host: string; port: number; secure: boolean; username: string; password: string };
  }) {
    return request<{ account: AccountInfo }>('/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  removeAccount(accountId: string) {
    return request<{ ok: boolean }>(`/accounts/${accountId}`, { method: 'DELETE' });
  },
  listMailboxes(accountId: string) {
    return request<{ mailboxes: MailboxInfo[] }>(`/accounts/${accountId}/mailboxes`);
  },
  listMessages(
    accountId: string,
    mailboxId: string,
    opts: { limit?: number; offset?: number; q?: string } = {}
  ) {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.q) params.set('q', opts.q);
    const qs = params.toString();
    return request<MessagePage>(
      `/accounts/${accountId}/mailboxes/${encodeURIComponent(mailboxId)}/messages${qs ? `?${qs}` : ''}`
    );
  },
  getMessage(accountId: string, mailboxId: string, messageId: string) {
    return request<{ message: MessageDetail }>(
      `/accounts/${accountId}/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`
    );
  },
  setFlags(
    accountId: string,
    mailboxId: string,
    ids: string[],
    flags: { seen?: boolean; flagged?: boolean }
  ) {
    return request<{ ok: boolean }>(
      `/accounts/${accountId}/mailboxes/${encodeURIComponent(mailboxId)}/messages/flags`,
      { method: 'POST', body: JSON.stringify({ ids, ...flags }) }
    );
  },
  moveMessages(accountId: string, mailboxId: string, ids: string[], targetMailboxId: string) {
    return request<{ ok: boolean }>(
      `/accounts/${accountId}/mailboxes/${encodeURIComponent(mailboxId)}/messages/move`,
      { method: 'POST', body: JSON.stringify({ ids, targetMailboxId }) }
    );
  },
  deleteMessages(accountId: string, mailboxId: string, ids: string[]) {
    return request<{ ok: boolean }>(
      `/accounts/${accountId}/mailboxes/${encodeURIComponent(mailboxId)}/messages/delete`,
      { method: 'POST', body: JSON.stringify({ ids }) }
    );
  },
  send(
    accountId: string,
    payload: {
      to: EmailAddress[];
      cc: EmailAddress[];
      bcc: EmailAddress[];
      subject: string;
      text: string;
      html?: string;
      inReplyTo?: string;
    }
  ) {
    return request<{ ok: boolean }>(`/accounts/${accountId}/send`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  attachmentUrl(accountId: string, mailboxId: string, messageId: string, attachmentId: string, name: string) {
    return `/api/accounts/${accountId}/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(
      messageId
    )}/attachments/${encodeURIComponent(attachmentId)}?name=${encodeURIComponent(name)}`;
  },
  async downloadAttachment(
    accountId: string,
    mailboxId: string,
    messageId: string,
    attachmentId: string,
    name: string
  ): Promise<void> {
    const token = getToken();
    const res = await fetch(this.attachmentUrl(accountId, mailboxId, messageId, attachmentId, name), {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, 'Attachment download failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export function parseAddressInput(value: string): EmailAddress[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const match = part.match(/^(.*)<([^<>@\s]+@[^<>\s]+)>$/);
      if (match) {
        const name = match[1].trim().replace(/^"|"$/g, '');
        return { name: name || undefined, email: match[2] };
      }
      return { email: part };
    })
    .filter((a) => a.email.includes('@'));
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}
