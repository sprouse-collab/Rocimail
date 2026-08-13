import { useEffect, useRef, useState } from 'react';
import { formatAddress } from '../api';
import type { Alarm } from '../types';

interface Props {
  alarms: Alarm[];
  dueIds: Set<string>;
  onOpen: (alarm: Alarm) => void;
  onSnooze: (alarm: Alarm, until: Date) => void;
  onDismiss: (alarm: Alarm) => void;
}

function formatDue(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function snoozeOptions(): { label: string; until: () => Date }[] {
  return [
    { label: '10 min', until: () => new Date(Date.now() + 10 * 60_000) },
    { label: '1 hour', until: () => new Date(Date.now() + 3600_000) },
    {
      label: 'Tomorrow',
      until: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d;
      },
    },
  ];
}

export default function AlarmBell({ alarms, dueIds, onOpen, onSnooze, onDismiss }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dueCount = dueIds.size;

  // Pop the panel open when an alarm starts ringing.
  const prevDueCount = useRef(0);
  useEffect(() => {
    if (dueCount > prevDueCount.current) setOpen(true);
    prevDueCount.current = dueCount;
  }, [dueCount]);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);

  const due = alarms.filter((a) => dueIds.has(a.id));
  const upcoming = alarms.filter((a) => !dueIds.has(a.id));

  const renderAlarm = (alarm: Alarm, ringing: boolean) => (
    <li key={alarm.id} className={`alarm-item ${ringing ? 'ringing' : ''}`}>
      <button className="alarm-item-main" onClick={() => onOpen(alarm)} title="Open message">
        <span className="alarm-item-subject">{alarm.subject || '(no subject)'}</span>
        <span className="alarm-item-meta">
          {alarm.from.map(formatAddress).join(', ') || '(unknown sender)'}
        </span>
        {alarm.note && <span className="alarm-item-note">📝 {alarm.note}</span>}
        <span className={`alarm-item-due ${ringing ? 'overdue' : ''}`}>
          {ringing ? `Rang at ${formatDue(alarm.dueAt)}` : `Rings ${formatDue(alarm.dueAt)}`}
        </span>
      </button>
      <div className="alarm-item-actions">
        {snoozeOptions().map((opt) => (
          <button
            key={opt.label}
            className="alarm-action"
            title={`Snooze ${opt.label}`}
            onClick={() => onSnooze(alarm, opt.until())}
          >
            {opt.label}
          </button>
        ))}
        <button className="alarm-action dismiss" title="Dismiss alarm" onClick={() => onDismiss(alarm)}>
          ✕
        </button>
      </div>
    </li>
  );

  return (
    <div className="alarm-bell" ref={rootRef}>
      <button
        className={`icon-btn alarm-bell-btn ${dueCount > 0 ? 'ringing' : ''}`}
        title={dueCount > 0 ? `${dueCount} alarm${dueCount > 1 ? 's' : ''} ringing` : 'Alarms'}
        onClick={() => setOpen((v) => !v)}
      >
        🔔
        {alarms.length > 0 && (
          <span className={`alarm-badge ${dueCount > 0 ? 'due' : ''}`}>
            {dueCount > 0 ? dueCount : alarms.length}
          </span>
        )}
      </button>
      {open && (
        <div className="alarm-dropdown">
          <div className="alarm-dropdown-header">Alarms</div>
          {alarms.length === 0 && (
            <div className="alarm-empty">
              No alarms set. Open a message and use ⏰ Remind me.
            </div>
          )}
          {due.length > 0 && (
            <>
              <div className="alarm-section">Ringing</div>
              <ul className="alarm-list">{due.map((a) => renderAlarm(a, true))}</ul>
            </>
          )}
          {upcoming.length > 0 && (
            <>
              <div className="alarm-section">Upcoming</div>
              <ul className="alarm-list">{upcoming.map((a) => renderAlarm(a, false))}</ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
