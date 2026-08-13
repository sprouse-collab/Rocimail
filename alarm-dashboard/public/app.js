// Rocimail Alarm Dashboard client. Plain JS, no build step:
// - renders camera tiles as multipart-MJPEG <img> streams
// - live event feed over SSE
// - alarm state: flashing banner + WebAudio siren + desktop notification

'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  armed: false,
  cameras: [],
  events: [],
  filter: 'all',
  alarmActive: false,
};

// ---- Siren ------------------------------------------------------------------

let sirenCtx = null;
let sirenNodes = null;

function startSiren() {
  if (sirenNodes) return;
  try {
    sirenCtx = sirenCtx || new AudioContext();
    void sirenCtx.resume();
    const osc = sirenCtx.createOscillator();
    const lfo = sirenCtx.createOscillator();
    const lfoGain = sirenCtx.createGain();
    const gain = sirenCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 800;
    lfo.type = 'sine';
    lfo.frequency.value = 0.8;
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain).connect(osc.frequency);
    gain.gain.value = 0.06;
    osc.connect(gain).connect(sirenCtx.destination);
    osc.start();
    lfo.start();
    sirenNodes = { osc, lfo, gain };
  } catch {
    /* no audio available */
  }
}

function stopSiren() {
  if (!sirenNodes) return;
  try {
    sirenNodes.osc.stop();
    sirenNodes.lfo.stop();
  } catch {
    /* already stopped */
  }
  sirenNodes = null;
}

// ---- Alarm state ------------------------------------------------------------

function activateAlarm(event) {
  state.alarmActive = true;
  $('alarm-banner-text').textContent = `⚠ ALARM — ${event.message}`;
  $('alarm-banner').classList.remove('hidden');
  startSiren();
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('⚠ Alarm', { body: event.message });
    } catch {
      /* notification construction can fail on some platforms */
    }
  }
  renderCameras(); // highlight the camera that alarmed
}

function silenceAlarm() {
  state.alarmActive = false;
  $('alarm-banner').classList.add('hidden');
  stopSiren();
  renderCameras();
}

// ---- API --------------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* non-JSON body */
    }
    throw new Error(message);
  }
  return res.json();
}

async function refreshState() {
  try {
    const data = await api('/api/state');
    state.armed = data.armed;
    state.cameras = data.cameras;
    if (state.events.length === 0) state.events = data.events;
    $('ffmpeg-warning').classList.toggle('hidden', data.ffmpegAvailable);
    renderArm();
    renderCameras();
    renderEvents();
  } catch (err) {
    console.error('state refresh failed', err);
  }
}

// ---- Rendering --------------------------------------------------------------

function renderArm() {
  const btn = $('arm-btn');
  btn.textContent = state.armed ? '● ARMED — click to disarm' : '○ Disarmed — click to arm';
  btn.classList.toggle('armed', state.armed);
}

const lastAlarmCamera = { id: null };
let cameraRenderSignature = '';

function renderCameras() {
  // Rebuilding <img> tiles reconnects their MJPEG streams, so only re-render
  // when something visible actually changed.
  const signature = JSON.stringify(
    state.cameras.map((c) => [
      c.id,
      c.name,
      c.online,
      c.motion,
      c.lastError,
      state.alarmActive && lastAlarmCamera.id === c.id,
    ])
  );
  if (signature === cameraRenderSignature) return;
  cameraRenderSignature = signature;

  const grid = $('camera-grid');
  grid.textContent = '';
  if (state.cameras.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'camera-empty';
    empty.textContent = 'No cameras yet. Use “+ Add camera” to connect a USB webcam or a network camera stream.';
    grid.appendChild(empty);
    return;
  }
  for (const cam of state.cameras) {
    const card = document.createElement('div');
    card.className = 'camera-card';
    if (state.alarmActive && lastAlarmCamera.id === cam.id) card.classList.add('alerting');

    const header = document.createElement('div');
    header.className = 'camera-card-header';
    const name = document.createElement('span');
    name.className = 'camera-name';
    name.textContent = cam.name;
    const badge = document.createElement('span');
    badge.className = `camera-badge ${cam.online ? 'online' : 'offline'}`;
    badge.textContent = cam.online ? 'Live' : 'Offline';
    header.append(name, badge);
    if (cam.motion) {
      const chip = document.createElement('span');
      chip.className = 'camera-chip';
      chip.textContent = 'motion';
      header.append(chip);
    }
    const actions = document.createElement('div');
    actions.className = 'camera-actions';
    const restart = document.createElement('button');
    restart.title = 'Restart stream';
    restart.textContent = '⟳';
    restart.onclick = () => api(`/api/cameras/${cam.id}/restart`, { method: 'POST' }).then(refreshState);
    const remove = document.createElement('button');
    remove.title = 'Remove camera';
    remove.textContent = '✕';
    remove.onclick = () => {
      if (confirm(`Remove camera “${cam.name}”?`)) {
        api(`/api/cameras/${cam.id}`, { method: 'DELETE' }).then(refreshState);
      }
    };
    actions.append(restart, remove);
    header.append(actions);

    const video = document.createElement('div');
    video.className = 'camera-video';
    if (cam.online || cam.lastFrameAt) {
      const img = document.createElement('img');
      img.alt = cam.name;
      img.src = `/api/cameras/${cam.id}/stream?t=${Date.now()}`;
      video.appendChild(img);
    }
    if (!cam.online) {
      const note = document.createElement('div');
      note.className = 'camera-offline-note';
      note.textContent = cam.lastError ? `Offline — ${cam.lastError}` : 'Connecting…';
      video.appendChild(note);
    }

    card.append(header, video);
    grid.appendChild(card);
  }
}

function renderEvents() {
  const list = $('event-list');
  list.textContent = '';
  const filtered = state.events.filter((e) => state.filter === 'all' || e.level === state.filter);
  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'event-empty';
    empty.textContent = 'No events yet.';
    list.appendChild(empty);
    return;
  }
  for (const event of filtered.slice(0, 200)) {
    const item = document.createElement('li');
    item.className = `event-item ${event.level}`;
    const dot = document.createElement('span');
    dot.className = 'event-dot';
    const body = document.createElement('div');
    const message = document.createElement('div');
    message.className = 'event-message';
    message.textContent = event.message;
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const time = new Date(event.time).toLocaleString();
    meta.textContent = event.source ? `${time} · ${event.source}` : time;
    body.append(message, meta);
    item.append(dot, body);
    list.appendChild(item);
  }
}

// ---- Live events (SSE) ------------------------------------------------------

function connectEvents() {
  const source = new EventSource('/api/events/stream');
  source.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      state.events.unshift(event);
      state.events = state.events.slice(0, 300);
      if (event.level === 'alarm') {
        lastAlarmCamera.id = event.cameraId || null;
        activateAlarm(event);
      }
      if (event.type === 'arm' || event.type === 'system') void refreshState();
      renderEvents();
    } catch {
      /* ignore malformed */
    }
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 3000);
  };
}

// ---- Add-camera modal -------------------------------------------------------

const HINTS = {
  usb: 'Path of a UVC/V4L2 webcam on the server, e.g. /dev/video0. Note: Telus/Alarm.com Wi-Fi cameras (like the ADC-V516) have no USB video output and cannot be connected this way.',
  rtsp: 'RTSP URL, e.g. rtsp://user:pass@192.168.1.50:554/stream1',
  mjpeg: 'HTTP MJPEG URL, e.g. http://192.168.1.51:8080/video',
  demo: 'A synthetic moving test pattern generated by ffmpeg — no hardware needed.',
};

function openCameraModal() {
  $('cam-error').classList.add('hidden');
  $('camera-modal').classList.remove('hidden');
  updateCameraHint();
}

function closeCameraModal() {
  $('camera-modal').classList.add('hidden');
}

function updateCameraHint() {
  const type = $('cam-type').value;
  $('cam-hint').textContent = HINTS[type];
  $('cam-source-label').classList.toggle('hidden', type === 'demo');
  $('cam-source').placeholder =
    type === 'usb' ? '/dev/video0' : type === 'rtsp' ? 'rtsp://…' : 'http://…';
}

// ---- Wiring -----------------------------------------------------------------

$('arm-btn').onclick = async () => {
  try {
    const data = await api('/api/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed: !state.armed }),
    });
    state.armed = data.armed;
    renderArm();
  } catch (err) {
    alert(err.message);
  }
};

$('test-btn').onclick = () => {
  api('/api/alarm/test', { method: 'POST' }).catch((err) => alert(err.message));
};

$('silence-btn').onclick = silenceAlarm;

$('notify-btn').onclick = () => {
  if ('Notification' in window) void Notification.requestPermission();
};

$('add-camera-btn').onclick = openCameraModal;
$('camera-modal-close').onclick = closeCameraModal;
$('camera-modal-cancel').onclick = closeCameraModal;
$('cam-type').onchange = updateCameraHint;
$('camera-modal').onclick = (e) => {
  if (e.target === $('camera-modal')) closeCameraModal();
};

$('camera-form').onsubmit = async (e) => {
  e.preventDefault();
  const error = $('cam-error');
  error.classList.add('hidden');
  try {
    await api('/api/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('cam-name').value,
        type: $('cam-type').value,
        source: $('cam-source').value,
        motion: $('cam-motion').checked,
      }),
    });
    closeCameraModal();
    $('cam-name').value = '';
    $('cam-source').value = '';
    await refreshState();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
};

for (const btn of document.querySelectorAll('.filter')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('.filter')) b.classList.remove('active');
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderEvents();
  };
}

void refreshState();
connectEvents();
setInterval(refreshState, 10_000);
