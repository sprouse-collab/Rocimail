# Rocimail Mobile — Product & Technical Outline

An iPhone and Android email + calendar app supporting **JMAP** and **IMAP/SMTP** mail
accounts and **JMAP Calendars / CalDAV** calendar accounts, with **full-text search
including attachment contents**, optional **end-to-end encryption**, and a complete
daily-driver feature set comparable to Zoho Mail or Outlook Mobile — good enough to be
your default mail app on both platforms.

---

## 1. Vision & Goals

| Goal | What it means concretely |
| --- | --- |
| Daily-driver mail app | Fast unified inbox, reliable push notifications, offline reading and composing, set-as-default on iOS and Android |
| Protocol-native | JMAP first-class (RFC 8620/8621), IMAP/SMTP fully supported for everything else — no proprietary gateway required |
| Calendar built in | Events, invites, recurrence, reminders, multiple accounts — JMAP Calendars and CalDAV |
| Search everything | **JMAP: critical-path, full-depth search** — local full-text index over headers, bodies, and extracted attachment text, merged with server-side search. IMAP: lighter tier — headers/bodies of synced mail plus server `SEARCH`; attachment indexing best-effort only |
| Private & secure | TLS everywhere, encrypted local storage, optional OpenPGP/S/MIME end-to-end encryption, remote-image/tracker blocking |
| One codebase | Shared core across iOS and Android with native-feeling UI |

### Non-goals (v1)

- Exchange ActiveSync / EWS / proprietary Gmail API accounts (IMAP covers Gmail; revisit later)
- Contacts management app (read-only address autocomplete from system contacts + mail history in v1; CardDAV sync in v2)
- Desktop clients (the existing Rocimail web app remains the desktop story)
- Hosting mail — this is a client only

### Relationship to the existing repo

Rocimail today is a Node/Express server + React web client that already normalizes JMAP
and IMAP behind one `MailProvider` interface. The mobile app **reuses the concepts, not
the runtime**: mobile talks JMAP/IMAP **directly** from the device (no middlebox holding
credentials), but the unified data model, provider abstraction, and JMAP-first design
carry over directly. The web app's server can later gain an optional **push-relay role**
(see §7) for IMAP accounts.

---

## 2. Platform & Tech Stack

### Recommendation: Kotlin Multiplatform (KMP) core + native UI

| Layer | iOS | Android | Shared |
| --- | --- | --- | --- |
| UI | SwiftUI | Jetpack Compose | — (design system spec shared) |
| App logic / view models | — | — | Kotlin Multiplatform |
| Protocol clients (JMAP, IMAP, SMTP, CalDAV) | — | — | KMP (ktor / okio) |
| Sync engine, rules engine | — | — | KMP |
| Local store | — | — | SQLite via SQLDelight + FTS5 |
| Crypto | CryptoKit bridge | Tink/BouncyCastle bridge | Common interface in KMP |
| Attachment text extraction | PDFKit + native libs | pdfbox-android + native libs | Common interface, per-platform impls |

**Why KMP over the alternatives:**

- **React Native / Expo**: fastest to demo, but long-lived sockets (IMAP IDLE), heavy
  parsing (MIME, iCalendar), background sync, and an FTS index are all fights against
  the JS runtime and bridge. Poor fit for a protocol-heavy offline-first app.
- **Flutter**: solid, but a mail app must feel native (share sheets, notification
  actions, default-app integration, system fonts/gestures), and Dart's mail/crypto
  library ecosystem is thinner than JVM's.
- **KMP**: the entire hard core (protocols, sync, storage, search, crypto policy) is
  shared and testable on the JVM, while each platform keeps a fully native UI and
  first-class OS integration. The JVM ecosystem has mature MIME and crypto libraries,
  and Kotlin/Native handles iOS. This is the same architecture as several shipping
  mail clients.

**Fallback position**: if team skill set is strongly web, React Native + a Rust core
(via UniFFI) for protocols/search is the alternative; decision checkpoint at end of M0.

### Minimum OS targets

- iOS 16+ (needed: default mail app support ✅ iOS 14+, Live Activities optional)
- Android 10+ (API 29; needed: RoleManager for default handler, modern WorkManager)

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Native UI (SwiftUI / Compose)                              │
│    Mailbox list · Thread list · Reader · Composer ·         │
│    Calendar views · Search · Settings                       │
├─────────────────────────────────────────────────────────────┤
│  Shared Core (Kotlin Multiplatform)                         │
│                                                             │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ MailProvider  │  │ CalProvider  │  │  Search Service  │  │
│  │  interface    │  │  interface   │  │  (FTS5 index +   │  │
│  ├───────┬───────┤  ├──────┬───────┤  │  attachment      │  │
│  │ JMAP  │ IMAP/ │  │ JMAP │CalDAV │  │  text extractor) │  │
│  │       │ SMTP  │  │ Cal  │       │  └──────────────────┘  │
│  └───────┴───────┘  └──────┴───────┘                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Sync Engine  (delta sync, outbox, conflict handling, │   │
│  │ background scheduling, push-wakeup handlers)         │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────┐ ┌────────────┐ ┌───────────────────────┐  │
│  │ Crypto/E2EE  │ │ Rules      │ │ Local Store (SQLite,  │  │
│  │ (PGP, S/MIME)│ │ engine     │ │ SQLCipher, FTS5, blob │  │
│  └──────────────┘ └────────────┘ │ cache w/ eviction)    │  │
│                                  └───────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Platform services: Keychain/Keystore · Push (APNs/FCM) ·   │
│  BackgroundTasks/WorkManager · Share sheet · Default-app    │
└─────────────────────────────────────────────────────────────┘
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
     advertised (XOAUTH2 for Gmail/Outlook.com IMAP; OAuth for JMAP per RFC 8620),
     app-specific passwords supported.
- **Credential storage**: iOS Keychain / Android Keystore only; never in the DB.
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
- Attachments: files, photos, camera, scanned documents; size warnings; background upload
- Per-account signatures (rich text) and reply-above/below preference
- **Undo send** (configurable 5–30 s delay), **send later / scheduled send**,
  read-receipt requests (send + respond policy)
- Drafts autosave locally + sync to server Drafts folder
- Aliases / send-as identities per account; reply-from-the-address-it-was-sent-to
- Templates / canned responses; quick-reply suggestions (on-device only)

### Organization & automation
- **Rules/filters engine**: client-side rules (run on sync) + management of
  server-side JMAP Sieve scripts where supported (RFC 9661 sieve-over-JMAP)
- Labels/keywords (JMAP keywords; IMAP FLAGS where server permits arbitrary flags)
- Auto-forwarding management UI (writes Sieve where available; otherwise documents
  server-side setup), vacation responder (JMAP `VacationResponse`; Sieve for IMAP hosts)
- Block sender / unsubscribe (RFC 8058 one-click List-Unsubscribe, mailto fallback)
- Spam handling: move-to-junk with server flag training (Junk/NotJunk keywords)

### Notifications
- Per-account and per-folder notification rules; VIP senders; quiet hours
- Rich notifications with actions: archive, delete, reply (inline), mark read
- Grouped by conversation; badge counts

### Safety
- HTML sanitization + sandboxed rendering (WKWebView / WebView with JS disabled,
  CSP, no external navigation)
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
  - **SQLite FTS5** (trigram + unicode61 tokenizers; CJK via ICU) over subject,
    from/to/cc, body text (HTML→text), filenames, **and extracted attachment text**
  - **Attachment text extraction pipeline** (background, budgeted):
    - PDF (per-page text; OCR for image-only PDFs via platform Vision/ML Kit — opt-in, on-device only)
    - Office: docx/xlsx/pptx (XML unzip + text pull), legacy doc/xls best-effort
    - Plain/rtf/csv/markdown/html; .eml/.ics nested messages
    - Images: EXIF + on-device OCR (opt-in)
    - Extraction runs on charge+Wi-Fi by default; per-account size caps; queue survives restarts
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

---

## 7. Sync Engine & Push (the mobile-specific hard part)

### Delta sync
- **JMAP**: `Email/changes`, `Mailbox/changes`, `Thread/changes` with `sinceState`;
  batched backfill (newest N days first, then progressive history); blob download on demand
- **IMAP**: CONDSTORE/QRESYNC (RFC 7162) where available; fallback UID-based diffing;
  BODYSTRUCTURE-driven lazy part fetch; special-use detection (RFC 6154)
- Configurable sync window per account (e.g. 30 days offline, older-on-demand)
- Conflict policy: server wins for flags/moves, client op-log replays idempotently

### Push notifications (per-platform constraints drive the design)
- **JMAP accounts**: JMAP Push via `PushSubscription` → APNs/FCM. Requires a small
  **push gateway** service (extends the existing Rocimail server): the JMAP server
  POSTs `StateChange` to the gateway, which relays to APNs/FCM with encrypted payloads
  (server never sees message content, only "state changed" + account hash).
- **IMAP accounts**: no true push without a connection. Options, in order:
  1. Optional **Rocimail relay**: user opts in; relay holds IMAP IDLE (credentials
     end-to-end encrypted to the relay, clearly disclosed) and pings APNs/FCM.
  2. Without relay: OS background fetch (BGAppRefreshTask / WorkManager periodic,
     15-min best case) — honest "battery-friendly, not instant" setting.
- Notification content pulled by the app on wake (mutable-content extension on iOS
  fetches sender/subject and decrypts PGP subject lines where applicable).

### Background execution
- iOS: BGAppRefreshTask + BGProcessingTask (indexing, extraction), silent pushes for
  JMAP state changes
- Android: Foreground-less WorkManager chains; optional persistent IMAP IDLE
  foreground service (user-visible toggle, like K-9/FairEmail)

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
- Event CRUD: title, location (map preview), description, attendees with availability
  lookup (free/busy via JMAP/CalDAV where offered), attachments, travel time
- **Recurrence**: full RRULE support incl. exceptions (RDATE/EXDATE, this-and-future edits)
- Reminders/alerts (multiple per event, default per calendar), all-day & multi-TZ events,
  secondary time zone ruler
- **Invites in mail**: inline RSVP card in the reader (accept/tentative/decline w/
  comment), auto-file processed invites, counter-proposals
- Local device calendar overlay (EventKit / CalendarProvider read-only merge view, opt-in)
- Offline edits queue through the same outbox; widgets: today agenda + month grid
- Natural-language quick add ("lunch with Sam Fri 1pm") parsed on-device

---

## 9. Encryption & Security

### Transport & at-rest (always on)
- TLS 1.2+ enforced, certificate pinning optional per account, MTA-STS awareness
- Local DB encrypted (SQLCipher) with key in Secure Enclave / StrongBox Keystore
- App lock: Face ID / Touch ID / fingerprint / PIN, with per-launch or timed lock
- Blob cache encrypted; screenshots redacted in app switcher (optional)

### End-to-end encryption (enable per account — "when enabled")
- **OpenPGP** (RFC 9580) via sequoia-pgp (Rust, FFI) or Bouncy Castle:
  - Sign / encrypt / decrypt / verify in composer & reader with clear status chips
  - Key generation on device, import (file/QR/clipboard), export with passphrase
  - **Autocrypt** (Level 1) header-based opportunistic key exchange + peer state
  - Key discovery: WKD, HKP keyservers (opt-in), attached keys
  - Encrypted subject (protected headers / "memory hole") support
- **S/MIME**: certificate import (PKCS#12), sign/encrypt/verify, chain validation —
  needed for business/gov parity with Outlook
- Searchable ciphertext policy: decrypted bodies are indexed **only** into the
  encrypted local index, opt-out available ("never index encrypted mail")
- Explicit UX: padlock states (E2EE / TLS-only / unsigned), never silently downgrade;
  warn when adding a recipient without a key

### Privacy posture
- No telemetry by default; opt-in crash reporting only; no content ever to third parties
- All ML/OCR/NLP features on-device
- Open-source core (same spirit as the existing repo)

---

## 10. "Main Email App" — OS Integration

### iOS
- Register as **default mail app** (`MailTo` scheme + entitlement, iOS 14+): handles
  `mailto:` links from any app
- Share sheet extension ("share file → new Rocimail message"), document interaction
  for .eml/.ics files
- Widgets (inbox glance, agenda), App Shortcuts / Siri intents ("compose", "search mail"),
  Handoff between devices, Spotlight indexing of messages (CoreSpotlight, respects app lock)

### Android
- `RoleManager` / default handler for `mailto:` intents; direct share targets
- Widgets (inbox list, agenda, compose shortcut), quick-settings tile
- .eml/.ics file association; share-to-compose; content provider for other apps (guarded)

---

## 11. Delivery Roadmap

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| **M0 — Foundations** (4–6 wk) | KMP skeleton, SQLDelight schema, JMAP client (session, Mailbox/Email get+query+changes), design system, account setup w/ autodiscovery | Read mail from a Stalwart account on both platforms, offline cache works |
| **M1 — Daily-drivable mail (JMAP)** (6–8 wk) | Threading, reader w/ sanitized HTML, composer + send + drafts, flags/move/delete, unified inbox, local FTS (bodies), APNs/FCM push gateway | Team dogfoods JMAP accounts as primary app |
| **M2 — IMAP/SMTP parity** (6 wk) | IMAP sync engine (QRESYNC), SMTP submission, Gmail/Outlook.com OAuth, background fetch fallback, default-app registration both platforms | Any IMAP account usable end-to-end |
| **M3 — Calendar** (6–8 wk) | JMAP Calendars + CalDAV sync, all views, event CRUD + recurrence, iMIP invite cards in mail, reminders, widgets | Invites round-trip with Google/Fastmail/Outlook users |
| **M4 — Search everywhere** (4–6 wk) | **JMAP**: attachment extraction pipeline + OCR opt-in, query syntax + filter chips, `Email/query` server-search merge, Spotlight integration. **IMAP**: header/body local search + server `SEARCH` fallback only (attachment indexing optional, non-blocking) | "Find that PDF from March" works offline on a JMAP account; IMAP search covers headers/bodies of synced mail |
| **M5 — Encryption & power features** (6–8 wk) | OpenPGP + Autocrypt, S/MIME, app lock, snooze/send-later/undo-send, rules engine + Sieve management, templates, vacation responder | Feature parity checklist vs Zoho/Outlook signed off |
| **v1.0 launch** | Store polish: onboarding, accessibility audit (VoiceOver/TalkBack), localization (en + 5), perf budget (cold start < 1.5 s, 60 fps lists) | App Store + Play review passed, crash-free > 99.5 % |

Post-v1 backlog: CardDAV contacts, shared/delegated calendars & mailboxes, tasks
(JMAP Tasks/CalDAV VTODO), tablet/foldable layouts, watch apps, message translation,
snippet-based smart compose, desktop (KMP → Compose Desktop) exploration.

---

## 12. Testing, CI & Distribution

- **Shared-core tests on JVM**: protocol clients against dockerized **Stalwart** (already
  in `docker-compose.yml`), Dovecot (IMAP edge cases), Greenmail; golden-file MIME and
  iCalendar corpora (malformed real-world samples); property tests for RRULE expansion
- **Sync engine simulation tests**: scripted server mutations vs op-log replay,
  offline/online chaos testing
- UI tests: XCUITest / Compose testing; screenshot diffing for reader rendering
- CI: GitHub Actions — KMP tests, lint, iOS + Android build matrix; nightly TestFlight
  / Play internal track; release trains every 2 weeks
- Interop matrix tracked continuously: Stalwart, Fastmail, Gmail (IMAP), Outlook.com
  (IMAP), Yahoo, iCloud, Dovecot, Zoho — for both mail and calendar invite round-trips

---

## 13. Key Risks & Open Questions

1. **iOS background limits vs "instant" push for IMAP** — mitigated by the opt-in relay;
   need clear UX honesty. Decision: build relay in M2 or defer?
2. **Attachment extraction cost** (battery/storage) — strict budgets + charge-only
   default; needs early instrumentation. Scope is contained by design: extraction is
   a JMAP-account commitment, off by default for IMAP.
3. **KMP crypto FFI** (sequoia-pgp via Rust) adds build complexity — spike in M0;
   Bouncy Castle (Android) + ObjectivePGP (iOS) behind one interface is the fallback.
4. **JMAP Calendars is still a draft** — track spec; CalDAV path guarantees coverage.
5. **Gmail OAuth verification** (restricted scope audit for IMAP access) — start the
   CASA/verification process early in M2; app works with app-passwords meanwhile.
6. **Scope discipline**: parity with Outlook is a long tail — the M-gates above define
   "enough"; anything not listed goes to post-v1 backlog by default.
