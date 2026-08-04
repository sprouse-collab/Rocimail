import { useState } from 'react';
import { api, parseAddressInput } from '../api';
import type { AccountInfo, ComposerDraft } from '../types';

interface Props {
  draft: ComposerDraft;
  accounts: AccountInfo[];
  onClose: () => void;
  onSent: (accountId: string) => void;
}

export default function Composer({ draft, accounts, onClose, onSent }: Props) {
  const [accountId, setAccountId] = useState(draft.accountId);
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [bcc, setBcc] = useState(draft.bcc);
  const [showCcBcc, setShowCcBcc] = useState(Boolean(draft.cc || draft.bcc));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const send = async () => {
    const toList = parseAddressInput(to);
    if (toList.length === 0) {
      setError('Add at least one valid recipient');
      return;
    }
    setError(null);
    setSending(true);
    try {
      await api.send(accountId, {
        to: toList,
        cc: parseAddressInput(cc),
        bcc: parseAddressInput(bcc),
        subject,
        text: body,
        inReplyTo: draft.inReplyTo,
      });
      onSent(accountId);
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  };

  return (
    <div className={`composer ${minimized ? 'minimized' : ''}`}>
      <div className="composer-header" onDoubleClick={() => setMinimized((m) => !m)}>
        <span className="composer-title">{subject || 'New Mail'}</span>
        <div className="composer-header-actions">
          <button
            className="composer-header-btn"
            title={minimized ? 'Expand' : 'Minimize'}
            onClick={() => setMinimized((m) => !m)}
          >
            {minimized ? '▲' : '▼'}
          </button>
          <button className="composer-header-btn" title="Discard" onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      {!minimized && (
        <div className="composer-body">
          <div className="composer-field">
            <label>From</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} &lt;{a.email}&gt; {a.kind === 'imap' ? '(IMAP)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="composer-field">
            <label>To</label>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com, another@example.com"
              autoFocus={!draft.to}
            />
            {!showCcBcc && (
              <button className="link-btn" onClick={() => setShowCcBcc(true)}>
                Cc/Bcc
              </button>
            )}
          </div>
          {showCcBcc && (
            <>
              <div className="composer-field">
                <label>Cc</label>
                <input value={cc} onChange={(e) => setCc(e.target.value)} />
              </div>
              <div className="composer-field">
                <label>Bcc</label>
                <input value={bcc} onChange={(e) => setBcc(e.target.value)} />
              </div>
            </>
          )}
          <div className="composer-field">
            <label>Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <textarea
            className="composer-text"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
            autoFocus={Boolean(draft.to)}
          />
          {error && <div className="form-error">{error}</div>}
          <div className="composer-footer">
            <button className="btn-primary" onClick={send} disabled={sending}>
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button className="btn-plain" onClick={onClose} disabled={sending}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
