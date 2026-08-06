import Foundation

/// A connected account. In v1 every mail account is a JMAP endpoint
/// (VPS Stalwart, QNAP archive, or — later, M5 — the IMAP gateway).
public struct Account: Codable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case jmap
        case jmapArchive // read-only archive endpoint (no compose identity)
    }

    public var id: String
    public var kind: Kind
    public var serverURL: URL
    public var username: String
    public var displayName: String
    public var jmapAccountId: String

    public init(
        id: String,
        kind: Kind,
        serverURL: URL,
        username: String,
        displayName: String,
        jmapAccountId: String
    ) {
        self.id = id
        self.kind = kind
        self.serverURL = serverURL
        self.username = username
        self.displayName = displayName
        self.jmapAccountId = jmapAccountId
    }

    public var isReadOnly: Bool { kind == .jmapArchive }
}

/// A mail folder. `role` carries JMAP special-use semantics
/// (inbox, sent, trash, drafts, junk, archive).
public struct Mailbox: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var accountId: String
    public var parentId: String?
    public var name: String
    public var role: String?
    public var sortOrder: Int
    public var totalEmails: Int
    public var unreadEmails: Int

    public init(
        id: String,
        accountId: String,
        parentId: String? = nil,
        name: String,
        role: String? = nil,
        sortOrder: Int = 0,
        totalEmails: Int = 0,
        unreadEmails: Int = 0
    ) {
        self.id = id
        self.accountId = accountId
        self.parentId = parentId
        self.name = name
        self.role = role
        self.sortOrder = sortOrder
        self.totalEmails = totalEmails
        self.unreadEmails = unreadEmails
    }
}

public struct EmailAddress: Codable, Hashable, Sendable {
    public var name: String?
    public var email: String

    public init(name: String? = nil, email: String) {
        self.name = name
        self.email = email
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return email
    }
}

/// JMAP keywords the app cares about. Raw JMAP uses `$seen`/`$flagged` etc.
public enum MessageKeyword {
    public static let seen = "$seen"
    public static let flagged = "$flagged"
    public static let draft = "$draft"
    public static let answered = "$answered"
}

/// Envelope-level message data — what the message list renders.
public struct MessageHeader: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var accountId: String
    public var blobId: String?
    public var threadId: String?
    public var mailboxIds: [String]
    public var from: [EmailAddress]
    public var to: [EmailAddress]
    public var subject: String?
    public var preview: String?
    public var receivedAt: Date
    public var size: Int
    public var isSeen: Bool
    public var isFlagged: Bool
    public var hasAttachment: Bool

    public init(
        id: String,
        accountId: String,
        blobId: String? = nil,
        threadId: String? = nil,
        mailboxIds: [String] = [],
        from: [EmailAddress] = [],
        to: [EmailAddress] = [],
        subject: String? = nil,
        preview: String? = nil,
        receivedAt: Date,
        size: Int = 0,
        isSeen: Bool = false,
        isFlagged: Bool = false,
        hasAttachment: Bool = false
    ) {
        self.id = id
        self.accountId = accountId
        self.blobId = blobId
        self.threadId = threadId
        self.mailboxIds = mailboxIds
        self.from = from
        self.to = to
        self.subject = subject
        self.preview = preview
        self.receivedAt = receivedAt
        self.size = size
        self.isSeen = isSeen
        self.isFlagged = isFlagged
        self.hasAttachment = hasAttachment
    }
}

public struct Attachment: Codable, Hashable, Identifiable, Sendable {
    public var blobId: String
    public var name: String?
    public var type: String
    public var size: Int
    public var isInline: Bool
    public var cid: String?

    public var id: String { blobId }

    public init(
        blobId: String,
        name: String? = nil,
        type: String,
        size: Int = 0,
        isInline: Bool = false,
        cid: String? = nil
    ) {
        self.blobId = blobId
        self.name = name
        self.type = type
        self.size = size
        self.isInline = isInline
        self.cid = cid
    }
}

/// Full message content — what the reader renders.
public struct MessageDetail: Codable, Hashable, Sendable {
    public var header: MessageHeader
    public var cc: [EmailAddress]
    public var replyTo: [EmailAddress]
    public var htmlBody: String?
    public var textBody: String?
    public var attachments: [Attachment]
    /// RFC 5322 Message-ID(s) of this message, for reply threading.
    public var rfcMessageIds: [String]
    /// RFC 5322 References of this message, carried into replies.
    public var rfcReferences: [String]

    public init(
        header: MessageHeader,
        cc: [EmailAddress] = [],
        replyTo: [EmailAddress] = [],
        htmlBody: String? = nil,
        textBody: String? = nil,
        attachments: [Attachment] = [],
        rfcMessageIds: [String] = [],
        rfcReferences: [String] = []
    ) {
        self.header = header
        self.cc = cc
        self.replyTo = replyTo
        self.htmlBody = htmlBody
        self.textBody = textBody
        self.attachments = attachments
        self.rfcMessageIds = rfcMessageIds
        self.rfcReferences = rfcReferences
    }
}

/// Result of a `Foo/changes` delta call, protocol-agnostic.
public struct ChangeSet: Codable, Hashable, Sendable {
    public var created: [String]
    public var updated: [String]
    public var destroyed: [String]
    public var newState: String
    public var hasMoreChanges: Bool

    public init(
        created: [String] = [],
        updated: [String] = [],
        destroyed: [String] = [],
        newState: String,
        hasMoreChanges: Bool = false
    ) {
        self.created = created
        self.updated = updated
        self.destroyed = destroyed
        self.newState = newState
        self.hasMoreChanges = hasMoreChanges
    }
}

/// A sending identity (JMAP Identity object) — the From addresses the
/// server permits.
public struct Identity: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var email: String

    public init(id: String, name: String, email: String) {
        self.id = id
        self.name = name
        self.email = email
    }
}

/// A message being composed: new, reply, or forward. Plain-text body in M1;
/// rich text arrives with the M1 composer polish.
public struct OutgoingMessage: Codable, Hashable, Sendable {
    public var identityId: String?
    public var from: EmailAddress?
    public var to: [EmailAddress]
    public var cc: [EmailAddress]
    public var bcc: [EmailAddress]
    public var subject: String
    public var textBody: String
    /// RFC 5322 Message-IDs for reply threading.
    public var inReplyTo: String?
    public var references: [String]

    public init(
        identityId: String? = nil,
        from: EmailAddress? = nil,
        to: [EmailAddress] = [],
        cc: [EmailAddress] = [],
        bcc: [EmailAddress] = [],
        subject: String = "",
        textBody: String = "",
        inReplyTo: String? = nil,
        references: [String] = []
    ) {
        self.identityId = identityId
        self.from = from
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.subject = subject
        self.textBody = textBody
        self.inReplyTo = inReplyTo
        self.references = references
    }
}

/// A conversation row for the message list: the newest message plus counts.
public struct ThreadSummary: Hashable, Identifiable, Sendable {
    public var latest: MessageHeader
    public var messageCount: Int
    public var unreadCount: Int

    public var id: String { latest.threadId ?? latest.id }

    public init(latest: MessageHeader, messageCount: Int, unreadCount: Int) {
        self.latest = latest
        self.messageCount = messageCount
        self.unreadCount = unreadCount
    }
}
