import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatAddress, getToken, setToken, setUnauthorizedHandler } from './api';
import Login from './components/Login';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import MessageView from './components/MessageView';
import Composer from './components/Composer';
import AddAccountModal from './components/AddAccountModal';
import AlarmBell from './components/AlarmBell';
import AlarmModal, { type AlarmTarget } from './components/AlarmModal';
import { playChime, showBrowserNotification } from './notify';
import type {
  AccountInfo,
  Alarm,
  ComposerDraft,
  MailboxInfo,
  MessageDetail,
  MessagePage,
  MessageSummary,
} from './types';

const PAGE_SIZE = 50;
const REFRESH_INTERVAL_MS = 60_000;

export default function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [mailboxes, setMailboxes] = useState<Record<string, MailboxInfo[]>>({});
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(null);
  const [page, setPage] = useState<MessagePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<MessageDetail | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [alarmTarget, setAlarmTarget] = useState<AlarmTarget | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const selectionRef = useRef({ accountId: '', mailboxId: '', offset: 0, query: '' });
  const notifiedAlarmsRef = useRef(new Set<string>());

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthed(false);
      setAccounts([]);
    });
  }, []);

  const loadMailboxes = useCallback(async (accountId: string) => {
    try {
      const { mailboxes: list } = await api.listMailboxes(accountId);
      setMailboxes((prev) => ({ ...prev, [accountId]: list }));
      return list;
    } catch {
      return [];
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    const { accounts: list } = await api.listAccounts();
    setAccounts(list);
    const allBoxes = await Promise.all(list.map((a) => loadMailboxes(a.id)));
    return { list, allBoxes };
  }, [loadMailboxes]);

  const loadAlarms = useCallback(async () => {
    try {
      const { alarms: list } = await api.listAlarms();
      setAlarms(list);
    } catch {
      /* non-fatal: retried on the next refresh */
    }
  }, []);

  const loadMessages = useCallback(
    async (accountId: string, mailboxId: string, newOffset: number, query: string, silent = false) => {
      selectionRef.current = { accountId, mailboxId, offset: newOffset, query };
      if (!silent) {
        setListLoading(true);
        setListError(null);
      }
      try {
        const result = await api.listMessages(accountId, mailboxId, {
          limit: PAGE_SIZE,
          offset: newOffset,
          q: query || undefined,
        });
        const current = selectionRef.current;
        if (current.accountId === accountId && current.mailboxId === mailboxId) {
          setPage(result);
          setOffset(newOffset);
        }
      } catch (err) {
        if (!silent) setListError((err as Error).message);
      } finally {
        if (!silent) setListLoading(false);
      }
    },
    []
  );

  const selectMailbox = useCallback(
    (accountId: string, mailboxId: string) => {
      setSelectedAccountId(accountId);
      setSelectedMailboxId(mailboxId);
      setSelectedMessage(null);
      setSearchInput('');
      setActiveQuery('');
      setPage(null);
      void loadMessages(accountId, mailboxId, 0, '');
    },
    [loadMessages]
  );

  // Initial load after sign-in.
  useEffect(() => {
    if (!authed) return;
    void loadAlarms();
    (async () => {
      try {
        const { list, allBoxes } = await loadAccounts();
        const primary = list.find((a) => a.primary) ?? list[0];
        if (primary) {
          const boxes = allBoxes[list.indexOf(primary)] ?? [];
          const inbox = boxes.find((m) => m.role === 'inbox') ?? boxes[0];
          if (inbox) selectMailbox(primary.id, inbox.id);
        }
      } catch (err) {
        showToast((err as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  // Background refresh of counts and the current list.
  useEffect(() => {
    if (!authed) return;
    const timer = window.setInterval(() => {
      for (const account of accounts) void loadMailboxes(account.id);
      void loadAlarms();
      const { accountId, mailboxId, offset: o, query } = selectionRef.current;
      if (accountId && mailboxId) void loadMessages(accountId, mailboxId, o, query, true);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [authed, accounts, loadMailboxes, loadMessages, loadAlarms]);

  // ---- Alarm clock: tick so due alarms are detected close to on-time. ------
  useEffect(() => {
    if (!authed) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [authed]);

  useEffect(() => {
    const next = alarms
      .map((a) => Date.parse(a.dueAt))
      .filter((t) => t > nowTick)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.min(Math.max(next - Date.now(), 0) + 250, 60_000);
    const timer = window.setTimeout(() => setNowTick(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [alarms, nowTick]);

  const dueAlarmIds = useMemo(
    () => new Set(alarms.filter((a) => Date.parse(a.dueAt) <= nowTick).map((a) => a.id)),
    [alarms, nowTick]
  );

  // Ring alarms that just became due: chime + desktop notification + toast.
  useEffect(() => {
    const fresh = alarms.filter(
      (a) => dueAlarmIds.has(a.id) && !notifiedAlarmsRef.current.has(a.id)
    );
    if (fresh.length === 0) return;
    for (const alarm of fresh) {
      notifiedAlarmsRef.current.add(alarm.id);
      showBrowserNotification(
        '⏰ Rocimail alarm',
        `${alarm.subject || '(no subject)'}${alarm.note ? ` — ${alarm.note}` : ''}`
      );
    }
    playChime();
    showToast(`⏰ Alarm: ${fresh[0].subject || '(no subject)'}`);
  }, [alarms, dueAlarmIds, showToast]);

  const snoozeAlarm = useCallback(
    async (alarm: Alarm, until: Date) => {
      try {
        const { alarm: updated } = await api.updateAlarm(alarm.id, { dueAt: until.toISOString() });
        notifiedAlarmsRef.current.delete(alarm.id);
        setAlarms((prev) =>
          prev
            .map((a) => (a.id === alarm.id ? updated : a))
            .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
        );
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [showToast]
  );

  const dismissAlarm = useCallback(async (alarm: Alarm) => {
    try {
      await api.deleteAlarm(alarm.id);
    } catch {
      /* already gone server-side — still drop it locally */
    }
    notifiedAlarmsRef.current.delete(alarm.id);
    setAlarms((prev) => prev.filter((a) => a.id !== alarm.id));
  }, []);

  const refreshCurrent = useCallback(() => {
    const { accountId, mailboxId, offset: o, query } = selectionRef.current;
    if (accountId && mailboxId) {
      void loadMessages(accountId, mailboxId, o, query);
      void loadMailboxes(accountId);
    }
  }, [loadMessages, loadMailboxes]);

  const openAlarm = useCallback(
    async (alarm: Alarm) => {
      if (!accounts.some((a) => a.id === alarm.accountId)) {
        showToast('The account for this alarm is no longer connected');
        return;
      }
      if (selectedAccountId !== alarm.accountId || selectedMailboxId !== alarm.mailboxId) {
        selectMailbox(alarm.accountId, alarm.mailboxId);
      }
      setMessageLoading(true);
      try {
        const { message } = await api.getMessage(alarm.accountId, alarm.mailboxId, alarm.messageId);
        setSelectedMessage(message);
      } catch {
        showToast('The message for this alarm is no longer available');
      } finally {
        setMessageLoading(false);
      }
    },
    [accounts, selectedAccountId, selectedMailboxId, selectMailbox, showToast]
  );

  const openAlarmModal = useCallback(
    (msg: MessageSummary, mailboxId: string) => {
      if (!selectedAccountId) return;
      setAlarmTarget({
        accountId: selectedAccountId,
        mailboxId: msg.mailboxId || mailboxId,
        messageId: msg.id,
        subject: msg.subject,
        from: msg.from,
      });
    },
    [selectedAccountId]
  );

  const selectMessage = useCallback(
    async (msg: MessageSummary) => {
      if (!selectedAccountId || !selectedMailboxId) return;
      setMessageLoading(true);
      try {
        const { message } = await api.getMessage(selectedAccountId, selectedMailboxId, msg.id);
        setSelectedMessage(message);
        if (!msg.seen) {
          void api
            .setFlags(selectedAccountId, selectedMailboxId, [msg.id], { seen: true })
            .then(() => {
              setPage((prev) =>
                prev
                  ? {
                      ...prev,
                      messages: prev.messages.map((m) =>
                        m.id === msg.id ? { ...m, seen: true } : m
                      ),
                    }
                  : prev
              );
              void loadMailboxes(selectedAccountId);
            });
        }
      } catch (err) {
        showToast((err as Error).message);
      } finally {
        setMessageLoading(false);
      }
    },
    [selectedAccountId, selectedMailboxId, loadMailboxes, showToast]
  );

  const toggleFlag = useCallback(
    async (msg: MessageSummary) => {
      if (!selectedAccountId || !selectedMailboxId) return;
      try {
        await api.setFlags(selectedAccountId, selectedMailboxId, [msg.id], {
          flagged: !msg.flagged,
        });
        setPage((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === msg.id ? { ...m, flagged: !msg.flagged } : m
                ),
              }
            : prev
        );
        setSelectedMessage((prev) =>
          prev && prev.id === msg.id ? { ...prev, flagged: !msg.flagged } : prev
        );
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [selectedAccountId, selectedMailboxId, showToast]
  );

  const deleteMessages = useCallback(
    async (ids: string[]) => {
      if (!selectedAccountId || !selectedMailboxId) return;
      try {
        await api.deleteMessages(selectedAccountId, selectedMailboxId, ids);
        setSelectedMessage((prev) => (prev && ids.includes(prev.id) ? null : prev));
        refreshCurrent();
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [selectedAccountId, selectedMailboxId, refreshCurrent, showToast]
  );

  const moveMessage = useCallback(
    async (targetMailboxId: string) => {
      if (!selectedAccountId || !selectedMailboxId || !selectedMessage) return;
      try {
        await api.moveMessages(selectedAccountId, selectedMailboxId, [selectedMessage.id], targetMailboxId);
        setSelectedMessage(null);
        refreshCurrent();
        showToast('Message moved');
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [selectedAccountId, selectedMailboxId, selectedMessage, refreshCurrent, showToast]
  );

  const toggleSeen = useCallback(async () => {
    if (!selectedAccountId || !selectedMailboxId || !selectedMessage) return;
    const next = !selectedMessage.seen;
    try {
      await api.setFlags(selectedAccountId, selectedMailboxId, [selectedMessage.id], { seen: next });
      setSelectedMessage((prev) => (prev ? { ...prev, seen: next } : prev));
      setPage((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === selectedMessage.id ? { ...m, seen: next } : m
              ),
            }
          : prev
      );
      void loadMailboxes(selectedAccountId);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [selectedAccountId, selectedMailboxId, selectedMessage, loadMailboxes, showToast]);

  const openCompose = useCallback(
    (mode?: 'reply' | 'replyAll' | 'forward') => {
      const accountId = selectedAccountId ?? accounts[0]?.id;
      if (!accountId) return;
      if (!mode || !selectedMessage) {
        setComposerDraft({ accountId, to: '', cc: '', bcc: '', subject: '', body: '' });
        return;
      }
      const msg = selectedMessage;
      const quoteHeader = `\n\nOn ${new Date(msg.date).toLocaleString()}, ${
        msg.from.map(formatAddress).join(', ') || 'someone'
      } wrote:\n`;
      const quoted = (msg.text ?? msg.preview ?? '')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      if (mode === 'forward') {
        setComposerDraft({
          accountId,
          to: '',
          cc: '',
          bcc: '',
          subject: /^fwd:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`,
          body: `${quoteHeader}${quoted}`,
        });
        return;
      }
      const replyTo = msg.replyTo.length > 0 ? msg.replyTo : msg.from;
      const account = accounts.find((a) => a.id === accountId);
      const ownEmail = account?.email.toLowerCase();
      const ccList =
        mode === 'replyAll'
          ? [...msg.to, ...msg.cc].filter(
              (a) =>
                a.email.toLowerCase() !== ownEmail &&
                !replyTo.some((r) => r.email.toLowerCase() === a.email.toLowerCase())
            )
          : [];
      setComposerDraft({
        accountId,
        to: replyTo.map(formatAddress).join(', '),
        cc: ccList.map(formatAddress).join(', '),
        bcc: '',
        subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
        body: `${quoteHeader}${quoted}`,
        inReplyTo: msg.messageIdHeader,
      });
    },
    [selectedAccountId, selectedMessage, accounts]
  );

  const runSearch = useCallback(() => {
    if (!selectedAccountId || !selectedMailboxId) return;
    setActiveQuery(searchInput.trim());
    setSelectedMessage(null);
    void loadMessages(selectedAccountId, selectedMailboxId, 0, searchInput.trim());
  }, [searchInput, selectedAccountId, selectedMailboxId, loadMessages]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* session may already be gone */
    }
    setToken(null);
    setAuthed(false);
    setAccounts([]);
    setMailboxes({});
    setSelectedAccountId(null);
    setSelectedMailboxId(null);
    setPage(null);
    setSelectedMessage(null);
    setAlarms([]);
    setAlarmTarget(null);
    notifiedAlarmsRef.current.clear();
  }, []);

  const removeAccount = useCallback(
    async (accountId: string) => {
      if (!window.confirm('Remove this account from Rocimail?')) return;
      try {
        await api.removeAccount(accountId);
        setAccounts((prev) => prev.filter((a) => a.id !== accountId));
        setMailboxes((prev) => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        if (selectedAccountId === accountId) {
          const primary = accounts.find((a) => a.primary);
          const boxes = primary ? (mailboxes[primary.id] ?? []) : [];
          const inbox = boxes.find((m) => m.role === 'inbox') ?? boxes[0];
          if (primary && inbox) selectMailbox(primary.id, inbox.id);
        }
      } catch (err) {
        showToast((err as Error).message);
      }
    },
    [accounts, mailboxes, selectedAccountId, selectMailbox, showToast]
  );

  if (!authed) {
    return (
      <Login
        onLogin={() => {
          setAuthed(true);
        }}
      />
    );
  }

  const currentBoxes = selectedAccountId ? (mailboxes[selectedAccountId] ?? []) : [];
  const currentMailbox = currentBoxes.find((m) => m.id === selectedMailboxId);
  const primaryAccount = accounts.find((a) => a.primary);

  return (
    <div className="app">
      <header className="topbar">
        <div className="login-logo small">
          <span className="logo-mark">R</span>
          <span className="logo-text">Rocimail</span>
        </div>
        <div className="search-box">
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
            placeholder={`Search in ${currentMailbox?.name ?? 'folder'}…`}
          />
          <button className="icon-btn" title="Search" onClick={runSearch}>
            🔍
          </button>
          {activeQuery && (
            <button
              className="icon-btn"
              title="Clear search"
              onClick={() => {
                setSearchInput('');
                setActiveQuery('');
                if (selectedAccountId && selectedMailboxId) {
                  void loadMessages(selectedAccountId, selectedMailboxId, 0, '');
                }
              }}
            >
              ×
            </button>
          )}
        </div>
        <div className="topbar-right">
          <AlarmBell
            alarms={alarms}
            dueIds={dueAlarmIds}
            onOpen={(alarm) => void openAlarm(alarm)}
            onSnooze={(alarm, until) => void snoozeAlarm(alarm, until)}
            onDismiss={(alarm) => void dismissAlarm(alarm)}
          />
          <span className="topbar-user" title={primaryAccount?.email}>
            {primaryAccount?.email}
          </span>
          <button className="btn-plain" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <div className="app-body">
        <Sidebar
          accounts={accounts}
          mailboxes={mailboxes}
          selectedAccountId={selectedAccountId}
          selectedMailboxId={selectedMailboxId}
          onSelectMailbox={selectMailbox}
          onCompose={() => openCompose()}
          onAddAccount={() => setAddAccountOpen(true)}
          onRemoveAccount={removeAccount}
        />
        <MessageList
          page={page}
          loading={listLoading}
          error={listError}
          selectedMessageId={selectedMessage?.id ?? null}
          mailboxName={currentMailbox?.name ?? ''}
          searchActive={Boolean(activeQuery)}
          offset={offset}
          limit={PAGE_SIZE}
          onSelect={(m) => void selectMessage(m)}
          onPage={(newOffset) => {
            if (selectedAccountId && selectedMailboxId) {
              void loadMessages(selectedAccountId, selectedMailboxId, newOffset, activeQuery);
            }
          }}
          alarmedIds={
            new Set(
              alarms.filter((a) => a.accountId === selectedAccountId).map((a) => a.messageId)
            )
          }
          onRefresh={refreshCurrent}
          onToggleFlag={(m) => void toggleFlag(m)}
          onDelete={(m) => void deleteMessages([m.id])}
          onSetAlarm={(m) => openAlarmModal(m, selectedMailboxId ?? '')}
        />
        <MessageView
          accountId={selectedAccountId ?? ''}
          message={selectedMessage}
          loading={messageLoading}
          mailboxes={currentBoxes}
          alarm={
            selectedMessage
              ? (alarms.find(
                  (a) => a.accountId === selectedAccountId && a.messageId === selectedMessage.id
                ) ?? null)
              : null
          }
          onReply={(mode) => openCompose(mode)}
          onDelete={() => selectedMessage && void deleteMessages([selectedMessage.id])}
          onToggleSeen={() => void toggleSeen()}
          onToggleFlag={() => selectedMessage && void toggleFlag(selectedMessage)}
          onMove={(target) => void moveMessage(target)}
          onSetAlarm={() =>
            selectedMessage && openAlarmModal(selectedMessage, selectedMessage.mailboxId)
          }
        />
      </div>
      {composerDraft && (
        <Composer
          draft={composerDraft}
          accounts={accounts}
          onClose={() => setComposerDraft(null)}
          onSent={(accountId) => {
            setComposerDraft(null);
            showToast('Message sent');
            void loadMailboxes(accountId);
          }}
        />
      )}
      {alarmTarget && (
        <AlarmModal
          target={alarmTarget}
          existing={
            alarms.find(
              (a) =>
                a.accountId === alarmTarget.accountId && a.messageId === alarmTarget.messageId
            ) ?? null
          }
          onClose={() => setAlarmTarget(null)}
          onSaved={(alarm) => {
            setAlarmTarget(null);
            setAlarms((prev) =>
              [
                ...prev.filter(
                  (a) => !(a.accountId === alarm.accountId && a.messageId === alarm.messageId)
                ),
                alarm,
              ].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
            );
            showToast(`Alarm set for ${new Date(alarm.dueAt).toLocaleString()}`);
          }}
          onRemoved={(alarmId) => {
            setAlarmTarget(null);
            notifiedAlarmsRef.current.delete(alarmId);
            setAlarms((prev) => prev.filter((a) => a.id !== alarmId));
            showToast('Alarm removed');
          }}
        />
      )}
      {addAccountOpen && (
        <AddAccountModal
          onClose={() => setAddAccountOpen(false)}
          onAdded={(account) => {
            setAddAccountOpen(false);
            setAccounts((prev) => [...prev, account]);
            void loadMailboxes(account.id);
            showToast(`Added ${account.email}`);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
