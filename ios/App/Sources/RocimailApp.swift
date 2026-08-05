import SwiftUI

@main
struct RocimailApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if model.isSignedIn {
                    MailboxListView()
                } else {
                    LoginView()
                }
            }
            .environment(model)
        }
    }
}
