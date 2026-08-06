import SwiftUI
import RociModel

/// What a new composer starts from: blank, reply, reply-all, or forward.
struct ComposerPrefill: Hashable, Identifiable {
    var id: Int { hashValue }

    var to = ""
    var cc = ""
    var subject = ""
    var body = ""
    var inReplyTo: String?
    var references: [String] = []

    static func reply(to detail: MessageDetail, all: Bool) -> ComposerPrefill {
        let sender = detail.replyTo.first ?? detail.header.from.first
        var recipients = [sender].compactMap { $0?.email }
        var ccList: [String] = []
        if all {
            let mine = Set(recipients)
            recipients += detail.header.to.map(\.email).filter { !mine.contains($0) }
            ccList = detail.cc.map(\.email)
        }
        let subject = detail.header.subject ?? ""
        return ComposerPrefill(
            to: recipients.joined(separator: ", "),
            cc: ccList.joined(separator: ", "),
            subject: subject.lowercased().hasPrefix("re:") ? subject : "Re: \(subject)",
            body: quoted(detail),
            inReplyTo: detail.rfcMessageIds.first,
            references: detail.rfcReferences
        )
    }

    static func forward(_ detail: MessageDetail) -> ComposerPrefill {
        let subject = detail.header.subject ?? ""
        return ComposerPrefill(
            subject: subject.lowercased().hasPrefix("fwd:") ? subject : "Fwd: \(subject)",
            body: quoted(detail, label: "Forwarded message")
        )
    }

    private static func quoted(_ detail: MessageDetail, label: String? = nil) -> String {
        let sender = detail.header.from.first?.displayName ?? "unknown"
        let date = detail.header.receivedAt.formatted(date: .abbreviated, time: .shortened)
        let original = detail.textBody
            ?? detail.header.preview
            ?? "(original message had no plain-text body)"
        let quotedBody = original
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }
            .joined(separator: "\n")
        let heading = label.map { "---------- \($0) ----------" }
            ?? "On \(date), \(sender) wrote:"
        return "\n\n\(heading)\n\(quotedBody)\n"
    }
}

/// M1 composer: plain-text body, To/Cc/Subject, send-or-queue.
struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var to: String
    @State private var cc: String
    @State private var subject: String
    @State private var bodyText: String
    @State private var isSending = false
    @State private var sendError: String?
    private let prefill: ComposerPrefill

    init(prefill: ComposerPrefill = ComposerPrefill()) {
        self.prefill = prefill
        _to = State(initialValue: prefill.to)
        _cc = State(initialValue: prefill.cc)
        _subject = State(initialValue: prefill.subject)
        _bodyText = State(initialValue: prefill.body)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("To", text: $to)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("Cc", text: $cc)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("Subject", text: $subject)
                }

                Section {
                    TextEditor(text: $bodyText)
                        .frame(minHeight: 220)
                }

                if let sendError {
                    Section {
                        Label(sendError, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Roci.accentDark)
                    }
                }
            }
            .navigationTitle(subject.isEmpty ? "New Message" : subject)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await send() }
                    } label: {
                        if isSending {
                            ProgressView()
                        } else {
                            Label("Send", systemImage: "paperplane.fill")
                        }
                    }
                    .disabled(isSending || to.isEmpty)
                }
            }
        }
        .tint(Roci.accent)
        .interactiveDismissDisabled(!bodyText.isEmpty || !to.isEmpty)
    }

    private func send() async {
        isSending = true
        defer { isSending = false }
        let result = await model.send(
            to: to,
            cc: cc,
            subject: subject,
            body: bodyText,
            inReplyTo: prefill.inReplyTo,
            references: prefill.references
        )
        switch result {
        case .success:
            dismiss()
        case .failure(let message):
            sendError = message
        }
    }
}
