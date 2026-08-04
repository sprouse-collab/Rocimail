import type { AccountInfo, MailboxInfo, MailboxRole } from '../types';

interface Props {
  accounts: AccountInfo[];
  mailboxes: Record<string, MailboxInfo[]>;
  selectedAccountId: string | null;
  selectedMailboxId: string | null;
  onSelectMailbox: (accountId: string, mailboxId: string) => void;
  onCompose: () => void;
  onAddAccount: () => void;
  onRemoveAccount: (accountId: string) => void;
}

const ROLE_ICONS: Record<string, string> = {
  inbox: '📥',
  drafts: '📝',
  sent: '📤',
  trash: '🗑️',
  junk: '⚠️',
  archive: '🗄️',
  all: '📧',
  flagged: '🚩',
  important: '⭐',
};

const ROLE_ORDER: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
};

function sortMailboxes(list: MailboxInfo[]): MailboxInfo[] {
  return [...list].sort((a, b) => {
    const ra = a.role ? (ROLE_ORDER[a.role] ?? 6) : 7;
    const rb = b.role ? (ROLE_ORDER[b.role] ?? 6) : 7;
    if (ra !== rb) return ra - rb;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });
}

function mailboxIcon(role: MailboxRole | null): string {
  return (role && ROLE_ICONS[role]) || '📁';
}

export default function Sidebar({
  accounts,
  mailboxes,
  selectedAccountId,
  selectedMailboxId,
  onSelectMailbox,
  onCompose,
  onAddAccount,
  onRemoveAccount,
}: Props) {
  return (
    <aside className="sidebar">
      <button className="compose-btn" onClick={onCompose}>
        <span className="compose-plus">+</span> New Mail
      </button>
      <div className="sidebar-scroll">
        {accounts.map((account) => (
          <div key={account.id} className="account-section">
            <div className="account-header" title={account.email}>
              <span className={`account-dot ${account.kind}`} />
              <span className="account-name">{account.name}</span>
              <span className="account-kind">{account.kind.toUpperCase()}</span>
              {!account.primary && (
                <button
                  className="account-remove"
                  title="Remove account"
                  onClick={() => onRemoveAccount(account.id)}
                >
                  ×
                </button>
              )}
            </div>
            <ul className="folder-list">
              {sortMailboxes(mailboxes[account.id] ?? []).map((mb) => {
                const active = account.id === selectedAccountId && mb.id === selectedMailboxId;
                return (
                  <li key={mb.id}>
                    <button
                      className={`folder-item ${active ? 'active' : ''} ${mb.parentId ? 'nested' : ''}`}
                      onClick={() => onSelectMailbox(account.id, mb.id)}
                    >
                      <span className="folder-icon">{mailboxIcon(mb.role)}</span>
                      <span className="folder-name">{mb.name}</span>
                      {mb.unreadMessages > 0 && (
                        <span className="folder-badge">{mb.unreadMessages}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <button className="add-account-btn" onClick={onAddAccount}>
        + Add IMAP account
      </button>
    </aside>
  );
}
