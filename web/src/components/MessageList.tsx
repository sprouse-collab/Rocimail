import type { MessagePage, MessageSummary } from '../types';

interface Props {
  page: MessagePage | null;
  loading: boolean;
  error: string | null;
  selectedMessageId: string | null;
  mailboxName: string;
  searchActive: boolean;
  offset: number;
  limit: number;
  onSelect: (message: MessageSummary) => void;
  onPage: (offset: number) => void;
  onRefresh: () => void;
  onToggleFlag: (message: MessageSummary) => void;
  onDelete: (message: MessageSummary) => void;
}

function senderLabel(msg: MessageSummary): string {
  const first = msg.from[0];
  if (!first) return '(unknown sender)';
  return first.name || first.email;
}

export function formatListDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export default function MessageList({
  page,
  loading,
  error,
  selectedMessageId,
  mailboxName,
  searchActive,
  offset,
  limit,
  onSelect,
  onPage,
  onRefresh,
  onToggleFlag,
  onDelete,
}: Props) {
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <section className="list-pane">
      <div className="list-header">
        <div className="list-title">
          {searchActive ? 'Search results' : mailboxName}
          <span className="list-count">{total > 0 ? ` · ${total}` : ''}</span>
        </div>
        <div className="list-actions">
          <button className="icon-btn" title="Refresh" onClick={onRefresh}>
            ⟳
          </button>
          <button
            className="icon-btn"
            title="Previous page"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            ‹
          </button>
          <span className="page-info">
            {from}–{to}
          </span>
          <button
            className="icon-btn"
            title="Next page"
            disabled={offset + limit >= total}
            onClick={() => onPage(offset + limit)}
          >
            ›
          </button>
        </div>
      </div>
      {error && <div className="pane-error">{error}</div>}
      {loading && <div className="pane-loading">Loading…</div>}
      {!loading && !error && page && page.messages.length === 0 && (
        <div className="pane-empty">
          {searchActive ? 'No messages match your search.' : 'This folder is empty.'}
        </div>
      )}
      <ul className="message-list">
        {(page?.messages ?? []).map((msg) => (
          <li
            key={msg.id}
            className={`message-row ${msg.seen ? '' : 'unread'} ${
              msg.id === selectedMessageId ? 'selected' : ''
            }`}
            onClick={() => onSelect(msg)}
          >
            <div className="message-row-top">
              <span className="message-sender">{senderLabel(msg)}</span>
              <span className="message-date">{formatListDate(msg.date)}</span>
            </div>
            <div className="message-row-bottom">
              <span className="message-subject">{msg.subject || '(no subject)'}</span>
              {msg.preview && <span className="message-preview"> — {msg.preview}</span>}
            </div>
            <div className="message-row-meta">
              {msg.hasAttachment && <span title="Has attachment">📎</span>}
              {msg.answered && <span title="Replied">↩</span>}
              <button
                className={`row-action flag ${msg.flagged ? 'on' : ''}`}
                title={msg.flagged ? 'Remove flag' : 'Flag'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFlag(msg);
                }}
              >
                🚩
              </button>
              <button
                className="row-action"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(msg);
                }}
              >
                🗑️
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
