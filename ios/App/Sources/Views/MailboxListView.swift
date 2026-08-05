import SwiftUI
import RociModel

/// T4.2 — the folder tree with unread counts.
struct MailboxListView: View {
    @Environment(AppModel.self) private var model

    private var topLevel: [Mailbox] {
        model.mailboxes.filter { $0.parentId == nil }
    }

    private func children(of mailbox: Mailbox) -> [Mailbox] {
        model.mailboxes.filter { $0.parentId == mailbox.id }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(topLevel) { mailbox in
                        row(for: mailbox, depth: 0)
                        ForEach(children(of: mailbox)) { child in
                            row(for: child, depth: 1)
                        }
                    }
                }

                Section {
                    Button(role: .destructive) {
                        model.signOut()
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            }
            .navigationTitle("Mailboxes")
            .navigationDestination(for: Mailbox.self) { mailbox in
                MessageListView(mailbox: mailbox)
            }
            .refreshable { await model.refresh() }
        }
        .tint(Roci.accent)
    }

    @ViewBuilder
    private func row(for mailbox: Mailbox, depth: Int) -> some View {
        NavigationLink(value: mailbox) {
            HStack {
                Label {
                    Text(mailbox.name)
                } icon: {
                    Image(systemName: icon(for: mailbox.role))
                        .foregroundStyle(Roci.accent)
                }
                .padding(.leading, CGFloat(depth) * 16)

                Spacer()

                if mailbox.unreadEmails > 0 {
                    Text("\(mailbox.unreadEmails)")
                        .font(.caption.bold())
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Roci.accentSoft, in: Capsule())
                        .foregroundStyle(Roci.accentDark)
                }
            }
        }
    }

    private func icon(for role: String?) -> String {
        switch role {
        case "inbox": return "tray.fill"
        case "sent": return "paperplane.fill"
        case "drafts": return "doc.fill"
        case "trash": return "trash.fill"
        case "junk": return "xmark.bin.fill"
        case "archive": return "archivebox.fill"
        default: return "folder.fill"
        }
    }
}
