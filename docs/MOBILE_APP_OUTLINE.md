# Rocimail for iPhone — Product & Technical Outline

An **iPhone** email + calendar app supporting **JMAP** and **IMAP/SMTP** mail accounts
and **JMAP Calendars / CalDAV** calendar accounts, with **full-text search including
attachment contents** (critical for JMAP; lighter for IMAP), optional **end-to-end
encryption**, and a complete daily-driver feature set comparable to Zoho Mail or
Outlook — good enough to set as your default mail app on iOS.

**Scope decision**: this is an **iPhone-only project for v1**, built in plain
Swift/SwiftUI with no cross-platform framework. Android is a possible future phase
(see §14) and nothing in v1 blocks it — but we don't pay any cross-platform complexity
tax today for it.

---

## 1. Vision & Goals

| Goal | What it means concretely |
| --- | --- |
| Daily-driver mail app | Fast unified inbox, reliable push notifications, offline reading and composing, set-as-default on iOS |
| Protocol-native | JMAP first-class (RFC 8620/8621), IMAP/SMTP fully supported for everything else — no proprietary gateway required |
| Calendar built in | Events, invites, recurrence, reminders, multiple accounts — JMAP Calendars and CalDAV |
| Search everything | **JMAP: critical-path, full-depth search** — local full-text index over headers, bodies, and extracted attachment text, merged with server-side search. IMAP: lighter tier — headers/bodies of synced mail plus server `SEARCH`; attachment indexing best-effort only |
| Private & secure | TLS everywhere, encrypted local storage, optional OpenPGP/S/MIME end-to-end encryption, remote-image/tracker blocking |
| Feels like an Apple app | Pure SwiftUI, native gestures/share sheet/widgets/Spotlight — no cross-platform runtime between us and iOS |

### Non-goals (v1)

- **Android** (deferred — see §14 for the path; nothing in v1 forecloses it)
- Exchange ActiveSync / EWS / proprietary Gmail API accounts (IMAP covers Gmail; revisit later)
- Contacts management app (address autocomplete from system contacts + mail history in v1; CardDAV sync in v2)
- iPad-optimized layout (runs scaled; real split-view layout post-v1)
- Hosting mail — this is a client only

### Relationship to the existing repo

Rocimail today is a Node/Express server + React web client that already normalizes JMAP
and IMAP behind one `MailProvider` interface. The iPhone app **reuses the concepts, not
the runtime**: the phone talks JMAP/IMAP **directly** (no middlebox holding
credentials), but the unified data model, provider abstraction, and JMAP-first design
carry over directly. The existing server later gains one small new role: the **push
gateway** (see §7).

---

## 2. Tech Stack — Plain Swift, No Cross-Platform Framework

**Decision: 100% Swift + SwiftUI.** One language, one toolchain (Xcode), the smallest
possible complexity budget. The engine (protocols, sync, storage, search, crypto) is
structured as local **Swift Packages** separate from the UI — good architecture on its
own, and it keeps a future Android port systematic (§14).

| Layer | Choice |
| --- | --- |
| UI | SwiftUI (iOS 17+), UIKit interop only where needed (rich-text editor, message web view) |
| Concurrency | Swift structured concurrency (async/await, actors) |
| JMAP client | Hand-rolled on `URLSession` + `Codable` — JMAP is just HTTPS+JSON, no library needed |
| IMAP/SMTP client | MailCore2 (battle-tested C++/ObjC) to start; evaluate SwiftNIO-based replacement if it ages badly |
| MIME parsing | MailCore2 for IMAP messages; JMAP servers hand us parsed structure already |
| Local store | SQLite via GRDB.swift + **FTS5** for search; SQLCipher for encryption at rest |
| HTML mail rendering | `WKWebView`, JS disabled, CSP locked down, content sanitized before load |
| Calendar data | Hand-rolled JMAP Calendars client; CalDAV via `URLSession` (WebDAV verbs) + an iCalendar (RFC 5545) parser package |
| Crypto | CryptoKit + Keychain/Secure Enclave for keys; **ObjectivePGP** for OpenPGP; Security framework for S/MIME (CMS) |
| Attachment text extraction | PDFKit (PDF text), Vision (on-device OCR, opt-in), ZIPFoundation + XML parsing for docx/xlsx/pptx |
| Push | APNs via a small push gateway added to the existing Rocimail server (§7) |
| Background work | BGAppRefreshTask / BGProcessingTask + silent pushes |

**Why not KMP / React Native / Rust?** All three exist to share code with Android. With
Android out of scope, each is pure overhead: an extra language, an extra build system,
and a seam between the engine and iOS. Plain Swift gives the fastest development, the
best debugging, and the most native result. The only real cost — JMAP/IMAP client code
that Android can't reuse someday — is addressed by the package structure in §14.

**Minimum OS**: iOS 17+ (SwiftUI maturity, `Observable` macro; default-mail-app support
has existed since iOS 14 so no constraint there).

---

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────┐
│  App (SwiftUI)                                             │
│    Mailbox list · Thread list · Reader · Composer ·        │
│    Calendar views · Search · Settings                      │
├────────────────────────────────────────────────────────────┤
│  Local Swift Packages (the engine — no UI imports)         │
│                                                            │
│  RociMail        MailProvider protocol                     │
│                    ├─ JMAPProvider   (URLSession + Codable)│
│                    └─ IMAPProvider   (MailCore2 + SMTP)    │
│  RociCalendar    CalendarProvider protocol                 │
│                    ├─ JMAPCalendarProvider                 │
│                    └─ CalDAVProvider (+ iCalendar parser)  │
│  RociSync        Delta sync, outbox/op-log, conflict       │
│                  policy, background scheduling             │
│  RociStore       GRDB + SQLCipher schema, blob cache       │
│                  with eviction                             │
│  RociSearch      FTS5 index, query parser, attachment      │
│                  text-extraction pipeline                  │
│  RociCrypto      OpenPGP / S/MIME, key management,         │
│                  Autocrypt state                           │
│  RociRules       Client-side rules engine + Sieve mgmt     │
├────────────────────────────────────────────────────────────┤
│  iOS services: Keychain/Secure Enclave · APNs ·            │
│  BackgroundTasks · Share sheet · Default-app · Spotlight   │
└────────────────────────────────────────────────────────────┘
```

**Local-first**: the UI reads *only* from the local store; the sync engine reconciles
with servers. Every mutation (flag, move, delete, send, event edit) is written locally
first, queued in an **outbox/op-log**, and replayed to the server with retry — so the
app is fully usable offline and never blocks on the network.

---

## 4. Accounts & Authentication

- **Account types**: JMAP (mail + calendar in one session), IMAP+SMTP (mail),
  CalDAV (calendar). One "identity" can bundle e.g. IMAP mail + CalDAV calendar.
- **Setup flow**:
  1. Enter email address → autodiscovery: `/.well-known/jmap` (JMAP), SRV records
     (RFC 6186 `_imaps._tcp`, `_submission._tcp`, RFC 6764 `_caldavs._tcp`),
     Thunderbird autoconfig XML as fallback → manual settings screen as last resort.
  2. Auth: password (Basic for JMAP, LOGIN/PLAIN for IMAP), **OAuth 2.0** where
     advertised (XOAUTH2 for Gmail/Outlook.com IMAP via `ASWebAuthenticationSession`;
     OAuth for JMAP per RFC 8620), app-specific passwords supported.
- **Credential storage**: iOS Keychain only; never in the DB.
- **Multi-account**: unlimited accounts, per-account color & signature, unified inbox.

---

## 5. Mail Feature Set (parity target: Zoho Mail / Outlook Mobile)

### Reading & triage
- Unified inbox + per-account/per-folder views; folder management (create/rename/move/delete)
- Conversation threading (JMAP `threadId`; References/In-Reply-To heuristics for IMAP)
- Message list: sender avatars, snippets, attachment/calendar chips, unread & flag badges
- Swipe actions (configurable): archive, delete, read/unread, flag, move, snooze
- Batch selection & bulk actions; select-all-in-folder
- **Snooze** (local resurface + server folder move), **pin**, **remind me if no reply**
- Focused/Other style inbox sections (rule-driven, local, off by default)
- Print / save as PDF; view raw source; view headers

### Composing & sending
- Rich text editor (bold/italic/lists/links/inline images), plain-text mode per message
- Reply / reply-all / **forward (inline and as attachment .eml)** / edit-as-new
- Attachments: Files app, photos, camera, document scanner; size warnings; background upload
- Per-account signatures (rich text) and reply-above/below preference
- **Undo send** (configurable 5–30 s delay), **send later / scheduled send**,
  read-receipt requests (send + respond policy)
- Drafts autosave locally + sync to server Drafts folder
- Aliases / send-as identities per account; reply-from-the-address-it-was-sent-to
- Templates / canned responses

### Organization & automation
- **Rules/filters engine**: client-side rules (run on sync) + management of
  server-side JMAP Sieve scripts where supported (RFC 9661 sieve-over-JMAP)
- Labels/keywords (JMAP keywords; IMAP FLAGS where server permits arbitrary flags)
- Auto-forwarding management UI (writes Sieve where available; otherwise documents
  server-side setup), vacation responder (JMAP `VacationResponse`; Sieve for IMAP hosts)
- Block sender / unsubscribe (RFC 8058 one-click List-Unsubscribe, mailto fallback)
- Spam handling: move-to-junk with server flag training (Junk/NotJunk keywords)

### Notifications
- Per-account and per-folder notification rules; VIP senders; quiet hours / Focus-mode aware
- Rich notifications with actions: archive, delete, reply (inline), mark read
- Grouped by conversation; badge counts

### Safety
- HTML sanitization + sandboxed rendering (WKWebView, JS disabled, CSP, no external navigation)
- **Remote images blocked by default** with per-sender allow; tracker-pixel stripping
- Phishing heuristics: sender-domain vs display-name mismatch warning, first-time
  sender banner, suspicious-link preview on long-press

---

## 6. Search — Full Text Including Attachments

The flagship feature — with an explicit priority split: **full-depth search is a
hard requirement for JMAP accounts** (the primary account type); **IMAP search is a
lighter, good-enough tier** and must never block or complicate the JMAP path.

### JMAP accounts (critical path — full depth)
Two layers, merged and deduped in one results UI:

- **Server-side first**: JMAP `Email/query` with the full filter tree. JMAP servers
  (Stalwart, Fastmail) index message text — and often attachment content — server-side,
  so even mail never synced to the device is searchable instantly. Surface the
  `attachments:` / body-scoped filters whenever the server advertises them.
- **Local FTS index** for offline use and attachment depth the server may lack:
  - **SQLite FTS5** (trigram + unicode61 tokenizers) over subject, from/to/cc,
    body text (HTML→text), filenames, **and extracted attachment text**
  - **Attachment text extraction pipeline** (background, budgeted):
    - PDF via PDFKit (per-page text; Vision OCR for image-only PDFs — opt-in, on-device only)
    - Office: docx/xlsx/pptx (XML unzip + text pull), legacy doc/xls best-effort
    - Plain/rtf/csv/markdown/html; .eml/.ics nested messages
    - Images: EXIF + Vision OCR (opt-in)
    - Extraction runs on charge+Wi-Fi by default (BGProcessingTask); per-account size
      caps; queue survives restarts
  - Index encrypted at rest with the database (SQLCipher)
  - Ranking: BM25 + recency boost + sender-affinity boost

### IMAP accounts (lighter tier)
- Local FTS over **headers and bodies of synced mail only** (same FTS5 index, same UX)
- Server fallback via IMAP `SEARCH` (`TEXT`/`BODY`; `X-GM-RAW` on Gmail) for unsynced history
- **Attachment content indexing is best-effort and off by default** for IMAP: the
  extraction pipeline can be enabled per IMAP account in settings, but it is not part
  of the acceptance criteria, gets the lowest background-work priority, and IMAP-specific
  extraction bugs are never launch blockers
- Results clearly labeled when a search couldn't cover attachment contents, so
  expectations stay honest per account type

### Search UX
- One search bar with scopes: All / current folder / account
- Filter chips: from, to, date range, has-attachment, attachment-type, unread, flagged, size
- Query syntax (`from:alice has:pdf before:2026-06-01 "quarterly report"`) + saved searches
- Search inside the calendar too (event titles, locations, descriptions, attendees)
- Mail surfaced in system Spotlight via CoreSpotlight (respects app lock)

---

## 7. Sync Engine & Push (the iOS-specific hard part)

### Delta sync
- **JMAP**: `Email/changes`, `Mailbox/changes`, `Thread/changes` with `sinceState`;
  batched backfill (newest N days first, then progressive history); blob download on demand
- **IMAP**: CONDSTORE/QRESYNC (RFC 7162) where available; fallback UID-based diffing;
  BODYSTRUCTURE-driven lazy part fetch; special-use detection (RFC 6154)
- Configurable sync window per account (e.g. 30 days offline, older-on-demand)
- Conflict policy: server wins for flags/moves, client op-log replays idempotently

### Push notifications (iOS constraints drive the design)
iOS kills background sockets, so "instant mail" requires APNs:

- **JMAP accounts**: JMAP Push via `PushSubscription` → APNs. Requires a small
  **push gateway** added to the existing Rocimail Node server: the JMAP server POSTs
  `StateChange` to the gateway, which relays to APNs with content-free payloads
  (server never sees message content, only "state changed" + account hash). The app
  wakes via a Notification Service Extension, fetches the new mail itself, and builds
  the notification locally (sender/subject, decrypted where applicable).
- **IMAP accounts**: no true push without a held connection. Options, in order:
  1. Optional **Rocimail relay**: user opts in; the relay holds IMAP IDLE (credentials
     end-to-end encrypted to the relay, clearly disclosed) and pings APNs.
  2. Without relay: BGAppRefreshTask periodic fetch (~15-min best case, at iOS's
     discretion) — an honest "battery-friendly, not instant" setting.

### Background execution
- BGAppRefreshTask (periodic sync), BGProcessingTask (indexing/extraction on power),
  silent pushes for JMAP state changes, Notification Service Extension for
  notification-time fetch & decrypt

---

## 8. Calendar

### Protocols
- **JMAP Calendars** (draft-ietf-jmap-calendars; Stalwart/Fastmail support) — primary
- **CalDAV** (RFC 4791) with sync-collection (RFC 6578) — everything else
- iCalendar parsing/generation (RFC 5545), scheduling via **iTIP/iMIP** (RFC 5546/6047)
  so invites work over plain email for IMAP accounts

### Features
- Views: agenda, day, 3-day, week, month; landscape week; pinch density
- Multiple calendars per account; per-calendar color/visibility; subscribed read-only ICS URLs
- Event CRUD: title, location (MapKit preview), description, attendees with availability
  lookup (free/busy via JMAP/CalDAV where offered), attachments, travel time
- **Recurrence**: full RRULE support incl. exceptions (RDATE/EXDATE, this-and-future edits)
- Reminders/alerts (multiple per event, default per calendar), all-day & multi-TZ events,
  secondary time zone ruler
- **Invites in mail**: inline RSVP card in the reader (accept/tentative/decline w/
  comment), auto-file processed invites, counter-proposals
- Local device calendar overlay (EventKit read-only merge view, opt-in)
- Offline edits queue through the same outbox; widgets: today agenda + month grid
- Natural-language quick add ("lunch with Sam Fri 1pm") parsed on-device

---

## 9. Encryption & Security

### Transport & at-rest (always on)
- TLS 1.2+ enforced (ATS), certificate pinning optional per account, MTA-STS awareness
- Local DB encrypted (SQLCipher) with key wrapped by the Secure Enclave
- App lock: Face ID / Touch ID / passcode, per-launch or timed lock
- Blob cache encrypted; app-switcher snapshot redaction (optional)

### End-to-end encryption (enable per account — "when enabled")
- **OpenPGP** (RFC 9580) via ObjectivePGP (or a Rust sequoia-pgp bridge if ObjectivePGP
  falls short — contained behind the `RociCrypto` interface either way):
  - Sign / encrypt / decrypt / verify in composer & reader with clear status chips
  - Key generation on device, import (Files/QR/clipboard), export with passphrase
  - **Autocrypt** (Level 1) header-based opportunistic key exchange + peer state
  - Key discovery: WKD, HKP keyservers (opt-in), attached keys
  - Encrypted subject (protected headers) support
- **S/MIME** via the Security framework (CMS): certificate import (PKCS#12),
  sign/encrypt/verify, chain validation — needed for business/gov parity with Outlook
- Searchable ciphertext policy: decrypted bodies are indexed **only** into the
  encrypted local index, opt-out available ("never index encrypted mail")
- Explicit UX: padlock states (E2EE / TLS-only / unsigned), never silently downgrade;
  warn when adding a recipient without a key

### Privacy posture
- No telemetry by default; opt-in crash reporting only; no content ever to third parties
- All ML/OCR/NLP features on-device
- Open-source core (same spirit as the existing repo)

---

## 10. "Main Email App" — iOS Integration

- Register as **default mail app** (`MailTo` scheme + `com.apple.developer.mail-client`
  entitlement, iOS 14+): handles `mailto:` links system-wide
- Share sheet extension ("share file → new Rocimail message"), document types for
  .eml/.ics files
- Widgets (inbox glance, today agenda, compose shortcut), Lock Screen widgets
- App Shortcuts / Siri intents ("compose", "search mail"), Handoff-ready URL scheme
- CoreSpotlight indexing of messages & events (respects app lock)
- Focus filters (which accounts notify in which Focus mode)

---

## 11. Delivery Roadmap (iPhone)

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| **M0 — Foundations** (3–4 wk) | Xcode project + Swift Package layout, GRDB schema, JMAP client (session discovery, Mailbox/Email get+query+changes), design system, account setup w/ autodiscovery | Read mail from a Stalwart account on an iPhone; offline cache works |
| **M1 — Daily-drivable mail (JMAP)** (6–8 wk) | Threading, reader w/ sanitized HTML, composer + send + drafts, flags/move/delete, unified inbox, local FTS (bodies), APNs push gateway on the Rocimail server | You dogfood your JMAP account as your primary mail app |
| **M2 — IMAP/SMTP** (5–6 wk) | IMAP sync engine (QRESYNC), SMTP submission, Gmail/Outlook.com OAuth, background-fetch fallback, default-mail-app registration | Any IMAP account usable end-to-end |
| **M3 — Calendar** (6–8 wk) | JMAP Calendars + CalDAV sync, all views, event CRUD + recurrence, iMIP invite cards in mail, reminders, widgets | Invites round-trip with Google/Fastmail/Outlook users |
| **M4 — Search everywhere** (4–5 wk) | **JMAP**: attachment extraction pipeline + OCR opt-in, query syntax + filter chips, `Email/query` server-search merge, Spotlight integration. **IMAP**: header/body local search + server `SEARCH` fallback only (attachment indexing optional, non-blocking) | "Find that PDF from March" works offline on a JMAP account; IMAP search covers headers/bodies of synced mail |
| **M5 — Encryption & power features** (6–8 wk) | OpenPGP + Autocrypt, S/MIME, app lock, snooze/send-later/undo-send, rules engine + Sieve management, templates, vacation responder | Feature parity checklist vs Zoho/Outlook signed off |
| **v1.0 App Store launch** | Onboarding, accessibility audit (VoiceOver, Dynamic Type), localization (en + 5), perf budget (cold start < 1.5 s, 60 fps lists), App Store review | Approved, crash-free > 99.5 % |

Post-v1 backlog: **Android (§14)**, iPad split-view layout, CardDAV contacts,
shared/delegated calendars & mailboxes, tasks (JMAP Tasks/CalDAV VTODO), Apple Watch
app, message translation, desktop exploration.

---

## 12. Testing, CI & Distribution

- **Engine tests run headless on macOS**: the Swift Packages have no UI dependency, so
  protocol clients test on CI against dockerized **Stalwart** (already in
  `docker-compose.yml`), Dovecot (IMAP edge cases), Greenmail; golden-file MIME and
  iCalendar corpora (malformed real-world samples); property tests for RRULE expansion
- **Sync engine simulation tests**: scripted server mutations vs op-log replay,
  offline/online chaos testing
- UI tests: XCUITest; snapshot tests for reader rendering
- CI: GitHub Actions (macOS runners) — package tests, lint (SwiftLint/SwiftFormat),
  app build; nightly TestFlight; release trains every 2 weeks
- Interop matrix tracked continuously: Stalwart, Fastmail, Gmail (IMAP), Outlook.com
  (IMAP), Yahoo, iCloud, Dovecot, Zoho — for both mail and calendar invite round-trips

---

## 13. Key Risks & Open Questions

1. **iOS background limits vs "instant" push for IMAP** — mitigated by the opt-in relay;
   needs clear UX honesty. Decision: build the relay in M2 or defer?
2. **MailCore2 age** — it works and ships in many clients, but it's C++/ObjC and lightly
   maintained. Contained behind the `IMAPProvider` protocol; budget for a SwiftNIO
   replacement if it becomes a drag. JMAP-first means this risk touches secondary
   accounts only.
3. **Attachment extraction cost** (battery/storage) — strict budgets + charge-only
   default; needs early instrumentation. Scope contained by design: extraction is a
   JMAP-account commitment, off by default for IMAP.
4. **JMAP Calendars is still a draft** — track the spec; the CalDAV path guarantees
   coverage regardless.
5. **Gmail OAuth verification** (restricted-scope audit for IMAP access) — start the
   CASA/verification process early in M2; app works with app-passwords meanwhile.
6. **Apple Developer requirements** — default-mail-client entitlement request, push
   certificates, and App Store review for a mail client (precedented, but plan lead time).
7. **Scope discipline**: parity with Outlook is a long tail — the M-gates above define
   "enough"; anything not listed goes to post-v1 backlog by default.

---

## 14. Android Later — Keeping the Door Open for Free

Android is out of scope for v1, and we deliberately pay **zero** cross-platform cost
now. What keeps a future Android app cheap without any framework today:

1. **Engine/UI separation**: all protocol, sync, store, search, and crypto code lives
   in UI-free Swift Packages (§3). That boundary *is* the port plan — the packages'
   public APIs become the spec for a Kotlin engine, and the test suites (which run
   headless) translate almost mechanically.
2. **The hardest logic is protocol logic**, and the protocols are documented RFCs plus
   our own interop test corpus — the second implementation is far cheaper than the first.
3. **The push gateway is shared infrastructure**: it's server-side and platform-neutral
   (APNs today, FCM added later), so Android inherits push for free.
4. **When the time comes**, the realistic options are (a) rewrite the engine in Kotlin
   against the same test corpus, or (b) port the engine to Kotlin Multiplatform and
   swap the iPhone app onto it gradually. Both stay open; neither requires deciding now.
