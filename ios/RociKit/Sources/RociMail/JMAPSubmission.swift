import Foundation
import RociModel

/// Sending, drafts, and mailbox mutations (Email/set, EmailSubmission/set,
/// Identity/get) — the write side of RFC 8621.
extension JMAPClient {
    private static var submissionCapabilities: [String] {
        [
            JMAPSession.coreCapability,
            JMAPSession.mailCapability,
            JMAPSession.submissionCapability,
        ]
    }

    // MARK: - Identities

    public func identities() async throws -> [Identity] {
        let accountId = try primaryAccountId()
        let responses = try await call(
            [Invocation("Identity/get", ["accountId": .string(accountId)], "0")],
            using: Self.submissionCapabilities
        )
        let args = try Self.arguments(for: "0", method: "Identity/get", in: responses)
        return (args["list"].arrayValue ?? []).compactMap { entry in
            guard let id = entry["id"].stringValue, let email = entry["email"].stringValue else {
                return nil
            }
            return Identity(id: id, name: entry["name"].stringValue ?? "", email: email)
        }
    }

    // MARK: - Compose payloads

    private static func addressList(_ addresses: [EmailAddress]) -> JSONValue {
        .array(addresses.map { address in
            var object: [String: JSONValue] = ["email": .string(address.email)]
            if let name = address.name { object["name"] = .string(name) }
            return .object(object)
        })
    }

    static func emailObject(
        for message: OutgoingMessage,
        mailboxId: String,
        keywords: [String: JSONValue]
    ) -> JSONValue {
        var object: [String: JSONValue] = [
            "mailboxIds": .object([mailboxId: .bool(true)]),
            "keywords": .object(keywords),
            "to": addressList(message.to),
            "subject": .string(message.subject),
            "bodyValues": ["body": ["value": .string(message.textBody)]],
            "textBody": [["partId": "body", "type": "text/plain"]],
        ]
        if let from = message.from {
            object["from"] = addressList([from])
        }
        if !message.cc.isEmpty { object["cc"] = addressList(message.cc) }
        if !message.bcc.isEmpty { object["bcc"] = addressList(message.bcc) }
        if let inReplyTo = message.inReplyTo {
            object["inReplyTo"] = [.string(inReplyTo)]
            var references = message.references
            if !references.contains(inReplyTo) { references.append(inReplyTo) }
            object["references"] = .array(references.map(JSONValue.string))
        }
        return .object(object)
    }

    private static func createdId(
        _ creationId: String,
        in args: JSONValue,
        what: String
    ) throws -> String {
        if let id = args["created"][creationId]["id"].stringValue {
            return id
        }
        let failure = args["notCreated"][creationId]
        throw JMAPError.methodError(
            type: failure["type"].stringValue ?? "serverFail",
            description: failure["description"].stringValue ?? "\(what) was not created"
        )
    }

    // MARK: - Send

    /// Create the message and submit it in one batched request. On success
    /// the server moves it from Drafts to Sent and clears `$draft`
    /// (`onSuccessUpdateEmail`). Returns the created email id.
    @discardableResult
    public func send(
        _ message: OutgoingMessage,
        identityId: String,
        draftsMailboxId: String,
        sentMailboxId: String
    ) async throws -> String {
        let accountId = try primaryAccountId()
        let emailObject = Self.emailObject(
            for: message,
            mailboxId: draftsMailboxId,
            keywords: ["$draft": true, "$seen": true]
        )
        let responses = try await call(
            [
                Invocation(
                    "Email/set",
                    ["accountId": .string(accountId), "create": ["draft": emailObject]],
                    "0"
                ),
                Invocation(
                    "EmailSubmission/set",
                    [
                        "accountId": .string(accountId),
                        "create": [
                            "submission": [
                                "emailId": "#draft",
                                "identityId": .string(identityId),
                            ]
                        ],
                        "onSuccessUpdateEmail": [
                            "#submission": .object([
                                "mailboxIds/\(draftsMailboxId)": .null,
                                "mailboxIds/\(sentMailboxId)": .bool(true),
                                "keywords/$draft": .null,
                            ])
                        ],
                    ],
                    "1"
                ),
            ],
            using: Self.submissionCapabilities
        )

        let emailArgs = try Self.arguments(for: "0", method: "Email/set", in: responses)
        let emailId = try Self.createdId("draft", in: emailArgs, what: "message")
        let submissionArgs = try Self.arguments(
            for: "1", method: "EmailSubmission/set", in: responses
        )
        _ = try Self.createdId("submission", in: submissionArgs, what: "submission")
        return emailId
    }

    // MARK: - Drafts

    /// Save a draft into the Drafts mailbox; returns the created email id.
    @discardableResult
    public func saveDraft(_ message: OutgoingMessage, draftsMailboxId: String) async throws -> String {
        let accountId = try primaryAccountId()
        let emailObject = Self.emailObject(
            for: message,
            mailboxId: draftsMailboxId,
            keywords: ["$draft": true, "$seen": true]
        )
        let responses = try await call([
            Invocation(
                "Email/set",
                ["accountId": .string(accountId), "create": ["draft": emailObject]],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Email/set", in: responses)
        return try Self.createdId("draft", in: args, what: "draft")
    }

    // MARK: - Move / delete

    /// Move messages to a mailbox (replacing their current placement —
    /// standard mail-client move semantics).
    public func moveEmails(ids: [String], toMailboxId: String) async throws {
        guard !ids.isEmpty else { return }
        let accountId = try primaryAccountId()
        var update: [String: JSONValue] = [:]
        for id in ids {
            update[id] = ["mailboxIds": .object([toMailboxId: .bool(true)])]
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

    /// Permanently destroy messages (used when deleting from Trash).
    public func destroyEmails(ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        let accountId = try primaryAccountId()
        let responses = try await call([
            Invocation(
                "Email/set",
                [
                    "accountId": .string(accountId),
                    "destroy": .array(ids.map(JSONValue.string)),
                ],
                "0"
            )
        ])
        let args = try Self.arguments(for: "0", method: "Email/set", in: responses)
        if let notDestroyed = args["notDestroyed"].objectValue, !notDestroyed.isEmpty {
            let firstError = notDestroyed.values.first
            throw JMAPError.methodError(
                type: firstError?["type"].stringValue ?? "serverFail",
                description: firstError?["description"].stringValue
            )
        }
    }
}
