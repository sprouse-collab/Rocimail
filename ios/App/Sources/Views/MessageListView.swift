import SwiftUI
import RociModel

/// T4.3 — the message list: cached-first, newest-first, pull to refresh.
struct MessageListView: View {
    @Environment(AppModel.self) private var model
    let mailbox: Mailbox

    @State private var messages: [MessageHeader] = []
    @State private var searchText = ""

    private var shown: [MessageHeader] {
        searchText.isEmpty ? messages : model.searchLocal(searchText)
    }

    var body: some View {
        List(shown) { message in
            NavigationLink(value: message.id) {
                MessageRow(message: message)
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button {
                    Task {
                        await model.toggleFlag(message: message)
                        reload()
                    }
                } label: {
                    Label(
                        message.isFlagged ? "Unflag" : "Flag",
                        systemImage: message.isFlagged ? "flag.slash.fill" : "flag.fill"
                    )
                }
                .tint(.orange)
            }
        }
        .listStyle(.plain)
        .navigationTitle(mailbox.name)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search cached mail")
        .navigationDestination(for: String.self) { messageId in
            MessageDetailView(messageId: messageId)
        }
        .overlay {
            if shown.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No Messages" : "No Matches",
                    systemImage: searchText.isEmpty ? "tray" : "magnifyingglass"
                )
            }
        }
        .refreshable {
            await model.refresh()
            await model.backfill(mailbox: mailbox)
            reload()
        }
        .task {
            reload()
            if messages.isEmpty {
                await model.backfill(mailbox: mailbox)
                reload()
            }
        }
    }

    private func reload() {
        messages = model.messages(in: mailbox)
    }
}

struct MessageRow: View {
    let message: MessageHeader

    private var senderName: String {
        message.from.first?.displayName ?? "(unknown sender)"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(name: senderName)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(senderName)
                        .font(.subheadline.weight(message.isSeen ? .regular : .bold))
                        .lineLimit(1)
                    Spacer()
                    Text(message.receivedAt, format: .relative(presentation: .named))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 4) {
                    if message.isFlagged {
                        Image(systemName: "flag.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if message.hasAttachment {
                        Image(systemName: "paperclip")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text(message.subject ?? "(no subject)")
                        .font(.subheadline.weight(message.isSeen ? .regular : .semibold))
                        .lineLimit(1)
                }

                if let preview = message.preview, !preview.isEmpty {
                    Text(preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            if !message.isSeen {
                Circle()
                    .fill(Roci.accent)
                    .frame(width: 9, height: 9)
                    .padding(.top, 6)
            }
        }
        .padding(.vertical, 2)
    }
}
