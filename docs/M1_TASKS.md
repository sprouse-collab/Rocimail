# M1 — Daily-Drivable Mail: Task Breakdown

Goal (outline §11): **dogfood your live JMAP account as your primary mail app.**
Builds directly on the green M0 foundation.

## Slice 1 — Compose, send, organize (engine + UI) ✅ in PR

- [x] **Send** — `Email/set` create + `EmailSubmission/set` batched with a
      back-reference; `onSuccessUpdateEmail` moves Drafts → Sent and clears
      `$draft`. Reply threading via `inReplyTo`/`references`.
- [x] **Identities** — `Identity/get`; engine caches per session.
- [x] **Offline send** — network failures queue the message in the outbox and
      replay later; user-actionable errors (bad recipient, no identity) throw
      instead of queueing.
- [x] **Drafts (basic)** — save draft to the Drafts mailbox.
- [x] **Move / delete** — `Email/set` mailboxIds update; local-first with
      outbox replay. Delete = move to Trash; delete from Trash = destroy.
- [x] **Threading** — store-level thread summaries (latest + counts) and
      cross-mailbox conversation fetch; threaded message list + thread view.
- [x] **Body FTS** — cached body text (plain, or tag-stripped HTML) joins the
      local search index; header re-upserts preserve it.
- [x] **Unified inbox (store)** — cross-account inbox query (UI arrives with
      the second account in M5).
- [x] **Composer UI** — To/Cc/Subject/plain-text body, reply / reply-all /
      forward prefills with quoting, compose button, send-or-queue feedback.

## Slice 2 — Reliability & polish (next)

- [ ] Drafts autosave loop (periodic save + resume editing from Drafts)
- [ ] Rich-text compose (bold/italic/lists/links) + attachment upload
- [ ] Inline `cid:` images in the reader via the blob cache; per-sender
      remote-image allow
- [ ] Archive swipe action + configurable swipe pairs
- [ ] Undo send (delayed submission with cancel window)
- [ ] Keychain credential persistence + session restore (carried from M0 T2.1)
- [ ] SQLCipher at rest (carried from M0 T1.3)

## Slice 3 — Push (server + app)

- [ ] **Push gateway on the Rocimail Node server**: JMAP `PushSubscription`
      relay → APNs with content-free payloads (needs Apple Developer APNs key
      from the user)
- [ ] Notification Service Extension: fetch on wake, build notification
      locally, actions (archive/delete/reply/mark-read)
- [ ] BGAppRefreshTask periodic fallback sync

## Exit criteria

Compose/reply/forward/send from the phone (queued cleanly when offline), delete
and move work with instant local feedback, conversations render threaded, and a
new-mail push lights up the lock screen within seconds of delivery to the
Stalwart server.
