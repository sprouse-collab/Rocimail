# Rocimail for iPhone — Product & Technical Outline

An **iPhone** email + calendar app for **JMAP** mail (with **IMAP/SMTP** accounts
connected through a self-hosted gateway) and **JMAP Calendars / CalDAV** calendars,
with **full-text search including attachment contents** (critical for JMAP; lighter
for gateway-backed IMAP), optional **end-to-end encryption**, and a complete
daily-driver feature set comparable to Zoho Mail or Outlook — good enough to set as
your default mail app on iOS.

**Scope decisions**:

- **iPhone-only for v1**, built in plain Swift/SwiftUI with no cross-platform
  framework. Android is a possible future phase (see §14) and nothing in v1 blocks it.
- **The app speaks JMAP only.** IMAP/SMTP accounts are presented as JMAP by a
  **gateway** built into the existing Rocimail Node server (§7) — no IMAP code ships
  on the device.
- **Two-tier mail storage** (§3): live mail on the Stalwart VPS; a static, read-only
  **archive** of old company accounts (domains since sold, no new mail ever) on a
  second Stalwart instance running on the user's QNAP NAS, reached over Tailscale.
  To the app the archive is just another JMAP account.
- **Live account first.** The full feature set (mail, calendar, search, encryption)
  is built and polished against the primary VPS JMAP account before any secondary
  account work begins. The gateway and archive tier are a late milestone (§11, M5)
  that does not block the v1.0 launch.

---

## 1. Vision & Goals

| Goal | What it means concretely |
| --- | --- |
| Daily-driver mail app | Fast unified inbox, reliable push notifications, offline reading and composing, set-as-default on iOS |
| JMAP-only client | The app implements one protocol (RFC 8620/8621). IMAP/SMTP accounts connect via the self-hosted Rocimail gateway; the QNAP archive is a native JMAP server |
| Two-tier storage | Live mail on the Stalwart VPS (always reachable, stays small); read-only historical archive on QNAP Stalwart over Tailscale, searchable like any account |
| Calendar built in | Events, invites, recurrence, reminders, multiple accounts — JMAP Calendars and CalDAV |
| Search everything | **JMAP: critical-path, full-depth search** — local full-text index over headers, bodies, and extracted attachment text, merged with server-side search. IMAP: lighter tier — headers/bodies of synced mail plus server `SEARCH`; attachment indexing best-effort only |
| Private & secure | TLS everywhere, encrypted local storage, optional OpenPGP/S/MIME end-to-end encryption, remote-image/tracker blocking |
| Feels like an Apple app | Pure SwiftUI, native gestures/share sheet/widgets/Spotlight — no cross-platform runtime between us and iOS |

### Non-goals (v1)

- **Android** (deferred — see §14 for the path; nothing in v1 forecloses it)
- **On-device IMAP/SMTP protocol code** (the gateway owns it; the app never speaks IMAP)
- Exchange ActiveSync / EWS / proprietary Gmail API accounts (IMAP covers Gmail; revisit later)
- Contacts management app (address autocomplete from system contacts + mail history in v1; CardDAV sync in v2)
- iPad-optimized layout (runs scaled; real split-view layout post-v1)
- Hosting mail — this is a client only

### Relationship to the existing repo

Rocimail today is a Node/Express server + React web client that already normalizes JMAP
and IMAP behind one `MailProvider` interface (`server/src/imap.ts`, `server/src/jmap.ts`).
That server is no longer just the web backend — it becomes the **gateway**: it presents
IMAP/SMTP accounts to the phone as JMAP, holds IMAP IDLE connections, and relays push
to APNs (§7). The phone talks JMAP directly to the VPS Stalwart and the QNAP archive;
only third-party IMAP accounts pass through the gateway, which the user self-hosts
alongside Stalwart.

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
| IMAP/SMTP accounts | **Rocimail gateway** (TypeScript, extends the existing Node server's `imap.ts` provider) presents them as JMAP — zero IMAP or MIME-parsing code on the device |
| Archive access | Second Stalwart instance on the QNAP (Container Station), reached over **Tailscale** (iOS on-demand VPN profile) — plain JMAP to the app |
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
best debugging, and the most native result. The only real cost — JMAP client code that
Android can't reuse someday — is addressed by the package structure in §14, and the
JMAP-only decision shrinks that surface further: the gateway (TypeScript) and both
Stalwart instances are platform-neutral already.

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
│  RociMail        JMAP client (URLSession + Codable) —      │
│                  every mail account is a JMAP endpoint:    │
│                  VPS Stalwart, QNAP archive, or gateway    │
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

### Deployment topology

```
                        ┌──────────────────────────────────────┐
                        │  VPS                                 │
  ┌────────┐   JMAP     │  ┌──────────┐   ┌────────────────┐  │
  │ iPhone │◄──HTTPS───►│  │ Stalwart │   │ Rocimail       │  │
  │  app   │            │  │ (live    │   │ gateway        │  │
  └───┬────┘   JMAP     │  │  mail)   │   │ IMAP⇄JMAP +    │  │──IMAP/SMTP──► Gmail,
      │    ◄───HTTPS───►│  └────┬─────┘   │ APNs push +    │  │               work
      │                 │       └────────►│ IMAP IDLE      │  │               accts…
      │                 │   StateChange   └────────────────┘  │
      │                 └──────────────────────────────────────┘
      │   JMAP over Tailscale   ┌───────────────────────────┐
      └────────────────────────►│  QNAP (Container Station) │
                                │  Stalwart — read-only     │
                                │  archive of old company   │
                                │  accounts (one-time       │
                                │  EML/Maildir import)      │
                                └───────────────────────────┘
```

Three JMAP endpoints, one client code path. The archive is static (the old domains
receive no new mail), so it needs no push, no sending identity, and no sync jobs —
the app treats it as a read-only, server-searchable account.

**Local-first**: the UI reads *only* from the local store; the sync engine reconciles
with servers. Every mutation (flag, move, delete, send, event edit) is written locally
first, queued in an **outbox/op-log**, and replayed to the server with retry — so the
app is fully usable offline and never blocks on the network.

---

## 4. Accounts & Authentication

- **Account types** (all JMAP to the app): direct JMAP (VPS Stalwart, QNAP archive),
  gateway-backed IMAP+SMTP, plus CalDAV (calendar). One "identity" can bundle e.g.
  gateway mail + CalDAV calendar. The archive account is flagged **read-only**
  (search/read; no compose identity; moves/deletes disabled by default).
- **Setup flow**:
  1. Enter email address → autodiscovery: `/.well-known/jmap` (JMAP), RFC 6764
     `_caldavs._tcp` SRV for CalDAV → manual settings screen as fallback. Adding an
     IMAP account happens against the gateway (host/port/TLS form, like the web app's
     "+ Add IMAP account" flow); the gateway verifies by connecting.
  2. Auth: password (Basic) for JMAP; **OAuth 2.0** where advertised (RFC 8620 for
     JMAP; XOAUTH2 tokens for Gmail/Outlook.com obtained in-app via
     `ASWebAuthenticationSession` and stored by the gateway), app-specific passwords
     supported.
- **Credential storage**: iOS Keychain for JMAP credentials; IMAP credentials/tokens
  live on the self-hosted gateway (disclosed clearly in the add-account flow).
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
hard requirement for native JMAP accounts** (VPS live mail and the QNAP archive);
**gateway-backed IMAP search is a lighter, good-enough tier** and must never block
or complicate the JMAP path.

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

**The QNAP archive gets the full-depth path for free**: it's a real Stalwart, so its
server-side index covers all imported mail including attachments. Archive search
requires tailnet reachability (on-demand VPN makes this near-transparent); the app
shows a clear "archive unreachable" state instead of silently returning partial
results, and the user can optionally sync chosen archive folders/date ranges into
the local FTS index for fully offline search.

### Gateway-backed IMAP accounts (lighter tier)
- Local FTS over **headers and bodies of synced mail only** (same FTS5 index, same UX)
- Server fallback: the app issues a normal JMAP `Email/query`; the gateway translates
  it to IMAP `SEARCH` (`TEXT`/`BODY`; `X-GM-RAW` on Gmail) for unsynced history
- **Attachment content indexing is best-effort and off by default** for IMAP accounts:
  the extraction pipeline can be enabled per account in settings, but it is not part
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
- **The app implements exactly one sync engine** — JMAP: `Email/changes`,
  `Mailbox/changes`, `Thread/changes` with `sinceState`; batched backfill (newest
  N days first, then progressive history); blob download on demand
- **IMAP mechanics live in the gateway**: it maps CONDSTORE/QRESYNC (RFC 7162), UID
  diffing, BODYSTRUCTURE lazy fetch, and special-use detection (RFC 6154) onto
  JMAP-style state strings. The hardest part is state mapping (IMAP `UIDVALIDITY`
  resets → JMAP `cannotCalculateChanges`, which the app already handles for real
  JMAP servers)
- **Archive**: syncs like any JMAP account but is effectively immutable — after
  initial state it produces no changes, so it costs nothing at refresh time
- Configurable sync window per account (e.g. 30 days offline, older-on-demand;
  archive default: envelopes-on-demand only, no backfill)
- Conflict policy: server wins for flags/moves, client op-log replays idempotently

### Push notifications (iOS constraints drive the design)
iOS kills background sockets, so "instant mail" requires APNs:

- **JMAP accounts (VPS)**: JMAP Push via `PushSubscription` → APNs. The Rocimail
  gateway doubles as the push relay: the JMAP server POSTs `StateChange` to it, and
  it relays to APNs with content-free payloads (never message content, only "state
  changed" + account hash). The app wakes via a Notification Service Extension,
  fetches the new mail itself, and builds the notification locally (sender/subject,
  decrypted where applicable).
- **Gateway-backed IMAP accounts**: solved by the same gateway — it already holds
  IMAP IDLE connections for sync, so new-mail events flow through the identical
  APNs path. No background-fetch compromise needed.
- **Archive**: no push — nothing ever arrives there.

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
| **M2 — Calendar** (6–8 wk) | JMAP Calendars + CalDAV sync, all views, event CRUD + recurrence, iMIP invite cards in mail, reminders, widgets, default-mail-app registration | Invites round-trip with Google/Fastmail/Outlook users |
| **M3 — Search everywhere** (4–5 wk) | Attachment extraction pipeline + OCR opt-in, query syntax + filter chips, `Email/query` server-search merge, Spotlight integration — all against the live JMAP account | "Find that PDF from March" works offline |
| **M4 — Encryption & power features** (6–8 wk) | OpenPGP + Autocrypt, S/MIME, app lock, snooze/send-later/undo-send, rules engine + Sieve management, templates, vacation responder | Feature parity checklist vs Zoho/Outlook signed off — the live account is a complete daily driver |
| **M5 — Secondary accounts** (3–4 wk, **does not block v1.0**) | **Mostly server-side, no Mac needed**: JMAP façade on the Rocimail Node server over the existing `imap.ts` provider (state mapping, IDLE, APNs relay), Gmail/Outlook.com OAuth token handling; QNAP Stalwart deployment + one-time EML/Maildir import (see `ARCHIVE_TIER.md`); Tailscale setup; read-only account UX + lighter IMAP search tier (§6) in the app | A Gmail-via-gateway account and the QNAP archive both work end-to-end; archive search finds old-company mail incl. attachments |
| **v1.0 App Store launch** | Onboarding, accessibility audit (VoiceOver, Dynamic Type), localization (en + 5), perf budget (cold start < 1.5 s, 60 fps lists), App Store review. Ships after M4; M5 lands before or in a 1.x update, whichever the schedule favors | Approved, crash-free > 99.5 % |

Post-v1 backlog: **Android (§14)**, iPad split-view layout, CardDAV contacts,
shared/delegated calendars & mailboxes, tasks (JMAP Tasks/CalDAV VTODO), Apple Watch
app, message translation, desktop exploration.

**Sequencing rationale**: the live VPS account exercises every feature the app will
ever have; secondary accounts (gateway IMAP, QNAP archive) reuse those features
unchanged over additional JMAP endpoints. Building them last means the multi-account
plumbing (already in the data model from M0) is validated against a finished, stable
feature set — and the app is launchable the moment the primary experience is done.

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

1. **Gateway availability = IMAP-account availability** — if the self-hosted gateway
   is down, third-party IMAP accounts are unreachable (VPS JMAP mail is unaffected).
   Mitigate: run it alongside Stalwart on the VPS with monitoring/auto-restart;
   cached mail still reads offline.
2. **Gateway state mapping is the main new engineering risk** — translating IMAP
   UIDVALIDITY/QRESYNC semantics into JMAP-style state strings correctly. Contained:
   it's TypeScript on the existing `imap.ts` provider, testable headlessly against
   Dovecot/Gmail without a Mac, and the app-side fallback (`cannotCalculateChanges`
   → refetch window) must work for real JMAP servers anyway.
3. **Archive reachability depends on the tailnet** — Tailscale's iOS on-demand VPN
   makes this near-transparent, but the app needs a graceful "archive offline" state
   and must never let an unreachable archive stall unified views or search.
4. **Attachment extraction cost** (battery/storage) — strict budgets + charge-only
   default; needs early instrumentation. Scope contained by design: extraction is a
   JMAP-account commitment, off by default for gateway accounts, and the archive is
   indexed server-side by Stalwart anyway.
5. **JMAP Calendars is still a draft** — track the spec; the CalDAV path guarantees
   coverage regardless.
6. **Gmail OAuth verification** (restricted-scope audit for IMAP access) — start the
   CASA/verification process when M5 is scheduled; app works with app-passwords
   meanwhile — and this whole risk now sits outside the v1.0 critical path.
7. **Apple Developer requirements** — default-mail-client entitlement request, push
   certificates, and App Store review for a mail client (precedented, but plan lead time).
8. **Scope discipline**: parity with Outlook is a long tail — the M-gates above define
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
3. **Most of the system is already platform-neutral**: the gateway (IMAP⇄JMAP + push;
   APNs today, FCM added later), both Stalwart instances, and the QNAP archive are
   server-side — an Android app would reuse all of it and only needs the JMAP client
   + UI, the same small surface the iPhone app implements.
4. **When the time comes**, the realistic options are (a) rewrite the engine in Kotlin
   against the same test corpus, or (b) port the engine to Kotlin Multiplatform and
   swap the iPhone app onto it gradually. Both stay open; neither requires deciding now.
