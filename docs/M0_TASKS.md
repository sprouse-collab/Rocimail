# M0 — Foundations: Task Breakdown

Goal (from the outline, §11): **read mail from a Stalwart account on an iPhone, with a
working offline cache**, on a project skeleton every later milestone builds on.
Estimated 3–4 weeks. Tasks are ordered; each has a done-check.

> Note on tooling: iOS builds require Xcode on macOS. The engine packages, however,
> are plain Swift Packages — they build and test with `swift test` on macOS CI (and
> mostly on Linux), against the dockerized Stalwart already in this repo.

## 0. Project & repo scaffolding

- [ ] **T0.1 — Repo layout**: create `ios/` with an Xcode project `Rocimail.xcodeproj`
      (SwiftUI app target, iOS 17 minimum) and a local package `ios/RociKit/` with
      library targets: `RociModel`, `RociMail`, `RociSync`, `RociStore`, `RociSearch`.
      (Calendar/Crypto/Rules packages come in M2/M4.) App target depends only on the
      packages; packages never import SwiftUI/UIKit.
      *Done when: app builds and shows a placeholder screen; `swift test` runs in `RociKit`.*
- [ ] **T0.2 — CI**: GitHub Actions workflow on macOS runner: SwiftFormat/SwiftLint,
      `swift test` for RociKit (spinning up Stalwart via `docker-compose` where the
      runner allows; otherwise a recorded-fixture mode — see T2.5), app build
      (`xcodebuild -scheme Rocimail build` without signing).
      *Done when: CI is green on a PR.*
- [ ] **T0.3 — Design tokens**: colors (keep the Rocimail red accent from the web app),
      type scale, spacing, dark mode, Dynamic Type support baked in from day one.
      *Done when: a `DesignSystem` SwiftUI file with previews exists and the placeholder
      screen uses it.*

## 1. Data model & store (`RociModel`, `RociStore`)

- [ ] **T1.1 — Core model types**: `Account`, `Mailbox` (tree + role/special-use),
      `Message` (envelope, flags/keywords, threadId, preview), `MessageBody`
      (parts, HTML/text), `Attachment` (metadata + blob ref). Mirror the shape of the
      web app's `server/src/types.ts` where sensible so both clients stay conceptually aligned.
      *Done when: types compile with Codable conformance and doc comments.*
- [ ] **T1.2 — GRDB schema + migrations**: tables for accounts, mailboxes, messages,
      body cache, blob index, sync state (`sinceState` per account/type), outbox ops.
      Migration runner with v1 schema.
      *Done when: unit tests create/migrate/CRUD a throwaway DB.*
- [ ] **T1.3 — SQLCipher at rest**: encrypted DB, key generated on first launch and
      wrapped in the Keychain (Secure Enclave where available).
      *Done when: DB file is unreadable without the key; key survives app reinstall
      policy decided (default: it does not — documented).*
- [ ] **T1.4 — Blob cache**: content-addressed attachment/body-part store on disk with
      LRU eviction and a per-account size budget; encrypted via iOS Data Protection.
      *Done when: unit tests verify store/retrieve/evict.*

## 2. JMAP client (`RociMail`)

- [ ] **T2.1 — Session & auth**: `.well-known/jmap` discovery (accept full session URL
      too, like the web app), Basic auth, session object parsing (capabilities,
      accountId, apiUrl/downloadUrl/uploadUrl), Keychain credential storage.
      *Done when: integration test gets a session from dockerized Stalwart.*
- [ ] **T2.2 — Request engine**: typed `Invocation`/method-call batching over
      URLSession async/await, error mapping (method-level + request-level), retry with
      backoff, `using` capability negotiation.
      *Done when: `Mailbox/get` round-trips in an integration test.*
- [ ] **T2.3 — Mailbox + Email reads**: `Mailbox/get`, `Email/query` (paging, sort by
      receivedAt), `Email/get` with body fetching (`fetchHTMLBodyValues`), blob
      download for attachments/inline `cid:` images.
      *Done when: integration tests list a folder page and fetch a full message with
      an attachment.*
- [ ] **T2.4 — Delta sync methods**: `Mailbox/changes`, `Email/changes`,
      `Thread/changes`, plus `Email/queryChanges` fallback handling
      (`cannotCalculateChanges` → refetch window).
      *Done when: integration test mutates mail server-side and observes the delta.*
- [ ] **T2.5 — Fixture recorder**: record real Stalwart responses into JSON fixtures so
      the same tests run offline/on CI without Docker (replay mode).
      *Done when: test suite passes with `ROCI_FIXTURES=replay`.*

## 3. Sync engine v0 (`RociSync`)

- [ ] **T3.1 — Backfill strategy**: initial sync = mailbox tree + newest N days of
      envelopes per folder (configurable, default 30), bodies on demand, progressive
      older-history fetch.
      *Done when: fresh account reaches "usable inbox" state and DB matches server.*
- [ ] **T3.2 — Delta loop**: foreground refresh (pull-to-refresh + on-appear) applies
      `*/changes` into the store transactionally; UI observes the DB (GRDB
      ValueObservation), never the network.
      *Done when: a message flagged via the web app appears flagged in the iPhone app
      after refresh, with no full re-list.*
- [ ] **T3.3 — Outbox/op-log skeleton**: table + replay worker with idempotent ops;
      wire up the first op (`markRead`) end-to-end offline → replay on reconnect.
      (Full mutation set lands in M1.)
      *Done when: airplane-mode test — mark read offline, relaunch, reconnect, server
      shows the flag.*

## 4. App UI v0 (SwiftUI)

- [ ] **T4.1 — Onboarding/sign-in**: server URL + email + password form with
      autodiscovery progress states and clear errors (mirrors the web Login flow).
      *Done when: signing into Stalwart lands in the inbox; bad creds show a
      human-readable error.*
- [ ] **T4.2 — Mailbox sidebar/drawer**: folder tree with unread counts, account header.
      *Done when: matches server tree incl. nesting and special-use icons.*
- [ ] **T4.3 — Message list**: virtualized list with sender/subject/preview/date,
      unread and flagged indicators, attachment chip, pull-to-refresh, infinite scroll
      paging from the local store.
      *Done when: 60fps scroll through 1k+ cached messages on a device.*
- [ ] **T4.4 — Reader v0**: HTML body in locked-down WKWebView (JS off, CSP, link taps
      open `SFSafariViewController` after confirmation), plain-text fallback, inline
      `cid:` images from the blob cache, attachment list with QuickLook preview,
      mark-read on open.
      *Done when: gnarly real-world HTML mail renders safely; remote images blocked
      by default with a per-message "load images" button.*
- [ ] **T4.5 — App shell**: navigation (sidebar → list → reader), account settings
      stub, sign-out (wipes Keychain + DB per policy).
      *Done when: full read-path demo works on a physical iPhone.*

## 5. Milestone exit review

- [ ] **T5.1 — Exit criteria check**: read mail from a Stalwart account on an iPhone;
      kill network → app still browses cached mail and bodies; CI green; no
      protocol/UI code crossing the package boundary in the wrong direction
      (enforced by target dependencies).
- [ ] **T5.2 — M1 planning**: carry learnings into an M1 task breakdown (composer,
      send, drafts, threading, unified inbox, local FTS bodies, push gateway).

## Explicit deferrals (do NOT build in M0)

Secondary accounts — IMAP gateway + QNAP archive tier (M5, non-blocking for v1.0 —
see `ARCHIVE_TIER.md`; the app itself never gains IMAP code) · calendar (M2) ·
attachment text extraction & full search (M3; the FTS5 virtual table is created in
T1.2 but only populated with subjects/senders for now) · push notifications &
background tasks (M1) · encryption beyond at-rest (M4) · compose/send (M1).

One M0 payoff worth noting: because the archive is just another JMAP endpoint, the
JMAP client built in M0 could sign into a QNAP archive instance as-is — multi-account
plumbing is in the data model from day one, even though secondary accounts are
deliberately last (M5).
