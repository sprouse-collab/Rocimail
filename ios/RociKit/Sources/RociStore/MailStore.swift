import Foundation
import GRDB
import RociModel

/// The local, offline-first mail store. The UI reads only from here; the sync
/// engine writes server state in and replays local mutations out (outbox).
public final class MailStore {
    private let dbQueue: DatabaseQueue

    // MARK: - Setup

    public init(path: String) throws {
        dbQueue = try DatabaseQueue(path: path)
        try Self.migrator.migrate(dbQueue)
    }

    /// In-memory store for tests and previews.
    public init() throws {
        dbQueue = try DatabaseQueue()
        try Self.migrator.migrate(dbQueue)
    }

    private static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()

        migrator.registerMigration("v1") { db in
            try db.create(table: "account") { t in
                t.column("id", .text).primaryKey()
                t.column("kind", .text).notNull()
                t.column("serverUrl", .text).notNull()
                t.column("username", .text).notNull()
                t.column("displayName", .text).notNull()
                t.column("jmapAccountId", .text).notNull()
            }

            try db.create(table: "mailbox") { t in
                t.column("id", .text).notNull()
                t.column("accountId", .text).notNull()
                    .references("account", onDelete: .cascade)
                t.column("parentId", .text)
                t.column("name", .text).notNull()
                t.column("role", .text)
                t.column("sortOrder", .integer).notNull().defaults(to: 0)
                t.column("totalEmails", .integer).notNull().defaults(to: 0)
                t.column("unreadEmails", .integer).notNull().defaults(to: 0)
                t.primaryKey(["accountId", "id"])
            }

            try db.create(table: "message") { t in
                t.column("id", .text).notNull()
                t.column("accountId", .text).notNull()
                    .references("account", onDelete: .cascade)
                t.column("blobId", .text)
                t.column("threadId", .text)
                t.column("fromJson", .text).notNull()
                t.column("toJson", .text).notNull()
                t.column("subject", .text)
                t.column("preview", .text)
                t.column("receivedAt", .datetime).notNull()
                t.column("size", .integer).notNull().defaults(to: 0)
                t.column("isSeen", .boolean).notNull().defaults(to: false)
                t.column("isFlagged", .boolean).notNull().defaults(to: false)
                t.column("hasAttachment", .boolean).notNull().defaults(to: false)
                t.primaryKey(["accountId", "id"])
            }
            try db.create(
                index: "message_receivedAt",
                on: "message",
                columns: ["accountId", "receivedAt"]
            )

            try db.create(table: "messageMailbox") { t in
                t.column("accountId", .text).notNull()
                t.column("messageId", .text).notNull()
                t.column("mailboxId", .text).notNull()
                t.primaryKey(["accountId", "messageId", "mailboxId"])
            }
            try db.create(
                index: "messageMailbox_mailbox",
                on: "messageMailbox",
                columns: ["accountId", "mailboxId"]
            )

            try db.create(table: "messageBody") { t in
                t.column("accountId", .text).notNull()
                t.column("messageId", .text).notNull()
                t.column("html", .text)
                t.column("text", .text)
                t.primaryKey(["accountId", "messageId"])
            }

            try db.create(table: "syncState") { t in
                t.column("accountId", .text).notNull()
                t.column("kind", .text).notNull() // "mailbox" | "email"
                t.column("state", .text).notNull()
                t.primaryKey(["accountId", "kind"])
            }

            try db.create(table: "outbox") { t in
                t.autoIncrementedPrimaryKey("id")
                t.column("accountId", .text).notNull()
                t.column("kind", .text).notNull()
                t.column("payloadJson", .text).notNull()
                t.column("createdAt", .datetime).notNull()
                t.column("attempts", .integer).notNull().defaults(to: 0)
            }

            // Standalone FTS index, maintained alongside message upserts.
            // M0 populates subject/sender/preview; bodies land in M1 and
            // attachment text in M3.
            try db.create(virtualTable: "messageFts", using: FTS5()) { t in
                t.tokenizer = .unicode61()
                t.column("accountId").notIndexed()
                t.column("messageId").notIndexed()
                t.column("subject")
                t.column("sender")
                t.column("preview")
            }
        }

        return migrator
    }

    // MARK: - Accounts

    public func saveAccount(_ account: Account) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO account
                    (id, kind, serverUrl, username, displayName, jmapAccountId)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                arguments: [
                    account.id, account.kind.rawValue, account.serverURL.absoluteString,
                    account.username, account.displayName, account.jmapAccountId,
                ]
            )
        }
    }

    public func accounts() throws -> [Account] {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(db, sql: "SELECT * FROM account ORDER BY displayName")
            return rows.compactMap { row in
                guard let kind = Account.Kind(rawValue: row["kind"] ?? ""),
                      let url = URL(string: row["serverUrl"] ?? "")
                else { return nil }
                return Account(
                    id: row["id"],
                    kind: kind,
                    serverURL: url,
                    username: row["username"],
                    displayName: row["displayName"],
                    jmapAccountId: row["jmapAccountId"]
                )
            }
        }
    }

    public func deleteAccount(id: String) throws {
        _ = try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM account WHERE id = ?", arguments: [id])
            // Tables without FK cascade:
            try db.execute(sql: "DELETE FROM messageMailbox WHERE accountId = ?", arguments: [id])
            try db.execute(sql: "DELETE FROM messageBody WHERE accountId = ?", arguments: [id])
            try db.execute(sql: "DELETE FROM syncState WHERE accountId = ?", arguments: [id])
            try db.execute(sql: "DELETE FROM outbox WHERE accountId = ?", arguments: [id])
            try db.execute(sql: "DELETE FROM messageFts WHERE accountId = ?", arguments: [id])
        }
    }

    // MARK: - Mailboxes

    /// Replace the account's mailbox tree with the server's current one.
    public func replaceMailboxes(_ mailboxes: [Mailbox], accountId: String) throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM mailbox WHERE accountId = ?", arguments: [accountId])
            for mailbox in mailboxes {
                try db.execute(
                    sql: """
                        INSERT INTO mailbox
                        (id, accountId, parentId, name, role, sortOrder, totalEmails, unreadEmails)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        mailbox.id, accountId, mailbox.parentId, mailbox.name, mailbox.role,
                        mailbox.sortOrder, mailbox.totalEmails, mailbox.unreadEmails,
                    ]
                )
            }
        }
    }

    public func mailboxes(accountId: String) throws -> [Mailbox] {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT * FROM mailbox WHERE accountId = ? ORDER BY sortOrder, name",
                arguments: [accountId]
            )
            return rows.map { row in
                Mailbox(
                    id: row["id"],
                    accountId: row["accountId"],
                    parentId: row["parentId"],
                    name: row["name"],
                    role: row["role"],
                    sortOrder: row["sortOrder"],
                    totalEmails: row["totalEmails"],
                    unreadEmails: row["unreadEmails"]
                )
            }
        }
    }

    // MARK: - Messages

    private static let addressEncoder = JSONEncoder()
    private static let addressDecoder = JSONDecoder()

    public func upsertMessages(_ headers: [MessageHeader]) throws {
        guard !headers.isEmpty else { return }
        try dbQueue.write { db in
            for header in headers {
                let fromJson = String(
                    data: try Self.addressEncoder.encode(header.from), encoding: .utf8
                ) ?? "[]"
                let toJson = String(
                    data: try Self.addressEncoder.encode(header.to), encoding: .utf8
                ) ?? "[]"
                try db.execute(
                    sql: """
                        INSERT OR REPLACE INTO message
                        (id, accountId, blobId, threadId, fromJson, toJson, subject, preview,
                         receivedAt, size, isSeen, isFlagged, hasAttachment)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        header.id, header.accountId, header.blobId, header.threadId,
                        fromJson, toJson, header.subject, header.preview,
                        header.receivedAt, header.size, header.isSeen, header.isFlagged,
                        header.hasAttachment,
                    ]
                )
                try db.execute(
                    sql: "DELETE FROM messageMailbox WHERE accountId = ? AND messageId = ?",
                    arguments: [header.accountId, header.id]
                )
                for mailboxId in header.mailboxIds {
                    try db.execute(
                        sql: """
                            INSERT OR REPLACE INTO messageMailbox (accountId, messageId, mailboxId)
                            VALUES (?, ?, ?)
                            """,
                        arguments: [header.accountId, header.id, mailboxId]
                    )
                }
                try db.execute(
                    sql: "DELETE FROM messageFts WHERE accountId = ? AND messageId = ?",
                    arguments: [header.accountId, header.id]
                )
                try db.execute(
                    sql: """
                        INSERT INTO messageFts (accountId, messageId, subject, sender, preview)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        header.accountId, header.id, header.subject ?? "",
                        header.from.map(\.displayName).joined(separator: " "),
                        header.preview ?? "",
                    ]
                )
            }
        }
    }

    public func deleteMessages(ids: [String], accountId: String) throws {
        guard !ids.isEmpty else { return }
        try dbQueue.write { db in
            for id in ids {
                try db.execute(
                    sql: "DELETE FROM message WHERE accountId = ? AND id = ?",
                    arguments: [accountId, id]
                )
                try db.execute(
                    sql: "DELETE FROM messageMailbox WHERE accountId = ? AND messageId = ?",
                    arguments: [accountId, id]
                )
                try db.execute(
                    sql: "DELETE FROM messageBody WHERE accountId = ? AND messageId = ?",
                    arguments: [accountId, id]
                )
                try db.execute(
                    sql: "DELETE FROM messageFts WHERE accountId = ? AND messageId = ?",
                    arguments: [accountId, id]
                )
            }
        }
    }

    public func messages(
        accountId: String,
        mailboxId: String,
        limit: Int = 50,
        offset: Int = 0
    ) throws -> [MessageHeader] {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT m.*, mm.mailboxId AS inMailbox FROM message m
                    JOIN messageMailbox mm
                      ON mm.accountId = m.accountId AND mm.messageId = m.id
                    WHERE m.accountId = ? AND mm.mailboxId = ?
                    ORDER BY m.receivedAt DESC
                    LIMIT ? OFFSET ?
                    """,
                arguments: [accountId, mailboxId, limit, offset]
            )
            return rows.compactMap(Self.headerFromRow)
        }
    }

    public func message(id: String, accountId: String) throws -> MessageHeader? {
        try dbQueue.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT * FROM message WHERE accountId = ? AND id = ?",
                arguments: [accountId, id]
            )
            return row.flatMap(Self.headerFromRow)
        }
    }

    private static func headerFromRow(_ row: Row) -> MessageHeader? {
        let fromJson: String = row["fromJson"] ?? "[]"
        let toJson: String = row["toJson"] ?? "[]"
        let from = (try? addressDecoder.decode([EmailAddress].self, from: Data(fromJson.utf8))) ?? []
        let to = (try? addressDecoder.decode([EmailAddress].self, from: Data(toJson.utf8))) ?? []
        guard let receivedAt = row["receivedAt"] as Date? else { return nil }
        return MessageHeader(
            id: row["id"],
            accountId: row["accountId"],
            blobId: row["blobId"],
            threadId: row["threadId"],
            mailboxIds: [],
            from: from,
            to: to,
            subject: row["subject"],
            preview: row["preview"],
            receivedAt: receivedAt,
            size: row["size"],
            isSeen: row["isSeen"],
            isFlagged: row["isFlagged"],
            hasAttachment: row["hasAttachment"]
        )
    }

    /// Local flag change (optimistic UI); the outbox replays it to the server.
    public func setFlags(
        messageId: String,
        accountId: String,
        seen: Bool? = nil,
        flagged: Bool? = nil
    ) throws {
        try dbQueue.write { db in
            if let seen {
                try db.execute(
                    sql: "UPDATE message SET isSeen = ? WHERE accountId = ? AND id = ?",
                    arguments: [seen, accountId, messageId]
                )
            }
            if let flagged {
                try db.execute(
                    sql: "UPDATE message SET isFlagged = ? WHERE accountId = ? AND id = ?",
                    arguments: [flagged, accountId, messageId]
                )
            }
        }
    }

    // MARK: - Bodies

    public func saveBody(messageId: String, accountId: String, html: String?, text: String?) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO messageBody (accountId, messageId, html, text)
                    VALUES (?, ?, ?, ?)
                    """,
                arguments: [accountId, messageId, html, text]
            )
        }
    }

    public func body(messageId: String, accountId: String) throws -> (html: String?, text: String?)? {
        try dbQueue.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT html, text FROM messageBody WHERE accountId = ? AND messageId = ?",
                arguments: [accountId, messageId]
            )
            guard let row else { return nil }
            return (html: row["html"], text: row["text"])
        }
    }

    // MARK: - Local search (FTS5)

    /// Search locally-synced messages. `matchExpression` must already be a
    /// valid FTS5 MATCH string (see RociSearch.FTSQueryBuilder).
    public func searchMessages(
        accountId: String,
        matchExpression: String,
        limit: Int = 50
    ) throws -> [MessageHeader] {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT m.* FROM messageFts
                    JOIN message m
                      ON m.accountId = messageFts.accountId AND m.id = messageFts.messageId
                    WHERE messageFts MATCH ? AND m.accountId = ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                arguments: [matchExpression, accountId, limit]
            )
            return rows.compactMap(Self.headerFromRow)
        }
    }

    // MARK: - Sync state

    public func syncState(accountId: String, kind: String) throws -> String? {
        try dbQueue.read { db in
            try String.fetchOne(
                db,
                sql: "SELECT state FROM syncState WHERE accountId = ? AND kind = ?",
                arguments: [accountId, kind]
            )
        }
    }

    public func setSyncState(accountId: String, kind: String, state: String) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: """
                    INSERT OR REPLACE INTO syncState (accountId, kind, state)
                    VALUES (?, ?, ?)
                    """,
                arguments: [accountId, kind, state]
            )
        }
    }

    public func clearSyncState(accountId: String) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "DELETE FROM syncState WHERE accountId = ?",
                arguments: [accountId]
            )
        }
    }

    // MARK: - Outbox

    public struct OutboxOp: Hashable, Sendable, Identifiable {
        public var id: Int64
        public var accountId: String
        public var kind: String
        public var payload: [String: String]
        public var attempts: Int

        public init(id: Int64, accountId: String, kind: String, payload: [String: String], attempts: Int) {
            self.id = id
            self.accountId = accountId
            self.kind = kind
            self.payload = payload
            self.attempts = attempts
        }
    }

    @discardableResult
    public func enqueue(accountId: String, kind: String, payload: [String: String]) throws -> Int64 {
        try dbQueue.write { db in
            let payloadJson = String(
                data: try JSONEncoder().encode(payload), encoding: .utf8
            ) ?? "{}"
            try db.execute(
                sql: """
                    INSERT INTO outbox (accountId, kind, payloadJson, createdAt, attempts)
                    VALUES (?, ?, ?, ?, 0)
                    """,
                arguments: [accountId, kind, payloadJson, Date()]
            )
            return db.lastInsertedRowID
        }
    }

    public func pendingOps(accountId: String) throws -> [OutboxOp] {
        try dbQueue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT * FROM outbox WHERE accountId = ? ORDER BY id",
                arguments: [accountId]
            )
            return rows.compactMap { row in
                let payloadJson: String = row["payloadJson"] ?? "{}"
                let payload = (try? JSONDecoder().decode(
                    [String: String].self, from: Data(payloadJson.utf8)
                )) ?? [:]
                return OutboxOp(
                    id: row["id"],
                    accountId: row["accountId"],
                    kind: row["kind"],
                    payload: payload,
                    attempts: row["attempts"]
                )
            }
        }
    }

    public func completeOp(id: Int64) throws {
        try dbQueue.write { db in
            try db.execute(sql: "DELETE FROM outbox WHERE id = ?", arguments: [id])
        }
    }

    public func recordAttempt(id: Int64) throws {
        try dbQueue.write { db in
            try db.execute(
                sql: "UPDATE outbox SET attempts = attempts + 1 WHERE id = ?",
                arguments: [id]
            )
        }
    }
}
