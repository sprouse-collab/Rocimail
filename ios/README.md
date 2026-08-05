# Rocimail for iPhone

The iOS app (see `docs/MOBILE_APP_OUTLINE.md` for the full plan, and
`docs/M0_TASKS.md` for the current milestone).

## Layout

```
ios/
  project.yml     XcodeGen spec — the .xcodeproj is generated, not committed
  App/Sources/    SwiftUI app target (thin: views + AppModel)
  RociKit/        The engine: UI-free Swift Packages
    RociModel     Data types shared by every layer
    RociMail      JMAP client (RFC 8620/8621) on URLSession
    RociStore     GRDB/SQLite local store + FTS5 index + blob cache
    RociSync      Sync engine: backfill, deltas, offline outbox
    RociSearch    FTS query building (full query language lands in M3)
```

The app target never talks to the network directly — views read `MailStore`
and call `SyncEngine`; only the engine touches `JMAPClient`.

## Building (requires a Mac)

```bash
brew install xcodegen
cd ios
xcodegen generate      # produces Rocimail.xcodeproj
open Rocimail.xcodeproj
```

Select the Rocimail scheme and run on a simulator or device. Sign in with a
JMAP server (Stalwart, Fastmail, …); for a local test server use the
`docker compose up -d stalwart` instance from the repo root and the server URL
`http://localhost:8080`.

## Engine tests (no simulator needed)

```bash
swift test --package-path ios/RociKit
```

The packages are UI-free, so the full engine test suite runs on any Mac (and
in CI on `macos-15` runners — see `.github/workflows/ios.yml`). The JMAP
client is tested against Stalwart-shaped fixtures via `URLProtocol`
interception; the sync engine against a scripted in-memory transport.

## M0 status

- [x] T0.1 package/project skeleton (this directory)
- [x] T0.2 CI (`.github/workflows/ios.yml`)
- [x] T0.3 design tokens (`App/Sources/DesignSystem.swift`)
- [x] T1.1 core model types (`RociModel`)
- [x] T1.2 GRDB schema + migrations (`RociStore/MailStore.swift`)
- [ ] T1.3 SQLCipher at rest (interim: iOS Data Protection; tracked TODO)
- [x] T1.4 blob cache (`RociStore/BlobCache.swift`)
- [x] T2.1 session discovery & auth
- [x] T2.2 request engine (batched invocations, typed errors)
- [x] T2.3 mailbox + email reads (query, get, bodies, blob download)
- [x] T2.4 delta sync methods (`*/changes`, `cannotCalculateChanges` fallback)
- [ ] T2.5 fixture recorder against live Stalwart (fixtures are hand-written today)
- [x] T3.1 backfill strategy (inbox window, per-mailbox on demand)
- [x] T3.2 delta loop (store-first UI, refresh applies deltas)
- [x] T3.3 outbox skeleton (`setKeyword` op end-to-end, offline replay)
- [x] T4.1 sign-in flow
- [x] T4.2 mailbox list
- [x] T4.3 message list (cached-first, search, swipe flag)
- [x] T4.4 reader v0 (sanitized WKWebView, CSP, link interception)
- [x] T4.5 app shell (navigation, sign-out)
- [ ] T5.1 exit review on a physical iPhone
