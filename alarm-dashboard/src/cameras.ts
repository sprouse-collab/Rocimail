// Camera ingest via ffmpeg. One ffmpeg process per camera turns the source
// (USB/V4L2 device, RTSP or MJPEG URL, or a synthetic demo source) into a
// stream of JPEG frames on stdout, fanned out to any number of dashboard
// clients as multipart MJPEG. When motion detection is enabled the same
// process runs a second, low-fps scene-change branch whose scores are parsed
// from stderr — so a USB device is never opened twice.

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Response } from 'express';

type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;
import type { CameraConfig, CameraStatus } from './types.js';

const ONLINE_TIMEOUT_MS = 12_000;
const MOTION_COOLDOWN_MS = 15_000;
/** Scene-change score (0..1) above which a frame counts as motion. */
const MOTION_THRESHOLD = Number(process.env.ALARM_DASH_MOTION_THRESHOLD) || 0.05;
const MAX_RESTART_DELAY_MS = 30_000;

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export function ffmpegAvailable(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

interface StreamClient {
  res: Response;
  ready: boolean;
}

export class CameraStream {
  readonly config: CameraConfig;
  private proc: FfmpegProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private lastFrame: Buffer | null = null;
  private lastFrameAt = 0;
  private lastError: string | null = null;
  private lastStderrLine = '';
  private clients = new Set<StreamClient>();
  private stopped = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastMotionAt = 0;
  private wasOnline = false;

  constructor(
    config: CameraConfig,
    private hooks: {
      onMotion: (camera: CameraConfig, score: number) => void;
      onOnline: (camera: CameraConfig) => void;
      onOffline: (camera: CameraConfig, error: string | null) => void;
    }
  ) {
    this.config = config;
    this.start();
  }

  private inputArgs(): string[] {
    switch (this.config.type) {
      case 'usb':
        return ['-f', 'v4l2', '-i', this.config.source];
      case 'rtsp':
        return ['-rtsp_transport', 'tcp', '-i', this.config.source];
      case 'mjpeg':
        return ['-i', this.config.source];
      case 'demo':
        return ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10'];
    }
  }

  private start(): void {
    if (this.stopped) return;
    const live = "fps=12,scale='min(1280,iw)':-2";
    const outputArgs = ['-an', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6'];
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...this.inputArgs()];
    if (this.config.motion) {
      args.push(
        '-filter_complex',
        `[0:v]split=2[live][mot];[live]${live}[liveout];` +
          `[mot]fps=4,scale=320:-2,select='gt(scene,${MOTION_THRESHOLD})',metadata=print[motout]`,
        '-map', '[liveout]', ...outputArgs, 'pipe:1',
        '-map', '[motout]', '-f', 'null', '-'
      );
    } else {
      args.push('-vf', live, ...outputArgs, 'pipe:1');
    }

    let proc: FfmpegProcess;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastError = (err as Error).message;
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    this.buffer = Buffer.alloc(0);

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk.toString()));
    proc.on('error', (err) => {
      this.lastError = err.message;
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.stopped) {
        this.lastError = this.lastStderrLine || `ffmpeg exited with code ${code}`;
        this.markOffline();
        this.scheduleRestart();
      }
    });
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = Math.min(1000 * 2 ** this.restartAttempts, MAX_RESTART_DELAY_MS);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Extract complete JPEGs (SOI … EOI) from the accumulator.
    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start === -1) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const end = this.buffer.indexOf(EOI, start + 2);
      if (end === -1) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return;
      }
      const frame = this.buffer.subarray(start, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      this.onFrame(Buffer.from(frame));
    }
  }

  private onFrame(frame: Buffer): void {
    this.lastFrame = frame;
    this.lastFrameAt = Date.now();
    this.lastError = null;
    this.restartAttempts = 0;
    if (!this.wasOnline) {
      this.wasOnline = true;
      this.hooks.onOnline(this.config);
    }
    const header = Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    for (const client of this.clients) {
      if (!client.ready) continue; // drop frames for slow clients instead of buffering
      const ok = client.res.write(Buffer.concat([header, frame, Buffer.from('\r\n')]));
      if (!ok) {
        client.ready = false;
        client.res.once('drain', () => {
          client.ready = true;
        });
      }
    }
  }

  private onStderr(text: string): void {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      this.lastStderrLine = line;
      const match = line.match(/lavfi\.scene_score=([0-9.]+)/);
      if (match) {
        const now = Date.now();
        if (now - this.lastMotionAt >= MOTION_COOLDOWN_MS) {
          this.lastMotionAt = now;
          this.hooks.onMotion(this.config, Number(match[1]));
        }
      }
    }
  }

  private markOffline(): void {
    if (this.wasOnline) {
      this.wasOnline = false;
      this.hooks.onOffline(this.config, this.lastError);
    }
  }

  get online(): boolean {
    return this.proc !== null && Date.now() - this.lastFrameAt < ONLINE_TIMEOUT_MS;
  }

  status(): CameraStatus {
    return {
      ...this.config,
      online: this.online,
      lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      lastError: this.online ? null : this.lastError,
      clients: this.clients.size,
    };
  }

  snapshot(): Buffer | null {
    return this.lastFrame;
  }

  addClient(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache',
      Connection: 'close',
    });
    const client: StreamClient = { res, ready: true };
    this.clients.add(client);
    if (this.lastFrame) {
      res.write(
        Buffer.concat([
          Buffer.from(
            `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.lastFrame.length}\r\n\r\n`
          ),
          this.lastFrame,
          Buffer.from('\r\n'),
        ])
      );
    }
    res.on('close', () => this.clients.delete(client));
  }

  restart(): void {
    this.restartAttempts = 0;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.kill('SIGKILL');
      this.start();
    } else {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.start();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const client of this.clients) client.res.end();
    this.clients.clear();
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }
}
