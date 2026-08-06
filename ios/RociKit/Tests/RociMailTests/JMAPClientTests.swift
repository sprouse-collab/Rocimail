import Foundation
import XCTest
@testable import RociMail
import RociModel

/// Intercepts URLSession traffic so the JMAP client can be tested against
/// canned server responses (Stalwart-shaped fixtures).
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    /// Body of the most recent request (URLSession moves httpBody into a
    /// stream by the time URLProtocol sees it).
    nonisolated(unsafe) static var lastRequestBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static func drainBody(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 16_384
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        do {
            Self.lastRequestBody = Self.drainBody(of: request)
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class JMAPClientTests: XCTestCase {
    private var client: JMAPClient!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        client = JMAPClient(urlSession: URLSession(configuration: config))
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.lastRequestBody = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    static let sessionFixture = """
        {
          "capabilities": {
            "urn:ietf:params:jmap:core": {"maxSizeUpload": 50000000},
            "urn:ietf:params:jmap:mail": {}
          },
          "accounts": {
            "a01": {"name": "user@example.com", "isPersonal": true, "isReadOnly": false}
          },
          "primaryAccounts": {"urn:ietf:params:jmap:mail": "a01"},
          "username": "user@example.com",
          "apiUrl": "https://mail.example.com/jmap/",
          "downloadUrl": "https://mail.example.com/download/{accountId}/{blobId}/{name}?accept={type}",
          "uploadUrl": "https://mail.example.com/upload/{accountId}/",
          "eventSourceUrl": "https://mail.example.com/eventsource/",
          "state": "s-1"
        }
        """

    private func connect() async throws {
        MockURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            XCTAssertTrue(path.contains(".well-known/jmap"), "unexpected path \(path)")
            XCTAssertNotNil(
                request.value(forHTTPHeaderField: "Authorization"),
                "discovery must send Basic auth"
            )
            return (200, Data(Self.sessionFixture.utf8))
        }
        try await client.connect(
            server: URL(string: "https://mail.example.com")!,
            username: "user@example.com",
            password: "secret"
        )
    }

    private func respond(method: String, result: String) {
        MockURLProtocol.handler = { _ in
            let body = """
                {"methodResponses": [["\(method)", \(result), "0"]], "sessionState": "s-1"}
                """
            return (200, Data(body.utf8))
        }
    }

    // MARK: - Session discovery

    func testConnectParsesSession() async throws {
        try await connect()
        let session = await client.session
        XCTAssertEqual(session?.username, "user@example.com")
        XCTAssertEqual(session?.primaryMailAccountId, "a01")
        XCTAssertEqual(session?.apiUrl.absoluteString, "https://mail.example.com/jmap/")
        XCTAssertTrue(session?.capabilities.contains(JMAPSession.mailCapability) ?? false)
    }

    func testConnectRejectsBadCredentials() async {
        MockURLProtocol.handler = { _ in (401, Data()) }
        do {
            try await client.connect(
                server: URL(string: "https://mail.example.com")!,
                username: "user@example.com",
                password: "wrong"
            )
            XCTFail("expected an error")
        } catch let error as JMAPError {
            XCTAssertTrue(error.isAuthFailure)
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }

    func testDownloadURLTemplateExpansion() async throws {
        try await connect()
        let session = await client.session
        let url = session?.downloadURL(
            accountId: "a01", blobId: "b/1", type: "application/pdf", name: "report 2026.pdf"
        )
        let string = try XCTUnwrap(url?.absoluteString)
        XCTAssertTrue(string.contains("/download/a01/b%2F1/report%202026%2Epdf"))
        XCTAssertTrue(string.contains("accept=application%2Fpdf"))
    }

    // MARK: - Mailboxes

    func testMailboxesParsing() async throws {
        try await connect()
        respond(
            method: "Mailbox/get",
            result: """
                {"accountId": "a01", "state": "mb-1", "list": [
                  {"id": "inbox1", "name": "Inbox", "role": "inbox", "sortOrder": 1,
                   "totalEmails": 42, "unreadEmails": 7, "parentId": null},
                  {"id": "sub1", "name": "Receipts", "parentId": "inbox1", "sortOrder": 2,
                   "totalEmails": 5, "unreadEmails": 0}
                ]}
                """
        )
        let mailboxes = try await client.mailboxes(localAccountId: "local")
        XCTAssertEqual(mailboxes.count, 2)
        XCTAssertEqual(mailboxes[0].role, "inbox")
        XCTAssertEqual(mailboxes[0].unreadEmails, 7)
        XCTAssertEqual(mailboxes[1].parentId, "inbox1")
        XCTAssertEqual(mailboxes[1].accountId, "local")
    }

    // MARK: - Query + fetch

    func testQueryEmails() async throws {
        try await connect()
        respond(
            method: "Email/query",
            result: """
                {"accountId": "a01", "queryState": "q-1", "canCalculateChanges": true,
                 "position": 0, "total": 2, "ids": ["m1", "m2"]}
                """
        )
        let page = try await client.queryEmails(inMailbox: "inbox1", limit: 10)
        XCTAssertEqual(page.ids, ["m1", "m2"])
        XCTAssertEqual(page.total, 2)
        XCTAssertEqual(page.queryState, "q-1")
    }

    func testEmailHeadersParsing() async throws {
        try await connect()
        respond(
            method: "Email/get",
            result: """
                {"accountId": "a01", "state": "e-1", "list": [{
                  "id": "m1", "blobId": "blob1", "threadId": "t1",
                  "mailboxIds": {"inbox1": true},
                  "keywords": {"$seen": true},
                  "from": [{"name": "Alice", "email": "alice@example.com"}],
                  "to": [{"name": null, "email": "user@example.com"}],
                  "subject": "Quarterly report",
                  "receivedAt": "2026-03-14T09:26:53Z",
                  "size": 2048, "preview": "Please find attached…",
                  "hasAttachment": true
                }]}
                """
        )
        let headers = try await client.emailHeaders(ids: ["m1"], localAccountId: "local")
        XCTAssertEqual(headers.count, 1)
        let header = headers[0]
        XCTAssertEqual(header.subject, "Quarterly report")
        XCTAssertEqual(header.from.first?.displayName, "Alice")
        XCTAssertEqual(header.mailboxIds, ["inbox1"])
        XCTAssertTrue(header.isSeen)
        XCTAssertFalse(header.isFlagged)
        XCTAssertTrue(header.hasAttachment)
        XCTAssertEqual(header.accountId, "local")
    }

    func testEmailDetailBodyExtraction() async throws {
        try await connect()
        respond(
            method: "Email/get",
            result: """
                {"accountId": "a01", "state": "e-1", "list": [{
                  "id": "m1", "mailboxIds": {"inbox1": true}, "keywords": {},
                  "from": [{"email": "alice@example.com"}], "to": [],
                  "subject": "Hi", "receivedAt": "2026-03-14T09:26:53Z", "size": 100,
                  "bodyValues": {
                    "p1": {"value": "<p>Hello <b>world</b></p>", "isTruncated": false},
                    "p2": {"value": "Hello world", "isTruncated": false}
                  },
                  "htmlBody": [{"partId": "p1", "blobId": "bp1", "type": "text/html"}],
                  "textBody": [{"partId": "p2", "blobId": "bp2", "type": "text/plain"}],
                  "attachments": [{"blobId": "att1", "name": "a.pdf",
                                   "type": "application/pdf", "size": 999,
                                   "disposition": "attachment", "cid": null}]
                }]}
                """
        )
        let detail = try await client.emailDetail(id: "m1", localAccountId: "local")
        XCTAssertEqual(detail.htmlBody, "<p>Hello <b>world</b></p>")
        XCTAssertEqual(detail.textBody, "Hello world")
        XCTAssertEqual(detail.attachments.count, 1)
        XCTAssertEqual(detail.attachments[0].name, "a.pdf")
        XCTAssertFalse(detail.attachments[0].isInline)
    }

    // MARK: - Deltas & errors

    func testEmailChanges() async throws {
        try await connect()
        respond(
            method: "Email/changes",
            result: """
                {"accountId": "a01", "oldState": "e-1", "newState": "e-2",
                 "hasMoreChanges": false,
                 "created": ["m3"], "updated": ["m1"], "destroyed": ["m0"]}
                """
        )
        let changes = try await client.emailChanges(since: "e-1")
        XCTAssertEqual(changes.created, ["m3"])
        XCTAssertEqual(changes.updated, ["m1"])
        XCTAssertEqual(changes.destroyed, ["m0"])
        XCTAssertEqual(changes.newState, "e-2")
    }

    func testCannotCalculateChangesIsTyped() async throws {
        try await connect()
        respond(
            method: "error",
            result: """
                {"type": "cannotCalculateChanges", "description": "state too old"}
                """
        )
        do {
            _ = try await client.emailChanges(since: "ancient")
            XCTFail("expected an error")
        } catch JMAPError.cannotCalculateChanges {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - Submission (M1)

    func testIdentitiesParsing() async throws {
        try await connect()
        respond(
            method: "Identity/get",
            result: """
                {"accountId": "a01", "state": "i-1", "list": [
                  {"id": "ident1", "name": "Uwe Ser", "email": "user@example.com"},
                  {"id": "ident2", "name": "", "email": "alias@example.com"}
                ]}
                """
        )
        let identities = try await client.identities()
        XCTAssertEqual(identities.map(\.id), ["ident1", "ident2"])
        XCTAssertEqual(identities[0].email, "user@example.com")
    }

    func testSendBatchesCreateAndSubmission() async throws {
        try await connect()
        MockURLProtocol.handler = { _ in
            let body = """
                {"methodResponses": [
                  ["Email/set", {"accountId": "a01",
                    "created": {"draft": {"id": "e99", "blobId": "b99"}}}, "0"],
                  ["EmailSubmission/set", {"accountId": "a01",
                    "created": {"submission": {"id": "s99"}}}, "1"]
                ], "sessionState": "s-1"}
                """
            return (200, Data(body.utf8))
        }

        let message = OutgoingMessage(
            to: [EmailAddress(name: "Bob", email: "bob@example.com")],
            subject: "Hello",
            textBody: "Hi Bob",
            inReplyTo: "<orig@example.com>"
        )
        let emailId = try await client.send(
            message, identityId: "ident1", draftsMailboxId: "drafts1", sentMailboxId: "sent1"
        )
        XCTAssertEqual(emailId, "e99")

        // The request must batch Email/set + EmailSubmission/set with a
        // back-reference and the move-to-Sent on success.
        let bodyData = try XCTUnwrap(MockURLProtocol.lastRequestBody)
        let request = try JSONDecoder().decode(JSONValue.self, from: bodyData)
        let calls = try XCTUnwrap(request["methodCalls"].arrayValue)
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0][0].stringValue, "Email/set")
        XCTAssertEqual(calls[1][0].stringValue, "EmailSubmission/set")
        XCTAssertEqual(
            calls[1][1]["create"]["submission"]["emailId"].stringValue, "#draft"
        )
        let onSuccess = calls[1][1]["onSuccessUpdateEmail"]["#submission"]
        XCTAssertEqual(onSuccess["mailboxIds/sent1"].boolValue, true)
        XCTAssertTrue(onSuccess["mailboxIds/drafts1"].isNull)
        // Reply threading headers made it into the created email:
        let created = calls[0][1]["create"]["draft"]
        XCTAssertEqual(created["inReplyTo"][0].stringValue, "<orig@example.com>")
        XCTAssertEqual(created["references"][0].stringValue, "<orig@example.com>")
        // Submission capability is negotiated:
        XCTAssertTrue(
            (request["using"].stringArray ?? []).contains("urn:ietf:params:jmap:submission")
        )
    }

    func testSendSurfacesNotCreated() async throws {
        try await connect()
        MockURLProtocol.handler = { _ in
            let body = """
                {"methodResponses": [
                  ["Email/set", {"accountId": "a01", "created": {},
                    "notCreated": {"draft": {"type": "invalidProperties",
                                             "description": "no recipients"}}}, "0"],
                  ["EmailSubmission/set", {"accountId": "a01", "created": {}}, "1"]
                ], "sessionState": "s-1"}
                """
            return (200, Data(body.utf8))
        }
        do {
            _ = try await client.send(
                OutgoingMessage(subject: "x", textBody: "y"),
                identityId: "ident1", draftsMailboxId: "d", sentMailboxId: "s"
            )
            XCTFail("expected an error")
        } catch JMAPError.methodError(let type, let description) {
            XCTAssertEqual(type, "invalidProperties")
            XCTAssertEqual(description, "no recipients")
        }
    }

    func testMoveEmails() async throws {
        try await connect()
        respond(
            method: "Email/set",
            result: """
                {"accountId": "a01", "updated": {"m1": null, "m2": null}}
                """
        )
        try await client.moveEmails(ids: ["m1", "m2"], toMailboxId: "archive1")

        let bodyData = try XCTUnwrap(MockURLProtocol.lastRequestBody)
        let request = try JSONDecoder().decode(JSONValue.self, from: bodyData)
        let update = request["methodCalls"][0][1]["update"]
        XCTAssertEqual(update["m1"]["mailboxIds"]["archive1"].boolValue, true)
        XCTAssertEqual(update["m2"]["mailboxIds"]["archive1"].boolValue, true)
    }

    func testMoveEmailsSurfacesNotUpdated() async throws {
        try await connect()
        respond(
            method: "Email/set",
            result: """
                {"accountId": "a01", "updated": {},
                 "notUpdated": {"m1": {"type": "notFound"}}}
                """
        )
        do {
            try await client.moveEmails(ids: ["m1"], toMailboxId: "archive1")
            XCTFail("expected an error")
        } catch JMAPError.methodError(let type, _) {
            XCTAssertEqual(type, "notFound")
        }
    }

    func testMethodErrorSurfaces() async throws {
        try await connect()
        respond(
            method: "error",
            result: """
                {"type": "invalidArguments", "description": "bad filter"}
                """
        )
        do {
            _ = try await client.queryEmails(inMailbox: "nope", limit: 10)
            XCTFail("expected an error")
        } catch JMAPError.methodError(let type, let description) {
            XCTAssertEqual(type, "invalidArguments")
            XCTAssertEqual(description, "bad filter")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

final class JSONValueTests: XCTestCase {
    func testRoundTrip() throws {
        let value: JSONValue = [
            "string": "hello",
            "int": 42,
            "double": 1.5,
            "bool": true,
            "null": nil,
            "array": [1, "two", false],
            "nested": ["a": ["b": "c"]],
        ]
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded["string"].stringValue, "hello")
        XCTAssertEqual(decoded["int"].intValue, 42)
        XCTAssertEqual(decoded["double"].doubleValue, 1.5)
        XCTAssertEqual(decoded["bool"].boolValue, true)
        XCTAssertTrue(decoded["null"].isNull)
        XCTAssertEqual(decoded["array"][1].stringValue, "two")
        XCTAssertEqual(decoded["nested"]["a"]["b"].stringValue, "c")
    }

    func testIntegersEncodeWithoutDecimalPoint() throws {
        let data = try JSONEncoder().encode(JSONValue.number(42))
        XCTAssertEqual(String(data: data, encoding: .utf8), "42")
    }

    func testInvocationTripleEncoding() throws {
        let invocation = Invocation("Email/get", ["accountId": "a01"], "c0")
        let data = try JSONEncoder().encode(invocation)
        let decoded = try JSONDecoder().decode(Invocation.self, from: data)
        XCTAssertEqual(decoded.name, "Email/get")
        XCTAssertEqual(decoded.callId, "c0")
        XCTAssertEqual(decoded.arguments["accountId"].stringValue, "a01")
    }
}
