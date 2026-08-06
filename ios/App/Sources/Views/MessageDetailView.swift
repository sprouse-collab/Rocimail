import SwiftUI
import RociModel

/// T4.4 — the reader: locked-down HTML rendering with plain-text fallback.
struct MessageDetailView: View {
    @Environment(AppModel.self) private var model
    let messageId: String

    @Environment(\.dismiss) private var dismiss
    @State private var detail: MessageDetail?
    @State private var composerPrefill: ComposerPrefill?

    var body: some View {
        Group {
            if let detail {
                content(for: detail)
            } else {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let detail {
                ToolbarItemGroup(placement: .primaryAction) {
                    Menu {
                        Button {
                            composerPrefill = .reply(to: detail, all: false)
                        } label: {
                            Label("Reply", systemImage: "arrowshape.turn.up.left")
                        }
                        Button {
                            composerPrefill = .reply(to: detail, all: true)
                        } label: {
                            Label("Reply All", systemImage: "arrowshape.turn.up.left.2")
                        }
                        Button {
                            composerPrefill = .forward(detail)
                        } label: {
                            Label("Forward", systemImage: "arrowshape.turn.up.right")
                        }
                    } label: {
                        Image(systemName: "arrowshape.turn.up.left")
                    }

                    Button(role: .destructive) {
                        Task {
                            await model.deleteToTrash(message: detail.header)
                            dismiss()
                        }
                    } label: {
                        Image(systemName: "trash")
                    }
                }
            }
        }
        .sheet(item: $composerPrefill) { prefill in
            ComposerView(prefill: prefill)
        }
        .task {
            detail = await model.loadDetail(messageId: messageId)
        }
    }

    @ViewBuilder
    private func content(for detail: MessageDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(detail.header.subject ?? "(no subject)")
                    .font(.headline)

                HStack(spacing: 10) {
                    AvatarView(name: detail.header.from.first?.displayName ?? "?")
                    VStack(alignment: .leading, spacing: 1) {
                        Text(detail.header.from.first?.displayName ?? "(unknown sender)")
                            .font(.subheadline.bold())
                        if let email = detail.header.from.first?.email {
                            Text(email)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Text(
                        detail.header.receivedAt,
                        format: .dateTime.day().month().year().hour().minute()
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                if !detail.attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(detail.attachments) { attachment in
                                Label(
                                    attachment.name ?? attachment.type,
                                    systemImage: "paperclip"
                                )
                                .font(.caption)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Roci.accentSoft, in: Capsule())
                                .foregroundStyle(Roci.accentDark)
                            }
                        }
                    }
                }
            }
            .padding()

            Divider()

            if let html = detail.htmlBody, !html.isEmpty {
                SafeHTMLView(html: html)
            } else {
                ScrollView {
                    Text(detail.textBody ?? "(empty message)")
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .textSelection(.enabled)
                }
            }
        }
    }
}
