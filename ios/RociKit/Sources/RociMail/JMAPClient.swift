import Foundation
import RociModel

/// One JMAP method invocation: `[name, arguments, callId]`.
public struct Invocation: Sendable, Hashable {
    public var name: String
    public var arguments: JSONValue
    public var callId: String

    public init(_ name: String, _ arguments: JSONValue, _ callId: String) {
        self.name = name
        self.arguments = arguments
        self.callId = callId
    }
}

extension Invocation: Codable {
    public init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        name = try container.decode(String.self)
        arguments = try container.decode(JSONValue.self)
        callId = try container.decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(name)
        try container.encode(arguments)
        try container.encode(callId)
    }
}

/// JMAP client (RFC 8620/8621) over URLSession. One instance per signed-in
/// endpoint. All mail accounts in Rocimail are JMAP endpoints — the VPS
/// server, the QNAP archive, and (M5) the IMAP gateway.
public actor JMAPClient {
    private let urlSession: URLSession
    private var authorizationHeader: String?
    public private(set) var session: JMAPSession?

    private struct RequestBody: Encodable {
        var using: [String]
        var methodCalls: [Invocation]
    }

    private struct ResponseBody: Decodable {
        var methodResponses: [Invocation]
        var sessionState: String?
    }

    public init(urlSession: URLSession = .shared) {
        self.urlSession = urlSession
    }

    // MARK: - Session discovery & auth

    /// Sign in: resolve the session resource from a server base URL (or a full
    /// session URL) using HTTP Basic auth, mirroring the web app's login flow.
    @discardableResult
    public func connect(server: URL, username: String, password: String) async throws -> JMAPSession {
        let token = Data("\(username):\(password)".utf8).base64EncodedString()
        authorizationHeader = "Basic \(token)"

        var candidates: [URL] = []
        if server.path.contains(".well-known/jmap") || server.path.contains("/jmap") {
            candidates.append(server)
        } else {
            candidates.append(server.appendingPathComponent(".well-known/jmap"))
        }

        var lastError: Error = JMAPError.discoveryFailed(server.absoluteString)
        for url in candidates {
            do {
                let json = try await getJSON(url: url)
                let session = try JMAPSession(json: json, relativeTo: url)
                self.session = session
                return session
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    /// Adopt an existing session (e.g. restored after relaunch alongside
    /// credentials from the Keychain).
    public func adopt(session: JMAPSession, username: String, password: String) {
        let token = Data("\(username):\(password)".utf8).base64EncodedString()
        authorizationHeader = "Basic \(token)"
        self.session = session
    }

    // MARK: - Core request engine

    /// Execute a batch of method calls and return the method responses.
    public func call(
        _ invocations: [Invocation],
        using capabilities: [String] = [JMAPSession.coreCapability, JMAPSession.mailCapability]
    ) async throws -> [Invocation] {
        guard let session else { throw JMAPError.discoveryFailed("not connected") }

        var request = URLRequest(url: session.apiUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authorizationHeader {
            request.setValue(authorizationHeader, forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try JSONEncoder().encode(
            RequestBody(using: capabilities, methodCalls: invocations)
        )

        let (data, response) = try await urlSession.data(for: request)
        try Self.checkHTTP(response)

        let decoded: ResponseBody
        do {
            decoded = try JSONDecoder().decode(ResponseBody.self, from: data)
        } catch {
            throw JMAPError.malformedResponse("could not decode method responses: \(error)")
        }
        return decoded.methodResponses
    }

    /// Return the response arguments for a given call id, surfacing JMAP
    /// method-level errors as thrown `JMAPError`s.
    static func arguments(
        for callId: String,
        method: String,
        in responses: [Invocation]
    ) throws -> JSONValue {
        for response in responses where response.callId == callId {
            if response.name == "error" {
                let type = response.arguments["type"].stringValue ?? "unknown"
                if type == "cannotCalculateChanges" { throw JMAPError.cannotCalculateChanges }
                throw JMAPError.methodError(
                    type: type,
                    description: response.arguments["description"].stringValue
                )
            }
            if response.name == method {
                return response.arguments
            }
        }
        throw JMAPError.malformedResponse("no response for call \(callId) (\(method))")
    }

    private func getJSON(url: URL) async throws -> JSONValue {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authorizationHeader {
            request.setValue(authorizationHeader, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await urlSession.data(for: request)
        try Self.checkHTTP(response)
        do {
            return try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw JMAPError.malformedResponse("not a JSON document")
        }
    }

    private static func checkHTTP(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw JMAPError.httpError(status: http.statusCode)
        }
    }

    // MARK: - Blob download

    public func downloadBlob(
        accountId: String,
        blobId: String,
        type: String = "application/octet-stream",
        name: String = "blob"
    ) async throws -> Data {
        guard let session,
              let url = session.downloadURL(accountId: accountId, blobId: blobId, type: type, name: name)
        else {
            throw JMAPError.discoveryFailed("not connected")
        }
        var request = URLRequest(url: url)
        if let authorizationHeader {
            request.setValue(authorizationHeader, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await urlSession.data(for: request)
        try Self.checkHTTP(response)
        return data
    }
}
