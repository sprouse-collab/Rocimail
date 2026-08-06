import Foundation
import Observation
import RociMail
import RociModel
import RociSearch
import RociStore
import RociSync

/// App-level state. Views read this and the local store; all network work
/// funnels through the sync engine.
@MainActor
@Observable
final class AppModel {
    struct Session {
        var account: Account
        var client: JMAPClient
        var engine: SyncEngine
    }

    private(set) var store: MailStore?
    private(set) var session: Session?

    var mailboxes: [Mailbox] = []
    var isBusy = false
    var errorMessage: String?

    var isSignedIn: Bool { session != nil }

    // MARK: - Store

    private func openStore() throws -> MailStore {
        if let store { return store }
        let directory = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        // TODO(T1.3): move to SQLCipher; interim protection is iOS file-level
        // Data Protection on the app container.
        let store = try MailStore(path: directory.appendingPathComponent("rocimail.sqlite").path)
        self.store = store
        return store
    }

    // MARK: - Sign in / out

    /// JMAP session discovery + sign-in, mirroring the web client's flow.
    func signIn(server: String, email: String, password: String) async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }

        var serverText = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if !serverText.lowercased().hasPrefix("http") {
            serverText = "https://" + serverText
        }
        guard let serverURL = URL(string: serverText), serverURL.host != nil else {
            errorMessage = "Enter a valid server URL."
            return
        }

        do {
            let store = try openStore()
            let client = JMAPClient()
            let jmapSession = try await client.connect(
                server: serverURL, username: email, password: password
            )

            let account = Account(
                id: "\(serverURL.host ?? "server")|\(email)",
                kind: .jmap,
                serverURL: serverURL,
                username: email,
                displayName: email,
                jmapAccountId: jmapSession.primaryMailAccountId ?? ""
            )
            try store.saveAccount(account)
            // TODO(T2.1): persist credentials in the Keychain and restore the
            // session on relaunch. v0 signs in per launch.

            let engine = SyncEngine(account: account, transport: client, store: store)
            session = Session(account: account, client: client, engine: engine)

            try await engine.initialSync()
            mailboxes = try store.mailboxes(accountId: account.id)
        } catch let error as JMAPError where error.isAuthFailure {
            errorMessage = "Sign-in failed — check your email and password."
        } catch {
            errorMessage = "Could not reach a JMAP server at that URL. (\(shortDescription(of: error)))"
        }
    }

    func signOut() {
        guard let session else { return }
        try? store?.deleteAccount(id: session.account.id)
        self.session = nil
        mailboxes = []
    }

    // MARK: - Data access for views

    func refresh() async {
        guard let session, let store else { return }
        do {
            try await session.engine.refresh()
            await session.engine.replayOutbox()
            mailboxes = try store.mailboxes(accountId: session.account.id)
        } catch {
            errorMessage = "Refresh failed. (\(shortDescription(of: error)))"
        }
    }

    /// Cached messages for a mailbox; triggers a backfill when empty.
    func messages(in mailbox: Mailbox) -> [MessageHeader] {
        guard let session, let store else { return [] }
        return (try? store.messages(
            accountId: session.account.id, mailboxId: mailbox.id, limit: 200
        )) ?? []
    }

    func backfill(mailbox: Mailbox) async {
        guard let session else { return }
        try? await session.engine.backfill(mailboxId: mailbox.id)
    }

    func loadDetail(messageId: String) async -> MessageDetail? {
        guard let session else { return nil }
        do {
            let detail = try await session.engine.loadDetail(messageId: messageId)
            if !detail.header.isSeen {
                await session.engine.setSeen(true, messageId: messageId)
            }
            return detail
        } catch {
            errorMessage = "Could not load the message. (\(shortDescription(of: error)))"
            return nil
        }
    }

    func toggleFlag(message: MessageHeader) async {
        guard let session else { return }
        await session.engine.setFlagged(!message.isFlagged, messageId: message.id)
    }

    // MARK: - Threads

    func threads(in mailbox: Mailbox) -> [ThreadSummary] {
        guard let session, let store else { return [] }
        return (try? store.threadSummaries(
            accountId: session.account.id, mailboxId: mailbox.id, limit: 100
        )) ?? []
    }

    func messagesInThread(_ summary: ThreadSummary) -> [MessageHeader] {
        guard let session, let store else { return [summary.latest] }
        guard let threadId = summary.latest.threadId else { return [summary.latest] }
        let members = (try? store.messagesInThread(
            threadId: threadId, accountId: session.account.id
        )) ?? []
        return members.isEmpty ? [summary.latest] : members
    }

    // MARK: - Compose & send

    enum SendResult {
        case success
        case failure(String)
    }

    func send(
        to: String,
        cc: String,
        subject: String,
        body: String,
        inReplyTo: String?,
        references: [String]
    ) async -> SendResult {
        guard let session else { return .failure("Not signed in.") }

        let toAddresses = Self.parseAddresses(to)
        guard !toAddresses.isEmpty else {
            return .failure("Enter at least one valid To address.")
        }

        do {
            let identities = try await session.engine.identities()
            guard let identity = identities.first else {
                return .failure("The server offers no sending identity for this account.")
            }
            let message = OutgoingMessage(
                identityId: identity.id,
                from: EmailAddress(name: identity.name, email: identity.email),
                to: toAddresses,
                cc: Self.parseAddresses(cc),
                subject: subject,
                textBody: body,
                inReplyTo: inReplyTo,
                references: references
            )
            let outcome = try await session.engine.send(message)
            if case .queued = outcome {
                errorMessage = "You're offline — the message is queued and will send automatically."
            }
            return .success
        } catch {
            return .failure("Could not send. (\(shortDescription(of: error)))")
        }
    }

    static func parseAddresses(_ input: String) -> [EmailAddress] {
        input.split(whereSeparator: { $0 == "," || $0 == ";" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.contains("@") && $0.count >= 3 }
            .map { EmailAddress(email: $0) }
    }

    // MARK: - Delete

    func deleteToTrash(message: MessageHeader) async {
        guard let session else { return }
        await session.engine.deleteToTrash(message: message)
    }

    /// Offline-capable local search over the FTS index (subjects, senders,
    /// previews in M0 — bodies and attachments come in M1/M3).
    func searchLocal(_ query: String) -> [MessageHeader] {
        guard let session, let store,
              let match = FTSQueryBuilder.matchExpression(for: query)
        else { return [] }
        return (try? store.searchMessages(
            accountId: session.account.id, matchExpression: match
        )) ?? []
    }

    private func shortDescription(of error: Error) -> String {
        if let jmapError = error as? JMAPError {
            switch jmapError {
            case .httpError(let status): return "HTTP \(status)"
            case .discoveryFailed: return "no JMAP session found"
            case .malformedResponse: return "unexpected server response"
            case .methodError(let type, _): return type
            case .cannotCalculateChanges: return "sync state expired"
            }
        }
        return (error as NSError).localizedDescription
    }
}
