# Archive Tier — QNAP Stalwart Runbook (Planning)

The archive tier serves the **exported mail from old company accounts** (domains since
sold — no new mail will ever arrive) currently stored as **EML/Maildir files on the
QNAP NAS**. Instead of re-uploading it to the VPS (defeating the point of the export)
or teaching the iPhone app to read mail files, we stand up a **second Stalwart
instance on the QNAP itself** and import the files into it **once**. The result is a
normal JMAP account: server-side full-text search (including attachments) over the
entire archive, storage on the NAS where space is cheap, and zero archive-specific
code in the app.

This is a planning runbook; exact commands get pinned down when M2 executes.

## 1. Stalwart in Container Station

- Run the official `stalwartlabs/stalwart` image in Container Station; **pin a specific
  version tag** (upgrade deliberately, not automatically — this box should be boring).
- Volumes on NAS storage: one for config, one for data (the mail store + FTS index —
  expect the index to add meaningful size on top of the imported mail; leave headroom).
- Modest resource limits (it idles after import; search bursts are short).
- First-run: grab the generated admin password from container logs (same procedure as
  this repo's `docker-compose.yml` dev instance), open the admin UI on the LAN.
- Create one mail account, e.g. `archive@archive.local` (any internal domain works —
  this server never sends or receives real mail; SMTP listeners can stay disabled).

## 2. One-time import

**Layout convention — one account, one folder tree per old company:**

```
Archive account
├── AcmeCorp/
│   ├── Inbox
│   ├── Sent
│   └── …
├── OldCo2/
│   ├── Inbox
│   └── …
```

Provenance stays visible in the folder structure, and a single unified search spans
every old account at once.

**Import paths, by source format:**

- **Maildir trees**: import directly with Stalwart's CLI import (Maildir is a
  supported source format), one run per old account, targeting that account's
  subtree.
- **Loose `.eml` files**: either (a) wrap them into a Maildir skeleton
  (`cur/ new/ tmp/` — a trivial script; filenames don't need special flags for
  archived mail) and use the same CLI import, or (b) IMAP `APPEND` them with a small
  script that sets each message's `INTERNALDATE` from the `Date:` header so
  sorting/date-range search behave correctly.

**Verification (per old account):** compare source file count vs imported message
count; spot-check oldest/newest messages, a message with a PDF attachment (open it),
and a server-side search for a term that only exists inside an attachment. Keep the
source files until all checks pass — and see §5 on keeping them, period.

## 3. Remote access — Tailscale, no open ports

- Install Tailscale on the QNAP (official QNAP package) and join it to the same
  tailnet as the iPhone.
- On the iPhone, enable Tailscale's **on-demand VPN** so the tunnel comes up
  automatically — the archive account then "just works" anywhere without the user
  thinking about the VPN.
- The app signs into the archive via its tailnet address (MagicDNS name, e.g.
  `https://qnap.tailnet-name.ts.net`; Tailscale can provision a valid TLS cert for
  it). **No ports are forwarded** on the home network; the archive server is never
  internet-facing.
- App behavior when the tailnet is unreachable: a clear "archive offline" state on
  that account and its search scope — never a silent partial result, and never a
  stalled unified view.

## 4. Read-only posture

- After import verification, the archive is **frozen**: no sending identity is
  configured in the app, and moves/deletes are disabled by default for this account
  (a deliberate settings override exists, but nothing in normal use mutates it).
- No push subscription, no retention/sync jobs, no cron — new mail lives on the VPS
  under a different domain and never touches this box.
- Practical consequence: sync cost is ~zero (state never changes), and the app's
  archive default is envelopes-on-demand with no backfill; users can opt chosen
  folders/date ranges into the local FTS index for offline search.

## 5. Backups

The Stalwart data volume joins the QNAP's existing backup routine. **Keep the original
EML/Maildir export as the archival source of truth** (cold copy is fine) — it is
format-portable forever, and a future re-import (new server, schema change, disaster)
starts from it rather than from a database backup.
