// Event log: in-memory ring buffer + append-only JSONL file + SSE fan-out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { AlarmEvent, EventLevel } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = process.env.ALARM_DASH_EVENT_LOG || path.resolve(__dirname, '../events.jsonl');
const MAX_EVENTS = 500;

export class EventBus {
  private events: AlarmEvent[] = [];
  private subscribers = new Set<Response>();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
      for (const line of lines.slice(-MAX_EVENTS)) {
        try {
          const parsed = JSON.parse(line) as AlarmEvent;
          if (parsed && typeof parsed.id === 'string') this.events.push(parsed);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* no log yet */
    }
  }

  emit(input: {
    level: EventLevel;
    type: string;
    message: string;
    cameraId?: string;
    source?: string;
  }): AlarmEvent {
    const event: AlarmEvent = {
      id: randomBytes(6).toString('hex'),
      time: new Date().toISOString(),
      ...input,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    try {
      fs.appendFileSync(LOG_PATH, JSON.stringify(event) + '\n');
    } catch {
      /* history survives in memory only */
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.subscribers) res.write(payload);
    return event;
  }

  recent(limit: number): AlarmEvent[] {
    return this.events.slice(-limit).reverse();
  }

  subscribe(res: Response): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.subscribers.add(res);
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
    return () => {
      clearInterval(keepalive);
      this.subscribers.delete(res);
    };
  }
}
