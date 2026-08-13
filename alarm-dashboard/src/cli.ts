#!/usr/bin/env node
// rocialarm — command-line client for the Rocimail alarm dashboard over LAN.
//
//   rocialarm status                        overview: armed state, cameras, latest events
//   rocialarm arm | disarm                  set the arm state
//   rocialarm watch                         live event tail (SSE); Ctrl-C to stop
//   rocialarm events [--limit N]            recent events
//   rocialarm test                          trigger a test alarm
//   rocialarm event <message> [--level info|warning|alarm] [--source NAME]
//   rocialarm cameras                       list cameras with status
//   rocialarm add-camera --type usb|rtsp|mjpeg|demo [--source X] [--name N] [--motion]
//   rocialarm remove-camera <id>
//   rocialarm restart-camera <id>
//   rocialarm snapshot <id> [--out FILE]    save the latest JPEG frame
//
// Server address: --url, or ROCIALARM_URL (default http://localhost:4100).
// Basic auth:     --user/--password, or ROCIALARM_USER / ROCIALARM_PASSWORD.
// Machine output: --json on read commands.

import fs from 'node:fs';

interface Cli {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(['json', 'no-color', 'motion', 'help']);

function parseArgs(argv: string[]): Cli {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  const [command = 'help', ...rest] = positional;
  return { command, positional: rest, flags };
}

const cli = parseArgs(process.argv.slice(2));

const BASE = String(cli.flags.get('url') || process.env.ROCIALARM_URL || 'http://localhost:4100')
  .replace(/\/+$/, '');
const USER = String(cli.flags.get('user') || process.env.ROCIALARM_USER || '');
const PASSWORD = String(cli.flags.get('password') || process.env.ROCIALARM_PASSWORD || '');
const JSON_OUT = cli.flags.get('json') === true;

const useColor = process.stdout.isTTY && cli.flags.get('no-color') !== true;
const color = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = (t: string) => color('31;1', t);
const green = (t: string) => color('32', t);
const yellow = (t: string) => color('33', t);
const dim = (t: string) => color('2', t);
const bold = (t: string) => color('1', t);

function authHeaders(): Record<string, string> {
  if (PASSWORD === '') return {};
  return { Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}` };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers as Record<string, string> | undefined) },
      signal: options.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Cannot reach the alarm dashboard at ${BASE} — ${(err as Error).message}`);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

interface EventRow {
  time: string;
  level: 'info' | 'warning' | 'alarm';
  type: string;
  message: string;
  source?: string;
}

interface CameraRow {
  id: string;
  name: string;
  type: string;
  source: string;
  motion: boolean;
  online: boolean;
  lastError: string | null;
}

interface State {
  armed: boolean;
  ffmpegAvailable: boolean;
  cameras: CameraRow[];
  events: EventRow[];
}

function formatEvent(e: EventRow): string {
  const time = dim(new Date(e.time).toLocaleString());
  const label =
    e.level === 'alarm' ? red('ALARM ') : e.level === 'warning' ? yellow('warn  ') : dim('info  ');
  const source = e.source ? dim(` [${e.source}]`) : '';
  return `${time}  ${label} ${e.message}${source}`;
}

function formatCamera(c: CameraRow): string {
  const status = c.online ? green('● live   ') : yellow('○ offline');
  const motion = c.motion ? dim(' motion') : '';
  const error = !c.online && c.lastError ? dim(` — ${c.lastError}`) : '';
  const source = c.type === 'demo' ? 'demo' : `${c.type} ${c.source}`;
  return `${status} ${bold(c.name)} ${dim(`(${c.id})`)}  ${dim(source)}${motion}${error}`;
}

async function cmdStatus(): Promise<void> {
  const state = await api<State>('/api/state');
  if (JSON_OUT) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`${bold('Alarm dashboard')} ${dim(BASE)}`);
  console.log(`State: ${state.armed ? red('ARMED') : green('disarmed')}`);
  if (!state.ffmpegAvailable) {
    console.log(yellow('ffmpeg is not installed on the server — camera streaming is disabled'));
  }
  console.log(`\n${bold('Cameras')} (${state.cameras.length})`);
  for (const cam of state.cameras) console.log(`  ${formatCamera(cam)}`);
  if (state.cameras.length === 0) console.log(dim('  none'));
  console.log(`\n${bold('Latest events')}`);
  for (const event of state.events.slice(0, 10)) console.log(`  ${formatEvent(event)}`);
  if (state.events.length === 0) console.log(dim('  none'));
}

async function cmdArm(armed: boolean): Promise<void> {
  const result = await api<{ armed: boolean }>('/api/arm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ armed }),
  });
  console.log(result.armed ? red('System ARMED') : green('System disarmed'));
}

async function cmdEvents(): Promise<void> {
  const limit = Number(cli.flags.get('limit')) || 50;
  const { events } = await api<{ events: EventRow[] }>(`/api/events?limit=${limit}`);
  if (JSON_OUT) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  for (const event of [...events].reverse()) console.log(formatEvent(event));
  if (events.length === 0) console.log(dim('no events'));
}

async function cmdWatch(): Promise<void> {
  console.log(dim(`watching ${BASE} — Ctrl-C to stop`));
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/events/stream`, { headers: authHeaders() });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let buffer = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString();
        for (;;) {
          const sep = buffer.indexOf('\n\n');
          if (sep === -1) break;
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data === '') continue;
          try {
            const event = JSON.parse(data) as EventRow;
            console.log(formatEvent(event));
            if (event.level === 'alarm') process.stdout.write('\x07'); // terminal bell
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch (err) {
      console.error(dim(`stream lost (${(err as Error).message}) — reconnecting in 3s`));
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function cmdTest(): Promise<void> {
  const { event } = await api<{ event: EventRow }>('/api/alarm/test', { method: 'POST' });
  console.log(formatEvent(event));
}

async function cmdEvent(): Promise<void> {
  const message = cli.positional.join(' ').trim();
  if (message === '') throw new Error('usage: rocialarm event <message> [--level alarm] [--source name]');
  const { event } = await api<{ event: EventRow }>('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      level: cli.flags.get('level') || 'warning',
      source: cli.flags.get('source') || 'rocialarm-cli',
    }),
  });
  console.log(formatEvent(event));
}

async function cmdCameras(): Promise<void> {
  const state = await api<State>('/api/state');
  if (JSON_OUT) {
    console.log(JSON.stringify(state.cameras, null, 2));
    return;
  }
  for (const cam of state.cameras) console.log(formatCamera(cam));
  if (state.cameras.length === 0) console.log(dim('no cameras'));
}

async function cmdAddCamera(): Promise<void> {
  const type = String(cli.flags.get('type') || '');
  if (!['usb', 'rtsp', 'mjpeg', 'demo'].includes(type)) {
    throw new Error('usage: rocialarm add-camera --type usb|rtsp|mjpeg|demo [--source X] [--name N] [--motion]');
  }
  const { camera } = await api<{ camera: CameraRow }>('/api/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      source: cli.flags.get('source') || '',
      name: cli.flags.get('name') || '',
      motion: cli.flags.get('motion') === true,
    }),
  });
  console.log(`added camera ${bold(camera.name)} ${dim(`(${camera.id})`)}`);
}

function requireCameraId(usage: string): string {
  const id = cli.positional[0];
  if (!id) throw new Error(`usage: rocialarm ${usage}`);
  return id;
}

async function cmdRemoveCamera(): Promise<void> {
  const id = requireCameraId('remove-camera <id>');
  await api(`/api/cameras/${encodeURIComponent(id)}`, { method: 'DELETE' });
  console.log(`removed camera ${id}`);
}

async function cmdRestartCamera(): Promise<void> {
  const id = requireCameraId('restart-camera <id>');
  await api(`/api/cameras/${encodeURIComponent(id)}/restart`, { method: 'POST' });
  console.log(`restarted camera ${id}`);
}

async function cmdSnapshot(): Promise<void> {
  const id = requireCameraId('snapshot <id> [--out file.jpg]');
  const out = String(cli.flags.get('out') || `${id}-${Date.now()}.jpg`);
  const res = await fetch(`${BASE}/api/cameras/${encodeURIComponent(id)}/snapshot`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON */
    }
    throw new Error(message);
  }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${out}`);
}

function help(): void {
  console.log(`rocialarm — CLI for the Rocimail alarm dashboard (over LAN)

usage: rocialarm <command> [options]

commands:
  status                       armed state, cameras, latest events
  arm | disarm                 set the arm state
  watch                        live event tail (rings the terminal bell on alarms)
  events [--limit N]           recent events
  test                         trigger a test alarm
  event <message>              raise an event  [--level info|warning|alarm] [--source NAME]
  cameras                      list cameras
  add-camera --type T          add a camera    [--source X] [--name N] [--motion]
  remove-camera <id>           remove a camera
  restart-camera <id>          restart a camera stream
  snapshot <id> [--out FILE]   save the latest JPEG frame

options:
  --url URL         dashboard address (or ROCIALARM_URL; default http://localhost:4100)
  --user / --password   HTTP Basic auth (or ROCIALARM_USER / ROCIALARM_PASSWORD)
  --json            JSON output for status/events/cameras
  --no-color        plain output`);
}

const commands: Record<string, () => Promise<void> | void> = {
  status: cmdStatus,
  arm: () => cmdArm(true),
  disarm: () => cmdArm(false),
  watch: cmdWatch,
  events: cmdEvents,
  test: cmdTest,
  event: cmdEvent,
  cameras: cmdCameras,
  'add-camera': cmdAddCamera,
  'remove-camera': cmdRemoveCamera,
  'restart-camera': cmdRestartCamera,
  snapshot: cmdSnapshot,
  help,
};

const run = commands[cli.command];
if (!run) {
  console.error(`unknown command: ${cli.command}\n`);
  help();
  process.exit(2);
}

Promise.resolve(run()).catch((err: Error) => {
  console.error(red(`error: ${err.message}`));
  process.exit(1);
});
