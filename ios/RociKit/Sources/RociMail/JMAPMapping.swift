import Foundation
import RociModel

/// Maps raw JMAP JSON into RociModel types. Kept in one place so protocol
/// drift (server quirks, spec updates) has a single home.
enum JMAPMapping {
    // MARK: - Dates

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func date(from string: String?) -> Date? {
        guard let string else { return nil }
        return iso.date(from: string) ?? isoWithFraction.date(from: string)
    }

    // MARK: - Model mapping

    static func mailbox(from json: JSONValue, localAccountId: String) -> Mailbox? {
        guard let id = json["id"].stringValue, let name = json["name"].stringValue else {
            return nil
        }
        return Mailbox(
            id: id,
            accountId: localAccountId,
            parentId: json["parentId"].stringValue,
            name: name,
            role: json["role"].stringValue,
            sortOrder: json["sortOrder"].intValue ?? 0,
            totalEmails: json["totalEmails"].intValue ?? 0,
            unreadEmails: json["unreadEmails"].intValue ?? 0
        )
    }

    static func addresses(from json: JSONValue) -> [EmailAddress] {
        (json.arrayValue ?? []).compactMap { entry in
            guard let email = entry["email"].stringValue else { return nil }
            return EmailAddress(name: entry["name"].stringValue, email: email)
        }
    }

    static func header(from json: JSONValue, localAccountId: String) -> MessageHeader? {
        guard let id = json["id"].stringValue,
              let receivedAt = date(from: json["receivedAt"].stringValue)
        else {
            return nil
        }
        let keywords = json["keywords"].objectValue ?? [:]
        let mailboxIds = (json["mailboxIds"].objectValue ?? [:])
            .filter { $0.value.boolValue == true }
            .keys
            .sorted()
        return MessageHeader(
            id: id,
            accountId: localAccountId,
            blobId: json["blobId"].stringValue,
            threadId: json["threadId"].stringValue,
            mailboxIds: Array(mailboxIds),
            from: addresses(from: json["from"]),
            to: addresses(from: json["to"]),
            subject: json["subject"].stringValue,
            preview: json["preview"].stringValue,
            receivedAt: receivedAt,
            size: json["size"].intValue ?? 0,
            isSeen: keywords[MessageKeyword.seen]?.boolValue == true,
            isFlagged: keywords[MessageKeyword.flagged]?.boolValue == true,
            hasAttachment: json["hasAttachment"].boolValue ?? false
        )
    }

    static func detail(from json: JSONValue, localAccountId: String) -> MessageDetail? {
        guard let header = header(from: json, localAccountId: localAccountId) else { return nil }

        let bodyValues = json["bodyValues"].objectValue ?? [:]
        func bodyText(for parts: JSONValue) -> String? {
            for part in parts.arrayValue ?? [] {
                if let partId = part["partId"].stringValue,
                   let value = bodyValues[partId]?["value"].stringValue {
                    return value
                }
            }
            return nil
        }

        let attachments: [Attachment] = (json["attachments"].arrayValue ?? []).compactMap { entry in
            guard let blobId = entry["blobId"].stringValue else { return nil }
            let disposition = entry["disposition"].stringValue
            return Attachment(
                blobId: blobId,
                name: entry["name"].stringValue,
                type: entry["type"].stringValue ?? "application/octet-stream",
                size: entry["size"].intValue ?? 0,
                isInline: disposition == "inline" || !entry["cid"].isNull,
                cid: entry["cid"].stringValue
            )
        }

        return MessageDetail(
            header: header,
            cc: addresses(from: json["cc"]),
            replyTo: addresses(from: json["replyTo"]),
            htmlBody: bodyText(for: json["htmlBody"]),
            textBody: bodyText(for: json["textBody"]),
            attachments: attachments,
            rfcMessageIds: json["messageId"].stringArray ?? [],
            rfcReferences: json["references"].stringArray ?? []
        )
    }

    static func changeSet(from json: JSONValue) -> ChangeSet {
        ChangeSet(
            created: json["created"].stringArray ?? [],
            updated: json["updated"].stringArray ?? [],
            destroyed: json["destroyed"].stringArray ?? [],
            newState: json["newState"].stringValue ?? "",
            hasMoreChanges: json["hasMoreChanges"].boolValue ?? false
        )
    }
}
