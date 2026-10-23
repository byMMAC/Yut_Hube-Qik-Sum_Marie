const pad = (n) => String(n).padStart(2, "0");

/** Render seconds as m:ss, or h:mm:ss past an hour. */
export function formatTimestamp(totalSeconds, { forceHours = false } = {}) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 || forceHours ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Parse "90", "1:30", or "1:02:03" into seconds. Returns null when malformed. */
export function parseTimestamp(text) {
  if (typeof text !== "string") return null;
  const parts = text.trim().split(":").map((p) => p.trim());
  if (!parts.length || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (parts.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
  if (parts.length === 2) return n[0] * 60 + n[1];
  return n[0];
}

/** Deep link that starts playback at a timestamp. */
export function youtubeUrlAt(videoId, seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${t}s`;
}
