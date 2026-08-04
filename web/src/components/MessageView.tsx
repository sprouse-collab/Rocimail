import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { api, formatAddress } from '../api';
import type { MailboxInfo, MessageDetail } from '../types';

interface Props {
  accountId: string;
  message: MessageDetail | null;
  loading: boolean;
  mailboxes: MailboxInfo[];
  onReply: (mode: 'reply' | 'replyAll' | 'forward') => void;
  onDelete: () => void;
  onToggleSeen: () => void;
  onToggleFlag: () => void;
  onMove: (targetMailboxId: string) => void;
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default function MessageView({
  accountId,
  message,
  loading,
  mailboxes,
  onReply,
  onDelete,
  onToggleSeen,
  onToggleFlag,
  onMove,
}: Props) {
  const bodyDoc = useMemo(() => {
    if (!message) return '';
    const content = message.html
      ? DOMPurify.sanitize(message.html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] })
      : `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(message.text ?? '')}</pre>`;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 14px;
             color: #222; margin: 16px; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      a { color: #1a73e8; }
    </style></head><body>${content}</body></html>`;
  }, [message]);

  if (loading) {
    return (
      <section className="view-pane">
        <div className="pane-loading">Loading message…</div>
      </section>
    );
  }

  if (!message) {
    return (
      <section className="view-pane">
        <div className="view-placeholder">
          <div className="view-placeholder-icon">✉️</div>
          <p>Select a message to read it</p>
        </div>
      </section>
    );
  }

  const visibleAttachments = message.attachments.filter((a) => !a.inline);

  return (
    <section className="view-pane">
      <div className="view-toolbar">
        <button className="toolbar-btn" onClick={() => onReply('reply')}>
          ↩ Reply
        </button>
        <button className="toolbar-btn" onClick={() => onReply('replyAll')}>
          ↩↩ Reply all
        </button>
        <button className="toolbar-btn" onClick={() => onReply('forward')}>
          ➦ Forward
        </button>
        <span className="toolbar-sep" />
        <button className="toolbar-btn" onClick={onToggleSeen}>
          {message.seen ? 'Mark unread' : 'Mark read'}
        </button>
        <button className={`toolbar-btn ${message.flagged ? 'active' : ''}`} onClick={onToggleFlag}>
          🚩 {message.flagged ? 'Unflag' : 'Flag'}
        </button>
        <select
          className="move-select"
          value=""
          onChange={(e) => {
            if (e.target.value) onMove(e.target.value);
          }}
        >
          <option value="" disabled>
            Move to…
          </option>
          {mailboxes
            .filter((m) => m.id !== message.mailboxId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
        <button className="toolbar-btn danger" onClick={onDelete}>
          🗑 Delete
        </button>
      </div>
      <div className="view-header">
        <h2 className="view-subject">{message.subject || '(no subject)'}</h2>
        <div className="view-meta">
          <div className="view-avatar">
            {(message.from[0]?.name || message.from[0]?.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className="view-meta-lines">
            <div className="view-from">
              {message.from.map(formatAddress).join(', ') || '(unknown sender)'}
            </div>
            <div className="view-recipients">
              to {message.to.map(formatAddress).join(', ') || '(none)'}
              {message.cc.length > 0 && <> · cc {message.cc.map(formatAddress).join(', ')}</>}
            </div>
          </div>
          <div className="view-date">{formatFullDate(message.date)}</div>
        </div>
      </div>
      {visibleAttachments.length > 0 && (
        <div className="attachment-bar">
          {visibleAttachments.map((att) => (
            <button
              key={att.id}
              className="attachment-chip"
              title={`${att.name} (${formatSize(att.size)})`}
              onClick={() =>
                api
                  .downloadAttachment(accountId, message.mailboxId, message.id, att.id, att.name)
                  .catch((err) => alert((err as Error).message))
              }
            >
              📎 {att.name} <span className="attachment-size">{formatSize(att.size)}</span>
            </button>
          ))}
        </div>
      )}
      <iframe className="view-body" title="Message body" sandbox="" srcDoc={bodyDoc} />
    </section>
  );
}
