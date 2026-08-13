// Alarm notification helpers: a short synthesized chime (no audio asset needed)
// and desktop notifications via the browser Notification API.

export function playChime(): void {
  try {
    const ctx = new AudioContext();
    const play = (freq: number, start: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.5);
    };
    play(880, 0);
    play(1174.66, 0.18);
    window.setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* audio unavailable (autoplay policy, no device) — the visual alarm still shows */
  }
}

export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

export function showBrowserNotification(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: `rocimail-${title}-${body}` });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some platforms throw when constructing Notification directly */
  }
}
