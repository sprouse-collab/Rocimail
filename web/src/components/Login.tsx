import { useState, type FormEvent } from 'react';
import { api, setToken } from '../api';
import type { AccountInfo } from '../types';

interface Props {
  onLogin: (account: AccountInfo) => void;
}

export default function Login({ onLogin }: Props) {
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token, account } = await api.login(server, email, password);
      setToken(token);
      onLogin(account);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <span className="logo-mark">R</span>
          <span className="logo-text">Rocimail</span>
        </div>
        <p className="login-subtitle">Sign in to your JMAP mail server</p>
        <label>
          Server URL
          <input
            type="url"
            placeholder="https://mail.example.com"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          Email address
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
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
        {error && <div className="form-error">{error}</div>}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="login-hint">
          Works with Stalwart and other JMAP servers. You can add IMAP accounts after signing in.
        </p>
      </form>
    </div>
  );
}
