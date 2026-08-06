import SwiftUI

/// T4.1 — server URL + credentials with autodiscovery, mirroring the web
/// client's login card.
struct LoginView: View {
    @Environment(AppModel.self) private var model

    @State private var server = ""
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("mail.example.com", text: $server)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Server")
                } footer: {
                    Text(
                        "Your JMAP server's address — Rocimail discovers the "
                        + "session at /.well-known/jmap."
                    )
                }

                Section("Account") {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                }

                if let error = model.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Roci.accentDark)
                    }
                }

                Section {
                    Button {
                        Task { await model.signIn(server: server, email: email, password: password) }
                    } label: {
                        if model.isBusy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Sign In")
                                .bold()
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .listRowBackground(Roci.accent)
                    .foregroundStyle(.white)
                    .disabled(model.isBusy || server.isEmpty || email.isEmpty || password.isEmpty)
                }
            }
            .navigationTitle("Rocimail")
        }
        .tint(Roci.accent)
    }
}
