// Data model for the LAN alarm dashboard.

export type CameraType = 'usb' | 'rtsp' | 'mjpeg' | 'demo';

export interface CameraConfig {
  id: string;
  name: string;
  type: CameraType;
  /**
   * usb   → V4L2 device path, e.g. /dev/video0
   * rtsp  → rtsp:// URL
   * mjpeg → http(s):// URL of an MJPEG stream
   * demo  → ignored (synthetic ffmpeg test source)
   */
  source: string;
  /** Enable ffmpeg scene-change motion detection for this camera. */
  motion: boolean;
}

export type EventLevel = 'info' | 'warning' | 'alarm';

export interface AlarmEvent {
  id: string;
  time: string; // ISO 8601
  level: EventLevel;
  type: string; // motion | manual | external | system | arm
  message: string;
  cameraId?: string;
  source?: string;
}

export interface DashboardConfig {
  cameras: CameraConfig[];
  armed: boolean;
}

export interface CameraStatus extends CameraConfig {
  online: boolean;
  lastFrameAt: string | null;
  lastError: string | null;
  clients: number;
}
