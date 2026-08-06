import SwiftUI
import RociModel

/// T4.3 / M1 — the conversation list: cached-first, threaded, newest-first,
/// pull to refresh, swipe to flag or trash.
struct MessageListView: View {
    @Environment(AppModel.self) private var model
    let mailbox: Mailbox

    @State private var threads: [ThreadSummary] = []
    @State private var searchText = ""

    var body: some View {
        List {
            if searchText.isEmpty {
                ForEach(threads) { summary in
                    NavigationLink(value: summary) {
                        ThreadRow(summary: summary)
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        flagButton(for: summary.latest)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        trashButton(for: summary)
                    }
                }
            } else {
                // Local FTS search returns flat messages, not threads.
                ForEach(model.searchLocal(searchText)) { message in
                    NavigationLink(value: message.id) {
                        MessageRow(message: message)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(mailbox.name)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search cached mail")
        .overlay {
            if searchText.isEmpty ? threads.isEmpty : model.searchLocal(searchText).isEmpty {
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
            if threads.isEmpty {
                await model.backfill(mailbox: mailbox)
                reload()
            }
        }
    }

    private func reload() {
        threads = model.threads(in: mailbox)
    }

    private func flagButton(for message: MessageHeader) -> some View {
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

    private func trashButton(for summary: ThreadSummary) -> some View {
        Button(role: .destructive) {
            Task {
                for message in model.messagesInThread(summary) {
                    await model.deleteToTrash(message: message)
                }
                reload()
            }
        } label: {
            Label("Trash", systemImage: "trash.fill")
        }
    }
}

/// The messages of one conversation, oldest first.
struct ThreadView: View {
    @Environment(AppModel.self) private var model
    let summary: ThreadSummary

    var body: some View {
        List(model.messagesInThread(summary)) { message in
            NavigationLink(value: message.id) {
                MessageRow(message: message)
            }
        }
        .listStyle(.plain)
        .navigationTitle(summary.latest.subject ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ThreadRow: View {
    let summary: ThreadSummary

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            MessageRow(message: summary.latest)
            if summary.messageCount > 1 {
                Text("\(summary.messageCount)")
                    .font(.caption2.bold())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
        }
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
