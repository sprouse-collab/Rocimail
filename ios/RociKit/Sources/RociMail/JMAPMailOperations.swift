import Foundation
import RociModel

/// Typed mail operations over the raw JMAP request engine.
/// These are the calls the sync engine (RociSync) drives.
extension JMAPClient {
    /// Properties fetched for message-list rendering.
    static let headerProperties: JSONValue = [
        "id", "blobId", "threadId", "mailboxIds", "keywords", "from", "to",
        "subject", "receivedAt", "size", "preview", "hasAttachment",
    ]

    public func primaryAccountId() throws -> String {
        guard let session, let accountId = session.primaryMailAccountId else {
            throw JMAPError.discoveryFailed("not connected")
        }
        return accountId
    }

    // MARK: - Mailboxes

    public func mailboxes(localAccountId: String) async throws -> [Mailbox] {
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation("Mailbox/get", ["accountId": .string(accountId), "ids": .null], "0")
        ])
        let args = try Self.arguments(for: "0", method: "Mailbox/get", in: responses)
        let list = args["list"].arrayValue ?? []
        return list.compactMap { JMAPMapping.mailbox(from: $0, localAccountId: localAccountId) }
    }

    public func mailboxState() async throws -> String {
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation("Mailbox/get", ["accountId": .string(accountId), "ids": []], "0")
        ])
        let args = try Self.arguments(for: "0", method: "Mailbox/get", in: responses)
        guard let state = args["state"].stringValue else {
            throw JMAPError.malformedResponse("Mailbox/get returned no state")
        }
        return state
    }

    public func mailboxChanges(since state: String) async throws -> ChangeSet {
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation(
                "Mailbox/changes",
                ["accountId": .string(accountId), "sinceState": .string(state)],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Mailbox/changes", in: responses)
        return JMAPMapping.changeSet(from: args)
    }

    // MARK: - Message listing

    public struct QueryPage: Sendable, Hashable {
        public var ids: [String]
        public var total: Int?
        public var queryState: String
        public var position: Int

        public init(ids: [String], total: Int? = nil, queryState: String, position: Int) {
            self.ids = ids
            self.total = total
            self.queryState = queryState
            self.position = position
        }
    }

    /// Page of message ids in a mailbox, newest first, with optional
    /// server-side full-text search.
    public func queryEmails(
        inMailbox mailboxId: String?,
        searchText: String? = nil,
        position: Int = 0,
        limit: Int = 50
    ) async throws -> QueryPage {
        let accountId = try primaryAccountId()

        var filter: [String: JSONValue] = [:]
        if let mailboxId { filter["inMailbox"] = .string(mailboxId) }
        if let searchText, !searchText.isEmpty { filter["text"] = .string(searchText) }

        var args: [String: JSONValue] = [
            "accountId": .string(accountId),
            "sort": [["property": "receivedAt", "isAscending": false]],
            "position": .number(Double(position)),
            "limit": .number(Double(limit)),
            "calculateTotal": true,
        ]
        if !filter.isEmpty { args["filter"] = .object(filter) }

        let responses = try await call([Invocation("Email/query", .object(args), "0")])
        let result = try Self.arguments(for: "0", method: "Email/query", in: responses)
        guard let queryState = result["queryState"].stringValue else {
            throw JMAPError.malformedResponse("Email/query returned no queryState")
        }
        return QueryPage(
            ids: result["ids"].stringArray ?? [],
            total: result["total"].intValue,
            queryState: queryState,
            position: result["position"].intValue ?? position
        )
    }

    // MARK: - Message fetch

    public func emailHeaders(ids: [String], localAccountId: String) async throws -> [MessageHeader] {
        guard !ids.isEmpty else { return [] }
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation(
                "Email/get",
                [
                    "accountId": .string(accountId),
                    "ids": .array(ids.map(JSONValue.string)),
                    "properties": Self.headerProperties,
                ],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Email/get", in: responses)
        let list = args["list"].arrayValue ?? []
        return list.compactMap { JMAPMapping.header(from: $0, localAccountId: localAccountId) }
    }

    public func emailDetail(id: String, localAccountId: String) async throws -> MessageDetail {
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation(
                "Email/get",
                [
                    "accountId": .string(accountId),
                    "ids": [.string(id)],
                    "properties": [
                        "id", "blobId", "threadId", "mailboxIds", "keywords", "from", "to",
                        "cc", "replyTo", "subject", "receivedAt", "size", "preview",
                        "hasAttachment", "bodyValues", "textBody", "htmlBody", "attachments",
                        "messageId", "references",
                    ],
                    "fetchHTMLBodyValues": true,
                    "fetchTextBodyValues": true,
                    "maxBodyValueBytes": .number(1_048_576),
                ],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Email/get", in: responses)
        guard let first = args["list"].arrayValue?.first,
              let detail = JMAPMapping.detail(from: first, localAccountId: localAccountId)
        else {
            throw JMAPError.malformedResponse("Email/get returned no message for \(id)")
        }
        return detail
    }

    // MARK: - Deltas

    public func emailState() async throws -> String {
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation("Email/get", ["accountId": .string(accountId), "ids": []], "0")
        ])
        let args = try Self.arguments(for: "0", method: "Email/get", in: responses)
        guard let state = args["state"].stringValue else {
            throw JMAPError.malformedResponse("Email/get returned no state")
        }
        return state
    }

    public func emailChanges(since state: String) async throws -> ChangeSet {
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation(
                "Email/changes",
                [
                    "accountId": .string(accountId),
                    "sinceState": .string(state),
                    "maxChanges": .number(256),
                ],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Email/changes", in: responses)
        return JMAPMapping.changeSet(from: args)
    }

    // MARK: - Mutations

    /// Set or clear keywords (`$seen`, `$flagged`, …) on a set of messages.
    public func setKeyword(_ keyword: String, to value: Bool, onEmailIds ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        let accountId = try primaryAccountId()
        var update: [String: JSONValue] = [:]
        for id in ids {
            update[id] = .object(["keywords/\(keyword)": value ? .bool(true) : .null])
        }
        let responses = try await call([
            Invocation(
                "Email/set",
                ["accountId": .string(accountId), "update": .object(update)],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Email/set", in: responses)
        if let notUpdated = args["notUpdated"].objectValue, !notUpdated.isEmpty {
            let firstError = notUpdated.values.first
            throw JMAPError.methodError(
                type: firstError?["type"].stringValue ?? "serverFail",
                description: firstError?["description"].stringValue
            )
        }
    }
}
