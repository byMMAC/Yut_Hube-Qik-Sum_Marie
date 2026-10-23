/**
 * YouTube storyboards are sprite sheets: a grid of video frames in one image.
 * The player publishes a spec that names the tile grid and a signed base URL.
 * Field layout and placeholder substitution mirror yt-dlp's `_extract_storyboard`.
 */

const STORYBOARD_HOST = "https://i.ytimg.com/";

/** Spec is the signed base URL, then one pipe-separated field per level (least detailed first). */
export function parseStoryboardSpec(spec) {
  if (typeof spec !== "string" || !spec.includes("|")) return [];
  const fields = spec.split("|");
  const baseUrl = fields.shift();
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return [];

  const levels = [];
  for (let i = 0; i < fields.length; i += 1) {
    const args = fields[i].split("#");
    if (args.length !== 8) continue;
    const [width, height, frameCount, columns, rows] = args.slice(0, 5).map(Number);
    if (![width, height, frameCount, columns, rows].every((n) => Number.isFinite(n) && n > 0)) continue;
    // Layout: width#height#frameCount#columns#rows#levelId#name#sigh
    const name = args[6];
    const sigh = args[7];
    levels.push({
      index: i,
      // $L is the level number; $N the fragment name. Both come from the spec.
      url: `${baseUrl.replace("$L", String(i)).replace("$N", name)}&sigh=${sigh}`,
      width,
      height,
      frameCount,
      columns,
      rows,
      sigh,
      name,
    });
  }
  return levels;
}

/** Sprite-sheet URL for one tile of a level, with the $M fragment index filled in. */
export function storyboardTileUrl(level, tileIndex) {
  if (!level?.url) return null;
  return level.url.replace("$M", String(tileIndex));
}

/** Frames in a level, each with the timestamp it represents. */
export function storyboardFrames(level, durationSeconds) {
  if (!level || !(level.columns > 0) || !(level.rows > 0)) return [];
  const perTile = level.columns * level.rows;
  const tileCount = Math.ceil(level.frameCount / perTile);
  const step = durationSeconds > 0 ? durationSeconds / level.frameCount : 0;

  const frames = [];
  for (let tile = 0; tile < tileCount; tile += 1) {
    for (let slot = 0; slot < perTile; slot += 1) {
      const index = tile * perTile + slot;
      if (index >= level.frameCount) break;
      frames.push({
        index,
        tileIndex: tile,
        slot,
        column: slot % level.columns,
        row: Math.floor(slot / level.columns),
        time: index * step,
      });
    }
  }
  return frames;
}

/** Pixel crop for a frame inside its tile. */
export function frameCrop(level, frame) {
  if (!level || !frame) return null;
  return {
    x: frame.column * level.width,
    y: frame.row * level.height,
    width: level.width,
    height: level.height,
  };
}

/**
 * Pick the smallest level whose frames are at least `minWidth` wide, else the
 * largest available. Small levels exist for scrubbing; we want legible stills.
 */
export function pickLevel(levels, { minWidth = 160 } = {}) {
  if (!Array.isArray(levels) || !levels.length) return null;
  const sorted = [...levels].sort((a, b) => a.width - b.width);
  return sorted.find((l) => l.width >= minWidth) ?? sorted[sorted.length - 1];
}

/** Frame nearest a timestamp, for pinning a still to a line of the outline. */
export function frameAt(level, durationSeconds, seconds) {
  const frames = storyboardFrames(level, durationSeconds);
  if (!frames.length) return null;
  const target = Math.max(0, Number(seconds) || 0);
  let best = frames[0];
  for (const frame of frames) {
    if (Math.abs(frame.time - target) < Math.abs(best.time - target)) best = frame;
  }
  return best;
}

/** Build the absolute URL for a frame's sprite tile. */
export function frameTileUrl(level, frame) {
  if (!level || !frame) return null;
  const url = storyboardTileUrl(level, frame.tileIndex);
  return url && !/^https?:/i.test(url) ? new URL(url, STORYBOARD_HOST).toString() : url;
}
