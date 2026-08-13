import { useMemo, useState } from 'react';
import { api } from '../api';
import { requestNotificationPermission } from '../notify';
import type { Alarm, EmailAddress } from '../types';

export interface AlarmTarget {
  accountId: string;
  mailboxId: string;
  messageId: string;
  subject: string;
  from: EmailAddress[];
}

interface Props {
  target: AlarmTarget;
  existing: Alarm | null;
  onClose: () => void;
  onSaved: (alarm: Alarm) => void;
  onRemoved: (alarmId: string) => void;
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function buildPresets(): { label: string; date: Date }[] {
  const now = new Date();
  const inHours = (h: number) => new Date(now.getTime() + h * 3600_000);
  const at = (dayOffset: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const presets = [
    { label: 'In 1 hour', date: inHours(1) },
    { label: 'In 3 hours', date: inHours(3) },
    { label: 'This evening', date: at(0, 18) },
    { label: 'Tomorrow morning', date: at(1, 9) },
    { label: 'Next Monday', date: at(((8 - now.getDay()) % 7) || 7, 9) },
  ];
  return presets.filter((p) => p.date.getTime() > now.getTime() + 60_000);
}

export default function AlarmModal({ target, existing, onClose, onSaved, onRemoved }: Props) {
  const presets = useMemo(buildPresets, []);
  const [dueLocal, setDueLocal] = useState(() =>
    toLocalInputValue(existing ? new Date(existing.dueAt) : new Date(Date.now() + 3600_000))
  );
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const due = new Date(dueLocal);
    if (Number.isNaN(due.getTime())) {
      setError('Pick a valid date and time');
      return;
    }
    if (due.getTime() <= Date.now()) {
      setError('The alarm time must be in the future');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      requestNotificationPermission();
      const { alarm } = await api.createAlarm({
        accountId: target.accountId,
        mailboxId: target.mailboxId,
        messageId: target.messageId,
        dueAt: due.toISOString(),
        note: note.trim() || undefined,
        subject: target.subject,
        from: target.from,
      });
      onSaved(alarm);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAlarm(existing.id);
      onRemoved(existing.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal alarm-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-header">
          <h3>⏰ {existing ? 'Edit alarm' : 'Set alarm'}</h3>
          <button type="button" className="composer-header-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="modal-hint alarm-modal-subject" title={target.subject}>
          {target.subject || '(no subject)'}
        </p>
        <div className="alarm-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`alarm-preset ${dueLocal === toLocalInputValue(p.date) ? 'active' : ''}`}
              onClick={() => setDueLocal(toLocalInputValue(p.date))}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label>
          Ring at
          <input
            type="datetime-local"
            value={dueLocal}
            min={toLocalInputValue(new Date())}
            onChange={(e) => setDueLocal(e.target.value)}
            required
          />
        </label>
        <label>
          Note (optional)
          <input
            type="text"
            value={note}
            maxLength={200}
            placeholder="e.g. reply before the meeting"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <button type="submit" className="btn-primary" disabled={busy}>
            {existing ? 'Update alarm' : 'Set alarm'}
          </button>
          {existing && (
            <button type="button" className="btn-plain danger" onClick={() => void remove()} disabled={busy}>
              Remove alarm
            </button>
          )}
          <button type="button" className="btn-plain" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
