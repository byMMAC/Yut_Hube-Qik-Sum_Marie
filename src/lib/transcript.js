import { parseTimestamp } from "./time.js";

/**
 * YouTube increasingly answers caption requests with an empty 200 body unless a
 * proof-of-origin token accompanies them, so a successful status alone is not
 * proof of success. Callers can fall back to reading the on-page transcript.
 */
export class TranscriptUnavailableError extends Error {
  constructor(message, { reason = "unavailable" } = {}) {
    super(message);
    this.name = "TranscriptUnavailableError";
    this.reason = reason;
  }
}

/** Caption URLs are signed; only the format parameter may be changed. */
export function buildTranscriptUrl(baseUrl, { fmt = "json3" } = {}) {
  const url = new URL(baseUrl, "https://www.youtube.com");
  url.searchParams.set("fmt", fmt);
  return url.toString();
}

/** Parse YouTube's json3 caption payload into timed segments plus plain text. */
export function parseJson3(payload) {
  const events = payload?.events;
  if (!Array.isArray(events)) return { segments: [], text: "" };

  const segments = [];
  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const text = event.segs
      .map((seg) => seg?.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    segments.push({
      start: (Number(event.tStartMs) || 0) / 1000,
      duration: (Number(event.dDurationMs) || 0) / 1000,
      text,
    });
  }
  return { segments, text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim() };
}

export async function fetchTranscript(baseUrl, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(buildTranscriptUrl(baseUrl), { signal, credentials: "omit" });
  if (!res.ok) {
    throw new TranscriptUnavailableError(`The caption request failed with status ${res.status}.`, { reason: "http" });
  }

  const body = await res.text();
  if (!body.trim()) {
    throw new TranscriptUnavailableError(
      "YouTube returned an empty caption response. It now requires a proof-of-origin token for direct caption downloads.",
      { reason: "po-token" },
    );
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new TranscriptUnavailableError("The caption response was not in the expected format.", { reason: "malformed" });
  }

  const parsed = parseJson3(payload);
  if (!parsed.segments.length) {
    throw new TranscriptUnavailableError("The caption track contained no text.", { reason: "empty" });
  }
  return parsed;
}

/**
 * Fallback path: read the transcript YouTube has already rendered in its own
 * panel. It runs with the user's real session, so it is unaffected by the
 * token requirement that blocks direct downloads.
 */
export function parsePanelTranscript(root) {
  const nodes = root?.querySelectorAll?.("ytd-transcript-segment-renderer");
  if (!nodes?.length) return { segments: [], text: "" };

  const segments = [];
  for (const node of nodes) {
    const text = node.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) continue;
    const stamp = node.querySelector(".segment-timestamp")?.textContent?.trim() ?? "";
    segments.push({ start: parseTimestamp(stamp) ?? 0, duration: 0, text });
  }
  return { segments, text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim() };
}

/**
 * Group segments into readable chunks with the timestamp they start at, so the
 * model can cite times without inventing them.
 */
export function toTimestampedLines(segments, { maxChars = 320 } = {}) {
  if (!Array.isArray(segments) || !segments.length) return [];
  const lines = [];
  let current = null;

  for (const segment of segments) {
    if (current && current.text.length + segment.text.length + 1 > maxChars) {
      lines.push(current);
      current = null;
    }
    if (!current) current = { start: segment.start, text: segment.text };
    else current.text = `${current.text} ${segment.text}`;
  }
  if (current) lines.push(current);
  return lines;
}
