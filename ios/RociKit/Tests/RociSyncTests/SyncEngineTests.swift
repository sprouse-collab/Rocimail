import Foundation
import XCTest
@testable import RociSync
import RociMail
import RociModel
import RociStore

/// A scripted in-memory JMAP server for exercising the sync engine.
actor FakeTransport: MailTransport {
    var mailboxList: [Mailbox] = []
    var messagesByMailbox: [String: [MessageHeader]] = [:]
    var currentMailboxState = "mb-1"
    var currentEmailState = "e-1"
    var scriptedEmailChanges: [String: ChangeSet] = [:]
    var scriptedMailboxChanges: [String: ChangeSet] = [:]
    var headersById: [String: MessageHeader] = [:]
    var keywordCalls: [(keyword: String, value: Bool, ids: [String])] = []
    var failNextKeywordCalls = 0

    func seed(
        mailboxes: [Mailbox],
        inbox: [MessageHeader]
    ) {
        mailboxList = mailboxes
        if let inboxId = mailboxes.first(where: { $0.role == "inbox" })?.id {
            messagesByMailbox[inboxId] = inbox
        }
        for header in inbox {
            headersById[header.id] = header
        }
    }

    func script(emailChanges: ChangeSet, since state: String, adding headers: [MessageHeader]) {
        scriptedEmailChanges[state] = emailChanges
        for header in headers {
            headersById[header.id] = header
        }
    }

    func setFailNextKeywordCalls(_ count: Int) {
        failNextKeywordCalls = count
    }

    // MARK: - MailTransport

    func mailboxes(localAccountId: String) async throws -> [Mailbox] {
        mailboxList
    }

    func mailboxState() async throws -> String {
        currentMailboxState
    }

    func mailboxChanges(since state: String) async throws -> ChangeSet {
        scriptedMailboxChanges[state]
            ?? ChangeSet(newState: currentMailboxState)
    }

    func queryEmails(
        inMailbox mailboxId: String?,
        searchText: String?,
        position: Int,
        limit: Int
    ) async throws -> JMAPClient.QueryPage {
        let all = mailboxId.flatMap { messagesByMailbox[$0] } ?? []
        let sorted = all.sorted { $0.receivedAt > $1.receivedAt }
        let page = Array(sorted.dropFirst(position).prefix(limit))
        return JMAPClient.QueryPage(
            ids: page.map(\.id),
            total: all.count,
            queryState: "q-1",
            position: position
        )
    }

    func emailHeaders(ids: [String], localAccountId: String) async throws -> [MessageHeader] {
        ids.compactMap { headersById[$0] }
    }

    func emailDetail(id: String, localAccountId: String) async throws -> MessageDetail {
        guard let header = headersById[id] else {
            throw JMAPError.malformedResponse("no such message \(id)")
        }
        return MessageDetail(header: header, htmlBody: "<p>body of \(id)</p>", textBody: "body of \(id)")
    }

    func emailState() async throws -> String {
        currentEmailState
    }

    func emailChanges(since state: String) async throws -> ChangeSet {
        if let scripted = scriptedEmailChanges[state] {
            return scripted
        }
        if state == currentEmailState {
            return ChangeSet(newState: currentEmailState)
        }
        throw JMAPError.cannotCalculateChanges
    }

    func setKeyword(_ keyword: String, to value: Bool, onEmailIds ids: [String]) async throws {
        if failNextKeywordCalls > 0 {
            failNextKeywordCalls -= 1
            throw JMAPError.httpError(status: 503)
        }
        keywordCalls.append((keyword: keyword, value: value, ids: ids))
    }
}

final class SyncEngineTests: XCTestCase {
    private var store: MailStore!
    private var transport: FakeTransport!
    private var engine: SyncEngine!
    private let account = Account(
        id: "acct1",
        kind: .jmap,
        serverURL: URL(string: "https://mail.example.com")!,
        username: "user@example.com",
        displayName: "Live",
        jmapAccountId: "a01"
    )

    private func header(id: String, at time: TimeInterval, subject: String = "Hi") -> MessageHeader {
        MessageHeader(
            id: id,
            accountId: account.id,
            mailboxIds: ["inbox1"],
            from: [EmailAddress(email: "alice@example.com")],
            subject: subject,
            receivedAt: Date(timeIntervalSince1970: time)
        )
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        store = try MailStore()
        try store.saveAccount(account)
        transport = FakeTransport()
        engine = SyncEngine(account: account, transport: transport, store: store, backfillWindow: 10)
    }

    private func seedServer(messages: [MessageHeader]) async {
        await transport.seed(
            mailboxes: [
                Mailbox(id: "inbox1", accountId: account.id, name: "Inbox", role: "inbox", sortOrder: 1),
                Mailbox(id: "trash1", accountId: account.id, name: "Trash", role: "trash", sortOrder: 9),
            ],
            inbox: messages
        )
    }

    // MARK: - Initial sync (T3.1)

    func testInitialSyncPopulatesStore() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000), header(id: "m2", at: 2_000)])

        try await engine.initialSync()

        let mailboxes = try store.mailboxes(accountId: account.id)
        XCTAssertEqual(mailboxes.map(\.id), ["inbox1", "trash1"])

        let inbox = try store.messages(accountId: account.id, mailboxId: "inbox1")
        XCTAssertEqual(inbox.map(\.id), ["m2", "m1"], "newest first")

        XCTAssertEqual(try store.syncState(accountId: account.id, kind: "email"), "e-1")
        XCTAssertEqual(try store.syncState(accountId: account.id, kind: "mailbox"), "mb-1")
    }

    // MARK: - Delta refresh (T3.2)

    func testRefreshAppliesDelta() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000)])
        try await engine.initialSync()

        // Server moves on: m2 arrives, m1 is destroyed.
        let m2 = header(id: "m2", at: 3_000, subject: "New arrival")
        await transport.script(
            emailChanges: ChangeSet(
                created: ["m2"], updated: [], destroyed: ["m1"], newState: "e-2"
            ),
            since: "e-1",
            adding: [m2]
        )

        try await engine.refresh()

        let inbox = try store.messages(accountId: account.id, mailboxId: "inbox1")
        XCTAssertEqual(inbox.map(\.id), ["m2"], "delta applied without a full re-list")
        XCTAssertEqual(try store.syncState(accountId: account.id, kind: "email"), "e-2")
    }

    func testRefreshFallsBackWhenStateIsTooOld() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000)])
        try store.setSyncState(accountId: account.id, kind: "email", state: "ancient")
        try store.setSyncState(accountId: account.id, kind: "mailbox", state: "mb-1")

        // FakeTransport throws cannotCalculateChanges for unknown states →
        // the engine must recover with a full re-sync.
        try await engine.refresh()

        let inbox = try store.messages(accountId: account.id, mailboxId: "inbox1")
        XCTAssertEqual(inbox.map(\.id), ["m1"])
        XCTAssertEqual(try store.syncState(accountId: account.id, kind: "email"), "e-1")
    }

    func testRefreshWithNoStateRunsInitialSync() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000)])
        try await engine.refresh()
        let inbox = try store.messages(accountId: account.id, mailboxId: "inbox1")
        XCTAssertEqual(inbox.map(\.id), ["m1"])
    }

    // MARK: - Detail loading

    func testLoadDetailCachesBody() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000)])
        try await engine.initialSync()

        let detail = try await engine.loadDetail(messageId: "m1")
        XCTAssertEqual(detail.htmlBody, "<p>body of m1</p>")

        // Second load must come from the cache (no transport dependency):
        let cached = try XCTUnwrap(try store.body(messageId: "m1", accountId: account.id))
        XCTAssertEqual(cached.html, "<p>body of m1</p>")
    }

    // MARK: - Outbox (T3.3)

    func testMarkSeenAppliesLocallyAndReplays() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000)])
        try await engine.initialSync()

        await engine.setSeen(true, messageId: "m1")

        let local = try XCTUnwrap(try store.message(id: "m1", accountId: account.id))
        XCTAssertTrue(local.isSeen, "flag applies locally at once")

        let calls = await transport.keywordCalls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].keyword, "$seen")
        XCTAssertEqual(calls[0].ids, ["m1"])

        let pending = try store.pendingOps(accountId: account.id)
        XCTAssertTrue(pending.isEmpty, "successful replay drains the outbox")
    }

    func testOfflineMutationSurvivesAndReplaysLater() async throws {
        await seedServer(messages: [header(id: "m1", at: 1_000)])
        try await engine.initialSync()

        // Simulate offline: the first replay attempt fails.
        await transport.setFailNextKeywordCalls(1)
        await engine.setSeen(true, messageId: "m1")

        var pending = try store.pendingOps(accountId: account.id)
        XCTAssertEqual(pending.count, 1, "failed op stays queued")
        XCTAssertEqual(pending[0].attempts, 1)
        let localSeen = try XCTUnwrap(try store.message(id: "m1", accountId: account.id)).isSeen
        XCTAssertTrue(localSeen, "local state keeps the optimistic value")

        // Back online:
        await engine.replayOutbox()
        pending = try store.pendingOps(accountId: account.id)
        XCTAssertTrue(pending.isEmpty)
        let calls = await transport.keywordCalls
        XCTAssertEqual(calls.count, 1)
    }
}
