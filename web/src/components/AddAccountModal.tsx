import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AccountInfo } from '../types';

interface Props {
  onClose: () => void;
  onAdded: (account: AccountInfo) => void;
}

export default function AddAccountModal({ onClose, onAdded }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapSecure, setImapSecure] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpSameCreds, setSmtpSameCreds] = useState(true);
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { account } = await api.addImapAccount({
        name: name || email,
        email,
        imap: {
          host: imapHost,
          port: Number(imapPort),
          secure: imapSecure,
          username: username || email,
          password,
        },
        smtp: {
          host: smtpHost || imapHost,
          port: Number(smtpPort),
          secure: smtpSecure,
          username: smtpSameCreds ? username || email : smtpUsername,
          password: smtpSameCreds ? password : smtpPassword,
        },
      });
      onAdded(account);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-header">
          <h3>Add IMAP account</h3>
          <button type="button" className="composer-header-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="modal-hint">
          Connect a secondary mailbox over IMAP (reading) and SMTP (sending).
        </p>
        <div className="modal-grid">
          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work mail" />
          </label>
          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@company.com"
            />
          </label>
        </div>
        <h4 className="modal-section">IMAP (incoming)</h4>
        <div className="modal-grid">
          <label>
            Host
            <input
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              required
              placeholder="imap.company.com"
            />
          </label>
          <label>
            Port
            <input value={imapPort} onChange={(e) => setImapPort(e.target.value)} required />
          </label>
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="defaults to email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        </div>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={imapSecure}
            onChange={(e) => {
              setImapSecure(e.target.checked);
              setImapPort(e.target.checked ? '993' : '143');
            }}
          />
          Use TLS (recommended)
        </label>
        <h4 className="modal-section">SMTP (outgoing)</h4>
        <div className="modal-grid">
          <label>
            Host
            <input
              value={smtpHost}
              onChange={(e) => setSmtpHost(e.target.value)}
              placeholder="defaults to IMAP host"
            />
          </label>
          <label>
            Port
            <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} required />
          </label>
        </div>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={smtpSecure}
            onChange={(e) => {
              setSmtpSecure(e.target.checked);
              setSmtpPort(e.target.checked ? '465' : '587');
            }}
          />
          Implicit TLS (port 465) — uncheck for STARTTLS (587)
        </label>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={smtpSameCreds}
            onChange={(e) => setSmtpSameCreds(e.target.checked)}
          />
          SMTP uses the same credentials as IMAP
        </label>
        {!smtpSameCreds && (
          <div className="modal-grid">
            <label>
              SMTP username
              <input value={smtpUsername} onChange={(e) => setSmtpUsername(e.target.value)} />
            </label>
            <label>
              SMTP password
              <input
                type="password"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
              />
            </label>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Verifying…' : 'Add account'}
          </button>
          <button type="button" className="btn-plain" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
