import Foundation

/// The JMAP session object (RFC 8620 §2) — the entry point every other call
/// hangs off. Fetched from `<server>/.well-known/jmap` (or a full session URL).
public struct JMAPSession: Sendable, Hashable {
    public struct SessionAccount: Sendable, Hashable {
        public var name: String
        public var isPersonal: Bool
        public var isReadOnly: Bool
    }

    public var username: String
    public var apiUrl: URL
    public var downloadUrl: String // URI template: {accountId} {blobId} {name} {type}
    public var uploadUrl: String // URI template: {accountId}
    public var eventSourceUrl: String?
    public var accounts: [String: SessionAccount]
    public var primaryMailAccountId: String?
    public var capabilities: Set<String>
    public var state: String?

    public static let mailCapability = "urn:ietf:params:jmap:mail"
    public static let submissionCapability = "urn:ietf:params:jmap:submission"
    public static let coreCapability = "urn:ietf:params:jmap:core"

    /// Parse from the raw session JSON. Throws if required members are missing.
    public init(json: JSONValue, relativeTo baseURL: URL) throws {
        guard let apiUrlString = json["apiUrl"].stringValue,
              let apiUrl = URL(string: apiUrlString, relativeTo: baseURL)?.absoluteURL
        else {
            throw JMAPError.malformedResponse("session is missing apiUrl")
        }
        guard let downloadUrl = json["downloadUrl"].stringValue else {
            throw JMAPError.malformedResponse("session is missing downloadUrl")
        }

        self.username = json["username"].stringValue ?? ""
        self.apiUrl = apiUrl
        self.downloadUrl = Self.absolutize(template: downloadUrl, relativeTo: baseURL)
        self.uploadUrl = Self.absolutize(
            template: json["uploadUrl"].stringValue ?? "",
            relativeTo: baseURL
        )
        self.eventSourceUrl = json["eventSourceUrl"].stringValue
        self.state = json["state"].stringValue
        self.capabilities = Set(json["capabilities"].objectValue?.keys.map { $0 } ?? [])

        var accounts: [String: SessionAccount] = [:]
        for (id, value) in json["accounts"].objectValue ?? [:] {
            accounts[id] = SessionAccount(
                name: value["name"].stringValue ?? id,
                isPersonal: value["isPersonal"].boolValue ?? true,
                isReadOnly: value["isReadOnly"].boolValue ?? false
            )
        }
        self.accounts = accounts
        self.primaryMailAccountId =
            json["primaryAccounts"][Self.mailCapability].stringValue
            ?? accounts.keys.first
    }

    /// URI templates in a session may be relative; resolve against the origin.
    private static func absolutize(template: String, relativeTo baseURL: URL) -> String {
        guard !template.isEmpty, !template.lowercased().hasPrefix("http") else { return template }
        var components = URLComponents()
        components.scheme = baseURL.scheme
        components.host = baseURL.host
        components.port = baseURL.port
        let origin = components.url?.absoluteString ?? ""
        return origin + (template.hasPrefix("/") ? "" : "/") + template
    }

    /// Expand the RFC 6570 level-1 style download template used by JMAP.
    public func downloadURL(accountId: String, blobId: String, type: String, name: String) -> URL? {
        func encode(_ value: String) -> String {
            value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
        }
        let expanded = downloadUrl
            .replacingOccurrences(of: "{accountId}", with: encode(accountId))
            .replacingOccurrences(of: "{blobId}", with: encode(blobId))
            .replacingOccurrences(of: "{type}", with: encode(type))
            .replacingOccurrences(of: "{name}", with: encode(name))
        return URL(string: expanded)
    }
}

public enum JMAPError: Error, Hashable, Sendable {
    /// HTTP-level failure (auth rejected, server error, …).
    case httpError(status: Int)
    /// Response was not valid JMAP.
    case malformedResponse(String)
    /// A method-level error response (`["error", {...}, id]`).
    case methodError(type: String, description: String?)
    /// Session discovery could not find a JMAP server at the URL.
    case discoveryFailed(String)
    /// The server can no longer compute deltas from our saved state;
    /// caller must fall back to a windowed refetch.
    case cannotCalculateChanges

    public var isAuthFailure: Bool {
        if case .httpError(let status) = self { return status == 401 || status == 403 }
        return false
    }
}
