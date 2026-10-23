import { frameAt, frameCrop, frameTileUrl } from "./storyboard.js";

/**
 * Sprite tiles are large and shared between neighbouring frames, so cache the
 * decoded bitmap and crop from it rather than refetching per timestamp.
 */
const tileCache = new Map();

export function clearTileCache() {
  for (const entry of tileCache.values()) Promise.resolve(entry).then((b) => b?.close?.()).catch(() => {});
  tileCache.clear();
}

async function loadTile(url, fetchImpl) {
  if (tileCache.has(url)) return tileCache.get(url);
  const promise = (async () => {
    const res = await fetchImpl(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`Frame tile request failed with status ${res.status}`);
    return createImageBitmap(await res.blob());
  })();
  tileCache.set(url, promise);
  try {
    return await promise;
  } catch (error) {
    tileCache.delete(url);
    throw error;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not encode the frame"));
    reader.readAsDataURL(blob);
  });
}

/** Crop one storyboard frame out of its sprite sheet, as a JPEG data URL. */
export async function cropFrame(level, frame, { scale = 2, quality = 0.85, fetchImpl = fetch } = {}) {
  const crop = frameCrop(level, frame);
  if (!crop) throw new Error("Frame is not part of a storyboard level");

  const bitmap = await loadTile(frameTileUrl(level, frame), fetchImpl);
  const width = Math.round(crop.width * scale);
  const height = Math.round(crop.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return { blob, dataUrl: await blobToDataUrl(blob), width, height, time: frame.time };
}

/** The still nearest a timestamp, or null when the video has no storyboard. */
export async function captureAt(level, duration, seconds, options = {}) {
  const frame = frameAt(level, duration, seconds);
  if (!frame) return null;
  try {
    return await cropFrame(level, frame, options);
  } catch {
    return null; // A missing still must not fail the whole summary.
  }
}

/** Attach a still to each outline entry or ranked item, capped to bound requests. */
export async function captureMany(level, duration, entries, { max = 8, ...options } = {}) {
  if (!level || !Array.isArray(entries) || !entries.length) return new Map();
  const results = new Map();
  const chosen = entries.slice(0, max);
  for (const entry of chosen) {
    const seconds =
      typeof entry.seconds === "number" && Number.isFinite(entry.seconds) ? entry.seconds : Number(entry.start);
    if (!Number.isFinite(seconds)) continue;
    const capture = await captureAt(level, duration, seconds, options);
    if (capture) results.set(entry.key ?? entry.time ?? entry.rank, capture);
  }
  return results;
}
