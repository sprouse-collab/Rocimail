// Rocimail Alarm Dashboard — a LAN web interface that shows live camera
// feeds next to a real-time alarm/event feed. Cameras are ingested with
// ffmpeg (USB/V4L2 webcams, RTSP or MJPEG network cameras, or a built-in
// demo source) and served to the browser as multipart MJPEG.

import express, { type NextFunction, type Request, type Response } from 'express';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, newId } from './config.js';
import { CameraStream, ffmpegAvailable } from './cameras.js';
import { EventBus } from './events.js';
import type { CameraConfig, CameraType, EventLevel } from './types.js';

const PORT = Number(process.env.ALARM_DASH_PORT) || 4100;
const HOST = process.env.ALARM_DASH_HOST || '0.0.0.0';
const AUTH_USER = process.env.ALARM_DASH_USER || '';
const AUTH_PASSWORD = process.env.ALARM_DASH_PASSWORD || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const events = new EventBus();
const streams = new Map<string, CameraStream>();
const hasFfmpeg = ffmpegAvailable();

function levelForMotion(): EventLevel {
  return config.armed ? 'alarm' : 'warning';
}

const cameraHooks = {
  onMotion(camera: CameraConfig, score: number) {
    events.emit({
      level: levelForMotion(),
      type: 'motion',
      message: `Motion detected on ${camera.name} (score ${score.toFixed(2)})`,
      cameraId: camera.id,
    });
  },
  onOnline(camera: CameraConfig) {
    events.emit({
      level: 'info',
      type: 'system',
      message: `Camera ${camera.name} is online`,
      cameraId: camera.id,
    });
  },
  onOffline(camera: CameraConfig, error: string | null) {
    events.emit({
      level: 'warning',
      type: 'system',
      message: `Camera ${camera.name} went offline${error ? ` (${error})` : ''}`,
      cameraId: camera.id,
    });
  },
};

if (hasFfmpeg) {
  for (const camera of config.cameras) {
    streams.set(camera.id, new CameraStream(camera, cameraHooks));
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Optional HTTP Basic auth for the whole dashboard (set ALARM_DASH_USER/PASSWORD).
if (AUTH_PASSWORD !== '') {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      if ((AUTH_USER === '' || user === AUTH_USER) && rest.join(':') === AUTH_PASSWORD) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Alarm Dashboard"');
    res.status(401).send('Authentication required');
  });
}

app.use(express.static(path.resolve(__dirname, '../public')));

// ---- State ------------------------------------------------------------------

app.get('/api/state', (_req, res) => {
  res.json({
    armed: config.armed,
    ffmpegAvailable: hasFfmpeg,
    cameras: config.cameras.map((c) => streams.get(c.id)?.status() ?? {
      ...c,
      online: false,
      lastFrameAt: null,
      lastError: hasFfmpeg ? 'not started' : 'ffmpeg is not installed on the server',
      clients: 0,
    }),
    events: events.recent(100),
  });
});

app.post('/api/arm', (req, res) => {
  const armed = req.body?.armed === true;
  if (config.armed !== armed) {
    config.armed = armed;
    saveConfig(config);
    events.emit({
      level: 'info',
      type: 'arm',
      message: armed ? 'System armed' : 'System disarmed',
    });
  }
  res.json({ armed: config.armed });
});

// ---- Events -----------------------------------------------------------------

app.get('/api/events', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ events: events.recent(limit) });
});

app.get('/api/events/stream', (req, res) => {
  const unsubscribe = events.subscribe(res);
  req.on('close', unsubscribe);
});

// Webhook for external alarm sources (sensors, home automation, scripts):
// POST /api/events {"message": "...", "level": "info|warning|alarm", "source": "..."}
app.post('/api/events', (req, res) => {
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message === '') {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  const level: EventLevel = ['info', 'warning', 'alarm'].includes(body.level)
    ? body.level
    : 'warning';
  const event = events.emit({
    level,
    type: 'external',
    message: message.slice(0, 500),
    source: typeof body.source === 'string' ? body.source.slice(0, 100) : undefined,
  });
  res.status(201).json({ event });
});

app.post('/api/alarm/test', (_req, res) => {
  const event = events.emit({
    level: 'alarm',
    type: 'manual',
    message: 'Test alarm triggered from the dashboard',
  });
  res.status(201).json({ event });
});

// ---- Cameras ----------------------------------------------------------------

const CAMERA_TYPES: CameraType[] = ['usb', 'rtsp', 'mjpeg', 'demo'];

app.post('/api/cameras', (req, res) => {
  const body = req.body ?? {};
  const type = body.type as CameraType;
  if (!CAMERA_TYPES.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${CAMERA_TYPES.join(', ')}` });
    return;
  }
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  if (type !== 'demo' && source === '') {
    res.status(400).json({ error: 'source is required (device path or stream URL)' });
    return;
  }
  const camera: CameraConfig = {
    id: newId(),
    name:
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim().slice(0, 60)
        : `Camera ${config.cameras.length + 1}`,
    type,
    source,
    motion: body.motion === true,
  };
  config.cameras.push(camera);
  saveConfig(config);
  if (hasFfmpeg) streams.set(camera.id, new CameraStream(camera, cameraHooks));
  events.emit({
    level: 'info',
    type: 'system',
    message: `Camera ${camera.name} added`,
    cameraId: camera.id,
  });
  res.status(201).json({ camera });
});

app.delete('/api/cameras/:id', (req, res) => {
  const index = config.cameras.findIndex((c) => c.id === req.params.id);
  if (index === -1) {
    res.status(404).json({ error: 'Camera not found' });
    return;
  }
  const [camera] = config.cameras.splice(index, 1);
  saveConfig(config);
  streams.get(camera.id)?.stop();
  streams.delete(camera.id);
  events.emit({ level: 'info', type: 'system', message: `Camera ${camera.name} removed` });
  res.json({ ok: true });
});

app.post('/api/cameras/:id/restart', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) {
    res.status(404).json({ error: 'Camera not found (or ffmpeg is unavailable)' });
    return;
  }
  stream.restart();
  res.json({ ok: true });
});

app.get('/api/cameras/:id/stream', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) {
    res.status(404).json({ error: 'Camera not found (or ffmpeg is unavailable)' });
    return;
  }
  stream.addClient(res);
});

app.get('/api/cameras/:id/snapshot', (req, res) => {
  const frame = streams.get(req.params.id)?.snapshot();
  if (!frame) {
    res.status(404).json({ error: 'No frame available yet' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(frame);
});

// ---- Startup ----------------------------------------------------------------

// Make sure ffmpeg children never outlive the server.
function shutdown(): void {
  for (const stream of streams.values()) stream.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, HOST, () => {
  console.log(`Alarm dashboard listening on http://${HOST}:${PORT}`);
  if (!hasFfmpeg) {
    console.warn('WARNING: ffmpeg was not found on PATH — camera streaming is disabled.');
  }
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN: http://${net.address}:${PORT}`);
      }
    }
  }
});
