import Foundation
import RociMail
import RociModel
import RociStore

/// The subset of JMAPClient the sync engine drives — a protocol so tests can
/// script a fake server.
public protocol MailTransport: Sendable {
    func mailboxes(localAccountId: String) async throws -> [Mailbox]
    func mailboxState() async throws -> String
    func mailboxChanges(since state: String) async throws -> ChangeSet
    func queryEmails(
        inMailbox mailboxId: String?,
        searchText: String?,
        position: Int,
        limit: Int
    ) async throws -> JMAPClient.QueryPage
    func emailHeaders(ids: [String], localAccountId: String) async throws -> [MessageHeader]
    func emailDetail(id: String, localAccountId: String) async throws -> MessageDetail
    func emailState() async throws -> String
    func emailChanges(since state: String) async throws -> ChangeSet
    func setKeyword(_ keyword: String, to value: Bool, onEmailIds ids: [String]) async throws
}

extension JMAPClient: MailTransport {}

/// v0 sync engine: initial backfill, delta refresh, and an outbox that
/// replays local mutations. The UI never talks to the transport directly —
/// it reads the store and calls SyncEngine for anything network-shaped.
public actor SyncEngine {
    public enum StateKind {
        public static let mailbox = "mailbox"
        public static let email = "email"
    }

    public enum OpKind {
        public static let setKeyword = "setKeyword"
    }

    private let account: Account
    private let transport: MailTransport
    private let store: MailStore

    /// How many recent messages per mailbox the initial sync pulls.
    public var backfillWindow: Int

    public init(
        account: Account,
        transport: MailTransport,
        store: MailStore,
        backfillWindow: Int = 50
    ) {
        self.account = account
        self.transport = transport
        self.store = store
        self.backfillWindow = backfillWindow
    }

    // MARK: - Initial sync

    /// Fresh-account sync: mailbox tree, then the newest N messages of the
    /// inbox (other folders fill on demand), then record delta states.
    public func initialSync() async throws {
        let mailboxes = try await transport.mailboxes(localAccountId: account.id)
        try store.replaceMailboxes(mailboxes, accountId: account.id)

        let mailboxState = try await transport.mailboxState()
        try store.setSyncState(
            accountId: account.id, kind: StateKind.mailbox, state: mailboxState
        )

        // Record the email state BEFORE backfill so anything arriving during
        // the backfill shows up in the first delta instead of being missed.
        let emailState = try await transport.emailState()

        if let inbox = mailboxes.first(where: { $0.role == "inbox" }) ?? mailboxes.first {
            try await backfill(mailboxId: inbox.id)
        }

        try store.setSyncState(accountId: account.id, kind: StateKind.email, state: emailState)
    }

    /// Pull the newest window of message headers for one mailbox.
    public func backfill(mailboxId: String, position: Int = 0) async throws {
        let page = try await transport.queryEmails(
            inMailbox: mailboxId,
            searchText: nil,
            position: position,
            limit: backfillWindow
        )
        let headers = try await transport.emailHeaders(
            ids: page.ids, localAccountId: account.id
        )
        try store.upsertMessages(headers)
    }

    // MARK: - Delta refresh

    /// Apply server changes since the recorded states. Falls back to a full
    /// re-sync when the server can no longer compute deltas.
    public func refresh() async throws {
        guard let emailState = try store.syncState(
            accountId: account.id, kind: StateKind.email
        ) else {
            try await initialSync()
            return
        }

        do {
            try await refreshMailboxes()
            var state = emailState
            var hasMore = true
            while hasMore {
                let changes = try await transport.emailChanges(since: state)
                try await apply(changes: changes)
                state = changes.newState
                hasMore = changes.hasMoreChanges
            }
        } catch JMAPError.cannotCalculateChanges {
            try store.clearSyncState(accountId: account.id)
            try await initialSync()
        }
    }

    private func refreshMailboxes() async throws {
        guard let mailboxState = try store.syncState(
            accountId: account.id, kind: StateKind.mailbox
        ) else { return }
        let changes = try await transport.mailboxChanges(since: mailboxState)
        let changed = changes.created + changes.updated + changes.destroyed
        if !changed.isEmpty {
            // Mailbox lists are small — refetching the tree is simpler and
            // safer than patching it.
            let mailboxes = try await transport.mailboxes(localAccountId: account.id)
            try store.replaceMailboxes(mailboxes, accountId: account.id)
        }
        try store.setSyncState(
            accountId: account.id, kind: StateKind.mailbox, state: changes.newState
        )
    }

    private func apply(changes: ChangeSet) async throws {
        let toFetch = changes.created + changes.updated
        // Chunk so one giant delta doesn't produce an oversized Email/get.
        for chunk in stride(from: 0, to: toFetch.count, by: 50).map({
            Array(toFetch[$0..<min($0 + 50, toFetch.count)])
        }) {
            let headers = try await transport.emailHeaders(
                ids: chunk, localAccountId: account.id
            )
            try store.upsertMessages(headers)
        }
        try store.deleteMessages(ids: changes.destroyed, accountId: account.id)
        try store.setSyncState(
            accountId: account.id, kind: StateKind.email, state: changes.newState
        )
    }

    // MARK: - Message detail

    /// Body from cache, else fetch + cache. Marks nothing read — that's the
    /// caller's explicit action.
    public func loadDetail(messageId: String) async throws -> MessageDetail {
        if let cached = try store.body(messageId: messageId, accountId: account.id),
           let header = try store.message(id: messageId, accountId: account.id) {
            return MessageDetail(
                header: header,
                htmlBody: cached.html,
                textBody: cached.text
            )
        }
        let detail = try await transport.emailDetail(id: messageId, localAccountId: account.id)
        try store.upsertMessages([detail.header])
        try store.saveBody(
            messageId: messageId,
            accountId: account.id,
            html: detail.htmlBody,
            text: detail.textBody
        )
        return detail
    }

    // MARK: - Mutations (offline-first via outbox)

    /// Flag change: applied locally at once, queued, then replayed.
    public func setSeen(_ seen: Bool, messageId: String) async {
        try? store.setFlags(messageId: messageId, accountId: account.id, seen: seen)
        _ = try? store.enqueue(
            accountId: account.id,
            kind: OpKind.setKeyword,
            payload: [
                "keyword": MessageKeyword.seen,
                "value": seen ? "1" : "0",
                "ids": messageId,
            ]
        )
        await replayOutbox()
    }

    public func setFlagged(_ flagged: Bool, messageId: String) async {
        try? store.setFlags(messageId: messageId, accountId: account.id, flagged: flagged)
        _ = try? store.enqueue(
            accountId: account.id,
            kind: OpKind.setKeyword,
            payload: [
                "keyword": MessageKeyword.flagged,
                "value": flagged ? "1" : "0",
                "ids": messageId,
            ]
        )
        await replayOutbox()
    }

    /// Replay pending local mutations in order. Stops at the first failure
    /// (likely offline) — ops stay queued for the next attempt.
    public func replayOutbox() async {
        guard let ops = try? store.pendingOps(accountId: account.id) else { return }
        for op in ops {
            do {
                try await perform(op)
                try? store.completeOp(id: op.id)
            } catch {
                try? store.recordAttempt(id: op.id)
                break
            }
        }
    }

    private func perform(_ op: MailStore.OutboxOp) async throws {
        switch op.kind {
        case OpKind.setKeyword:
            guard let keyword = op.payload["keyword"],
                  let value = op.payload["value"],
                  let ids = op.payload["ids"]
            else { return } // malformed op: drop rather than wedge the queue
            try await transport.setKeyword(
                keyword,
                to: value == "1",
                onEmailIds: ids.split(separator: ",").map(String.init)
            )
        default:
            return // unknown op kind (from a newer schema): drop
        }
    }
}
