// Config persistence: alarm-dashboard/config.json (created on first change).
// The file is git-ignored; config.example.json documents the shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { CameraConfig, CameraType, DashboardConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ALARM_DASH_CONFIG || path.resolve(__dirname, '../config.json');

const CAMERA_TYPES: CameraType[] = ['usb', 'rtsp', 'mjpeg', 'demo'];

function defaultConfig(): DashboardConfig {
  return {
    armed: false,
    cameras: [
      { id: 'demo', name: 'Demo camera', type: 'demo', source: '', motion: true },
    ],
  };
}

function sanitizeCamera(raw: unknown): CameraConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id === '') return null;
  if (!CAMERA_TYPES.includes(c.type as CameraType)) return null;
  return {
    id: c.id,
    name: typeof c.name === 'string' && c.name.trim() !== '' ? c.name.trim() : c.id,
    type: c.type as CameraType,
    source: typeof c.source === 'string' ? c.source.trim() : '',
    motion: c.motion === true,
  };
}

export function loadConfig(): DashboardConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    const cameras = Array.isArray(raw.cameras)
      ? raw.cameras.map(sanitizeCamera).filter((c): c is CameraConfig => c !== null)
      : [];
    return { armed: raw.armed === true, cameras };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: DashboardConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function newId(): string {
  return randomBytes(6).toString('hex');
}
