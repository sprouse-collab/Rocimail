# Rocimail

A Zoho-Mail-style webmail client built **JMAP-first** for [Stalwart](https://stalw.art) mail
servers, with **IMAP/SMTP support for secondary accounts** — so you can read and send from
your JMAP mailbox and any number of legacy IMAP mailboxes in one unified interface.

## Features

- **JMAP primary account** (RFC 8620 / RFC 8621): session auto-discovery via
  `/.well-known/jmap`, mailbox tree with unread counts, server-side search, message
  reading (HTML + plain text, inline images, attachments), flags (read/flagged),
  move/delete-to-trash, and sending via `EmailSubmission` with automatic save-to-Sent.
- **Secondary IMAP accounts**: connect any IMAP mailbox (with SMTP for outgoing mail)
  alongside the primary JMAP account. Folder listing with special-use detection
  (`\Sent`, `\Trash`, …), paging, search, flags, move/delete, attachment download, and
  sending with an exact copy appended to the Sent folder.
- **Zoho-Mail-style UI**: three-pane layout (folders / message list / reading pane),
  red-accent theme, slide-up composer window, per-folder search, unread badges,
  account switcher in the composer's From field.
- **Safe HTML rendering**: message bodies are sanitized with DOMPurify and rendered in
  a fully sandboxed iframe; inline `cid:` images are embedded as data URIs server-side.

## Architecture

```
web/     React + Vite + TypeScript single-page app (Zoho-style UI)
server/  Node + Express + TypeScript API server
           ├─ jmap.ts   JMAP provider (fetch-based, Basic auth) — primary account
           ├─ imap.ts   IMAP/SMTP provider (imapflow + mailparser + nodemailer)
           ├─ routes.ts unified REST API over a common MailProvider interface
           └─ sessions.ts in-memory session store (bearer tokens, 24 h idle TTL)
```

The browser never talks IMAP or JMAP directly. It calls the Rocimail server's REST API,
which normalizes both protocols into one data model (`MailProvider`), so every UI
feature works identically for JMAP and IMAP accounts.

## Getting started

```bash
npm install          # installs both workspaces
npm run dev          # server on :4000, web on :5173 (proxied /api)
```

Open http://localhost:5173 and sign in with:

- **Server URL** — your Stalwart (or other JMAP) server's base URL, e.g.
  `https://mail.example.com`. Rocimail discovers the JMAP session at
  `<url>/.well-known/jmap` (a full session URL is also accepted).
- **Email / password** — your mail account credentials (HTTP Basic auth).

After signing in, use **“+ Add IMAP account”** in the sidebar to attach secondary
mailboxes (IMAP host/port/TLS + SMTP host/port/TLS, with optional separate SMTP
credentials).

### Production build

```bash
npm run build        # builds server/dist and web/dist
npm start            # serves the API and the built SPA on :4000
```

### Local Stalwart test server

A ready-to-run Stalwart instance for development:

```bash
docker compose up -d stalwart
# initial admin credentials are printed in the container logs:
docker compose logs stalwart | grep -i password
```

Then open the Stalwart admin UI at http://localhost:8080, create a mail account, and
sign in to Rocimail with server URL `http://localhost:8080`.

## API overview

All endpoints are under `/api` and (except login) require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/login` | JMAP session discovery + sign-in `{server, email, password}` |
| POST | `/auth/logout` | Destroy the session |
| GET | `/accounts` | List connected accounts |
| POST | `/accounts` | Add a secondary IMAP account (verifies by connecting) |
| DELETE | `/accounts/:id` | Remove a secondary account |
| GET | `/accounts/:id/mailboxes` | Folder tree with unread counts |
| GET | `/accounts/:id/mailboxes/:mb/messages` | Page of messages (`limit`, `offset`, `q`) |
| GET | `/accounts/:id/mailboxes/:mb/messages/:msg` | Full message (bodies, attachments) |
| POST | `.../messages/flags` | Set `$seen` / `$flagged` (JMAP) or `\Seen` / `\Flagged` (IMAP) |
| POST | `.../messages/move` | Move to another folder |
| POST | `.../messages/delete` | Move to Trash (or expunge when already in Trash) |
| GET | `.../messages/:msg/attachments/:att` | Download an attachment |
| POST | `/accounts/:id/send` | Send mail (JMAP `EmailSubmission` or SMTP) |

## Notes & limitations (v0.1)

- Sessions and IMAP credentials live **in server memory only** — nothing is persisted
  to disk, and a server restart signs everyone out. Run the server over HTTPS in any
  real deployment.
- Compose is plain-text (rendered safely on the receiving side); rich-text editing,
  drafts autosave, and attachment upload are not implemented yet.
- IMAP message lists page by mailbox sequence and search uses IMAP `SEARCH`
  (subject/from/to/body OR); previews are shown for JMAP messages only.
- Threading is not surfaced in the UI yet (JMAP `threadId` is already in the model).
