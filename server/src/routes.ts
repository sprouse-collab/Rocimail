import { Router, type Request, type Response, type NextFunction } from 'express';
import { JmapProvider } from './jmap.js';
import { ImapProvider, type ImapAccountConfig } from './imap.js';
import { sessionStore, getAccount, type Session } from './sessions.js';
import { ApiError, type Alarm, type EmailAddress, type OutgoingMessage } from './types.js';

type Handler = (req: Request, res: Response) => Promise<void> | void;

const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

function requireSession(req: Request): Session {
  return sessionStore.get(bearerToken(req));
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, `Missing required field: ${field}`);
  }
  return value.trim();
}

function parseAddressList(value: unknown): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is { email: string; name?: string } => Boolean(a) && typeof a.email === 'string' && a.email.includes('@'))
    .map((a) => ({ email: a.email.trim(), name: typeof a.name === 'string' && a.name.trim() !== '' ? a.name.trim() : undefined }));
}

function parseDueAt(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) {
    throw new ApiError(400, 'dueAt must be a valid ISO 8601 date-time');
  }
  if (parsed <= Date.now()) {
    throw new ApiError(400, 'dueAt must be in the future');
  }
  return new Date(parsed).toISOString();
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    throw new ApiError(400, 'ids must be a non-empty array of strings');
  }
  return value as string[];
}

export function createRouter(): Router {
  const router = Router();

  // ---- Auth -----------------------------------------------------------------

  router.post(
    '/auth/login',
    wrap(async (req, res) => {
      const server = requireString(req.body, 'server');
      const email = requireString(req.body, 'email');
      const password = requireString(req.body, 'password');
      const provider = await JmapProvider.connect(server, email, password);
      const session = sessionStore.create();
      const accountId = 'primary';
      const info = provider.toAccountInfo(accountId);
      session.accounts.set(accountId, { info, provider });
      res.json({ token: session.token, account: info });
    })
  );

  router.post(
    '/auth/logout',
    wrap(async (req, res) => {
      const token = bearerToken(req);
      if (token) await sessionStore.destroy(token);
      res.json({ ok: true });
    })
  );

  // ---- Accounts -------------------------------------------------------------

  router.get(
    '/accounts',
    wrap((req, res) => {
      const session = requireSession(req);
      res.json({ accounts: [...session.accounts.values()].map((a) => a.info) });
    })
  );

  router.post(
    '/accounts',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const body = req.body ?? {};
      const imap = body.imap ?? {};
      const smtp = body.smtp ?? {};
      const config: ImapAccountConfig = {
        name: typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : requireString(body, 'email'),
        email: requireString(body, 'email'),
        imap: {
          host: requireString(imap, 'host'),
          port: Number(imap.port) || (imap.secure === false ? 143 : 993),
          secure: imap.secure !== false,
          username: requireString(imap, 'username'),
          password: requireString(imap, 'password'),
        },
        smtp: {
          host: requireString(smtp, 'host'),
          port: Number(smtp.port) || (smtp.secure === true ? 465 : 587),
          secure: smtp.secure === true,
          username: typeof smtp.username === 'string' && smtp.username !== '' ? smtp.username : requireString(imap, 'username'),
          password: typeof smtp.password === 'string' && smtp.password !== '' ? smtp.password : requireString(imap, 'password'),
        },
      };
      const provider = await ImapProvider.connect(config);
      const accountId = sessionStore.newAccountId();
      const info = provider.toAccountInfo(accountId);
      session.accounts.set(accountId, { info, provider });
      res.status(201).json({ account: info });
    })
  );

  router.delete(
    '/accounts/:accountId',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const { accountId } = req.params;
      const account = getAccount(session, accountId);
      if (account.info.primary) {
        throw new ApiError(400, 'The primary account cannot be removed; sign out instead');
      }
      session.accounts.delete(accountId);
      for (const [alarmId, alarm] of session.alarms) {
        if (alarm.accountId === accountId) session.alarms.delete(alarmId);
      }
      await account.provider.close();
      res.json({ ok: true });
    })
  );

  // ---- Mailboxes ------------------------------------------------------------

  router.get(
    '/accounts/:accountId/mailboxes',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      res.json({ mailboxes: await account.provider.listMailboxes() });
    })
  );

  // ---- Messages -------------------------------------------------------------

  router.get(
    '/accounts/:accountId/mailboxes/:mailboxId/messages',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const query = typeof req.query.q === 'string' && req.query.q.trim() !== '' ? req.query.q.trim() : undefined;
      const page = await account.provider.listMessages(req.params.mailboxId, { limit, offset, query });
      res.json(page);
    })
  );

  router.get(
    '/accounts/:accountId/mailboxes/:mailboxId/messages/:messageId',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const message = await account.provider.getMessage(req.params.mailboxId, req.params.messageId);
      res.json({ message });
    })
  );

  router.post(
    '/accounts/:accountId/mailboxes/:mailboxId/messages/flags',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const ids = parseIdList(req.body?.ids);
      const flags: { seen?: boolean; flagged?: boolean } = {};
      if (typeof req.body?.seen === 'boolean') flags.seen = req.body.seen;
      if (typeof req.body?.flagged === 'boolean') flags.flagged = req.body.flagged;
      if (flags.seen === undefined && flags.flagged === undefined) {
        throw new ApiError(400, 'Provide at least one of: seen, flagged');
      }
      await account.provider.setFlags(req.params.mailboxId, ids, flags);
      res.json({ ok: true });
    })
  );

  router.post(
    '/accounts/:accountId/mailboxes/:mailboxId/messages/move',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const ids = parseIdList(req.body?.ids);
      const target = requireString(req.body ?? {}, 'targetMailboxId');
      await account.provider.move(req.params.mailboxId, ids, target);
      res.json({ ok: true });
    })
  );

  router.post(
    '/accounts/:accountId/mailboxes/:mailboxId/messages/delete',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const ids = parseIdList(req.body?.ids);
      await account.provider.delete(req.params.mailboxId, ids);
      res.json({ ok: true });
    })
  );

  router.get(
    '/accounts/:accountId/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const att = await account.provider.getAttachment(
        req.params.mailboxId,
        req.params.messageId,
        req.params.attachmentId
      );
      const name = typeof req.query.name === 'string' && req.query.name !== '' ? req.query.name : att.name;
      res.setHeader('Content-Type', att.type);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.send(att.content);
    })
  );

  // ---- Alarms ---------------------------------------------------------------

  router.get(
    '/alarms',
    wrap((req, res) => {
      const session = requireSession(req);
      const alarms = [...session.alarms.values()].sort(
        (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)
      );
      res.json({ alarms });
    })
  );

  router.post(
    '/alarms',
    wrap((req, res) => {
      const session = requireSession(req);
      const body = req.body ?? {};
      const accountId = requireString(body, 'accountId');
      getAccount(session, accountId);
      const messageId = requireString(body, 'messageId');
      const alarm: Alarm = {
        id: sessionStore.newAlarmId(),
        accountId,
        mailboxId: requireString(body, 'mailboxId'),
        messageId,
        dueAt: parseDueAt(body.dueAt),
        note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined,
        subject: typeof body.subject === 'string' ? body.subject : '',
        from: parseAddressList(body.from),
        createdAt: new Date().toISOString(),
      };
      // One alarm per message: setting a new one replaces the old.
      for (const [id, existing] of session.alarms) {
        if (existing.accountId === accountId && existing.messageId === messageId) {
          session.alarms.delete(id);
        }
      }
      session.alarms.set(alarm.id, alarm);
      res.status(201).json({ alarm });
    })
  );

  router.patch(
    '/alarms/:alarmId',
    wrap((req, res) => {
      const session = requireSession(req);
      const alarm = session.alarms.get(req.params.alarmId);
      if (!alarm) throw new ApiError(404, 'Alarm not found');
      const body = req.body ?? {};
      if (body.dueAt !== undefined) alarm.dueAt = parseDueAt(body.dueAt);
      if (body.note !== undefined) {
        alarm.note =
          typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined;
      }
      res.json({ alarm });
    })
  );

  router.delete(
    '/alarms/:alarmId',
    wrap((req, res) => {
      const session = requireSession(req);
      if (!session.alarms.delete(req.params.alarmId)) {
        throw new ApiError(404, 'Alarm not found');
      }
      res.json({ ok: true });
    })
  );

  // ---- Sending --------------------------------------------------------------

  router.post(
    '/accounts/:accountId/send',
    wrap(async (req, res) => {
      const session = requireSession(req);
      const account = getAccount(session, req.params.accountId);
      const body = req.body ?? {};
      const to = parseAddressList(body.to);
      if (to.length === 0) {
        throw new ApiError(400, 'At least one valid "to" recipient is required');
      }
      const message: OutgoingMessage = {
        to,
        cc: parseAddressList(body.cc),
        bcc: parseAddressList(body.bcc),
        subject: typeof body.subject === 'string' ? body.subject : '',
        text: typeof body.text === 'string' ? body.text : '',
        html: typeof body.html === 'string' && body.html.trim() !== '' ? body.html : undefined,
        inReplyTo:
          typeof body.inReplyTo === 'string' && body.inReplyTo.trim() !== '' ? body.inReplyTo.trim() : undefined,
      };
      await account.provider.send(message);
      res.json({ ok: true });
    })
  );

  return router;
}
