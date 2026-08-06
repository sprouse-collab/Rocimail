import SwiftUI

/// Design tokens (T0.3). Mirrors the web client's Zoho-style theme
/// (web/src/styles.css) so the two clients feel like one product.
enum Roci {
    static let accent = Color(hex: 0xD83A34)
    static let accentDark = Color(hex: 0xB92C27)
    static let accentSoft = Color(hex: 0xFDECEB)

    /// Unread indicator / emphasized text weight color in light mode.
    static let unread = Color(hex: 0x111826)

    static let spacing: CGFloat = 8
    static let cornerRadius: CGFloat = 10

    static func avatarColor(for seed: String) -> Color {
        let palette: [Color] = [
            Color(hex: 0xD83A34), Color(hex: 0x2F6FDE), Color(hex: 0x1F9D55),
            Color(hex: 0x9B51E0), Color(hex: 0xE07C24), Color(hex: 0x0E7C86),
        ]
        let index = abs(seed.hashValue) % palette.count
        return palette[index]
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Sender initial in a colored circle, as in the web client's list rows.
struct AvatarView: View {
    let name: String

    var body: some View {
        Circle()
            .fill(Roci.avatarColor(for: name))
            .frame(width: 38, height: 38)
            .overlay {
                Text(String(name.first.map(String.init) ?? "?").uppercased())
                    .font(.system(.headline, design: .rounded))
                    .foregroundStyle(.white)
            }
    }
}

#Preview("Design tokens") {
    VStack(spacing: 16) {
        HStack {
            AvatarView(name: "Alice")
            AvatarView(name: "Bob")
            AvatarView(name: "Carol")
        }
        Text("Rocimail").font(.largeTitle.bold()).foregroundStyle(Roci.accent)
        RoundedRectangle(cornerRadius: Roci.cornerRadius)
            .fill(Roci.accentSoft)
            .frame(height: 44)
            .overlay { Text("Accent soft").foregroundStyle(Roci.accentDark) }
    }
    .padding()
}
