import Foundation
import XCTest
@testable import RociStore
import RociModel

final class MailStoreTests: XCTestCase {
    private var store: MailStore!
    private let accountId = "acct1"

    override func setUpWithError() throws {
        try super.setUpWithError()
        store = try MailStore() // in-memory
        try store.saveAccount(
            Account(
                id: accountId,
                kind: .jmap,
                serverURL: URL(string: "https://mail.example.com")!,
                username: "user@example.com",
                displayName: "Live",
                jmapAccountId: "a01"
            )
        )
    }

    private func header(
        id: String,
        subject: String = "Hello",
        preview: String = "",
        sender: String = "alice@example.com",
        mailboxIds: [String] = ["inbox1"],
        receivedAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
        seen: Bool = false
    ) -> MessageHeader {
        MessageHeader(
            id: id,
            accountId: accountId,
            mailboxIds: mailboxIds,
            from: [EmailAddress(name: nil, email: sender)],
            subject: subject,
            preview: preview,
            receivedAt: receivedAt,
            isSeen: seen
        )
    }

    // MARK: - Accounts

    func testAccountRoundTrip() throws {
        let accounts = try store.accounts()
        XCTAssertEqual(accounts.count, 1)
        XCTAssertEqual(accounts[0].id, accountId)
        XCTAssertEqual(accounts[0].kind, .jmap)
        XCTAssertFalse(accounts[0].isReadOnly)
    }

    // MARK: - Mailboxes

    func testReplaceMailboxes() throws {
        try store.replaceMailboxes(
            [
                Mailbox(id: "inbox1", accountId: accountId, name: "Inbox", role: "inbox", sortOrder: 1),
                Mailbox(id: "sent1", accountId: accountId, name: "Sent", role: "sent", sortOrder: 2),
            ],
            accountId: accountId
        )
        var mailboxes = try store.mailboxes(accountId: accountId)
        XCTAssertEqual(mailboxes.map(\.id), ["inbox1", "sent1"])

        // Replacing drops mailboxes the server no longer has.
        try store.replaceMailboxes(
            [Mailbox(id: "inbox1", accountId: accountId, name: "Inbox", role: "inbox", sortOrder: 1)],
            accountId: accountId
        )
        mailboxes = try store.mailboxes(accountId: accountId)
        XCTAssertEqual(mailboxes.map(\.id), ["inbox1"])
    }

    // MARK: - Messages

    func testMessageUpsertAndListByMailbox() throws {
        let older = header(id: "m1", receivedAt: Date(timeIntervalSince1970: 1_000))
        let newer = header(id: "m2", receivedAt: Date(timeIntervalSince1970: 2_000))
        let elsewhere = header(id: "m3", mailboxIds: ["archive1"])
        try store.upsertMessages([older, newer, elsewhere])

        let inbox = try store.messages(accountId: accountId, mailboxId: "inbox1")
        XCTAssertEqual(inbox.map(\.id), ["m2", "m1"], "newest first, mailbox-scoped")

        // Moving a message updates the junction table.
        var moved = older
        moved.mailboxIds = ["archive1"]
        try store.upsertMessages([moved])
        XCTAssertEqual(try store.messages(accountId: accountId, mailboxId: "inbox1").map(\.id), ["m2"])
        XCTAssertEqual(
            Set(try store.messages(accountId: accountId, mailboxId: "archive1").map(\.id)),
            ["m1", "m3"]
        )
    }

    func testDeleteMessagesRemovesEverything() throws {
        try store.upsertMessages([header(id: "m1")])
        try store.saveBody(messageId: "m1", accountId: accountId, html: "<p>hi</p>", text: "hi")
        try store.deleteMessages(ids: ["m1"], accountId: accountId)
        XCTAssertNil(try store.message(id: "m1", accountId: accountId))
        XCTAssertNil(try store.body(messageId: "m1", accountId: accountId))
        XCTAssertTrue(try store.messages(accountId: accountId, mailboxId: "inbox1").isEmpty)
    }

    func testFlagsPersist() throws {
        try store.upsertMessages([header(id: "m1", seen: false)])
        try store.setFlags(messageId: "m1", accountId: accountId, seen: true, flagged: true)
        let fetched = try XCTUnwrap(try store.message(id: "m1", accountId: accountId))
        XCTAssertTrue(fetched.isSeen)
        XCTAssertTrue(fetched.isFlagged)
    }

    func testBodyRoundTrip() throws {
        try store.upsertMessages([header(id: "m1")])
        try store.saveBody(
            messageId: "m1", accountId: accountId, html: "<p>hello</p>", text: "hello"
        )
        let body = try XCTUnwrap(try store.body(messageId: "m1", accountId: accountId))
        XCTAssertEqual(body.html, "<p>hello</p>")
        XCTAssertEqual(body.text, "hello")
    }

    // MARK: - Search

    func testLocalSearchFindsSubjectAndSender() throws {
        try store.upsertMessages([
            header(id: "m1", subject: "Quarterly report attached"),
            header(id: "m2", subject: "Lunch tomorrow?", sender: "bob@example.com"),
            header(id: "m3", subject: "Re: quarterly numbers"),
        ])

        let bySubject = try store.searchMessages(
            accountId: accountId, matchExpression: "\"quarterly\""
        )
        XCTAssertEqual(Set(bySubject.map(\.id)), ["m1", "m3"])

        let bySender = try store.searchMessages(
            accountId: accountId, matchExpression: "\"bob\""
        )
        XCTAssertEqual(bySender.map(\.id), ["m2"])
    }

    func testSearchDoesNotLeakAcrossAccounts() throws {
        try store.saveAccount(
            Account(
                id: "acct2",
                kind: .jmapArchive,
                serverURL: URL(string: "https://qnap.example.com")!,
                username: "archive",
                displayName: "Archive",
                jmapAccountId: "a02"
            )
        )
        try store.upsertMessages([header(id: "m1", subject: "unique-term-xyz")])
        let hits = try store.searchMessages(
            accountId: "acct2", matchExpression: "\"unique-term-xyz\""
        )
        XCTAssertTrue(hits.isEmpty)
    }

    // MARK: - Sync state

    func testSyncStateRoundTrip() throws {
        XCTAssertNil(try store.syncState(accountId: accountId, kind: "email"))
        try store.setSyncState(accountId: accountId, kind: "email", state: "e-1")
        XCTAssertEqual(try store.syncState(accountId: accountId, kind: "email"), "e-1")
        try store.setSyncState(accountId: accountId, kind: "email", state: "e-2")
        XCTAssertEqual(try store.syncState(accountId: accountId, kind: "email"), "e-2")
        try store.clearSyncState(accountId: accountId)
        XCTAssertNil(try store.syncState(accountId: accountId, kind: "email"))
    }

    // MARK: - Outbox

    func testOutboxLifecycle() throws {
        let id1 = try store.enqueue(
            accountId: accountId, kind: "setKeyword",
            payload: ["keyword": "$seen", "value": "1", "ids": "m1"]
        )
        _ = try store.enqueue(
            accountId: accountId, kind: "setKeyword",
            payload: ["keyword": "$flagged", "value": "1", "ids": "m2"]
        )

        var pending = try store.pendingOps(accountId: accountId)
        XCTAssertEqual(pending.count, 2)
        XCTAssertEqual(pending[0].payload["keyword"], "$seen")

        try store.recordAttempt(id: id1)
        pending = try store.pendingOps(accountId: accountId)
        XCTAssertEqual(pending[0].attempts, 1)

        try store.completeOp(id: id1)
        pending = try store.pendingOps(accountId: accountId)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].payload["keyword"], "$flagged")
    }
}

final class BlobCacheTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("BlobCacheTests-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    func testStoreAndRetrieve() throws {
        let cache = try BlobCache(directory: directory)
        let payload = Data("attachment-bytes".utf8)
        try cache.store(payload, for: "blob/1?weird name.pdf")
        XCTAssertTrue(cache.contains(key: "blob/1?weird name.pdf"))
        XCTAssertEqual(cache.data(for: "blob/1?weird name.pdf"), payload)
        XCTAssertNil(cache.data(for: "missing"))
    }

    func testEvictionRespectsBudget() throws {
        let cache = try BlobCache(directory: directory, budgetBytes: 100)
        try cache.store(Data(repeating: 1, count: 60), for: "old")
        // Ensure distinct mtimes so LRU ordering is deterministic.
        Thread.sleep(forTimeInterval: 1.1)
        try cache.store(Data(repeating: 2, count: 60), for: "new")
        XCTAssertLessThanOrEqual(cache.totalBytes(), 100)
        XCTAssertTrue(cache.contains(key: "new"), "most recent blob survives eviction")
        XCTAssertFalse(cache.contains(key: "old"), "oldest blob is evicted first")
    }
}
