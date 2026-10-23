// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureAt, captureMany, clearTileCache } from "../src/lib/frames.js";
import { parseStoryboardSpec, pickLevel } from "../src/lib/storyboard.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures-storyboard.json"), "utf8"));
const level = pickLevel(parseStoryboardSpec(fixture.spec), { minWidth: 320 });

/** Stand in for the browser image APIs the real extension uses. */
function stubBrowserApis() {
  globalThis.createImageBitmap = vi.fn(async () => ({ width: 960, height: 540, close() {} }));
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.drawn = null;
    }
    getContext() {
      return { drawImage: (...args) => { this.drawn = args; }, imageSmoothingQuality: "" };
    }
    async convertToBlob({ type }) {
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type });
    }
  };
}

beforeEach(() => {
  clearTileCache();
  stubBrowserApis();
});

afterEach(() => {
  clearTileCache();
  delete globalThis.createImageBitmap;
  delete globalThis.OffscreenCanvas;
});

describe("frame capture", () => {
  it("crops a frame to a JPEG data URL", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["tile"]) }));
    const capture = await captureAt(level, fixture.duration, 60, { fetchImpl });

    expect(capture).not.toBeNull();
    expect(capture.dataUrl.startsWith("data:image/jpeg")).toBe(true);
    expect(capture.width).toBe(640); // 320 source pixels at scale 2
    expect(capture.height).toBe(360);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reuses one tile fetch for frames on the same sprite sheet", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["tile"]) }));
    // Two nearby timestamps land in the same tile.
    await captureAt(level, fixture.duration, 60, { fetchImpl });
    await captureAt(level, fixture.duration, 61, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null instead of throwing when a tile fails", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }));
    await expect(captureAt(level, fixture.duration, 60, { fetchImpl })).resolves.toBeNull();
  });

  it("returns null when the video has no storyboard", async () => {
    await expect(captureAt(null, 100, 10)).resolves.toBeNull();
  });

  it("keys captures by timestamp and respects the cap", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["tile"]) }));
    const entries = [
      { key: "0:10", seconds: 10 },
      { key: "0:40", seconds: 40 },
      { key: "1:20", seconds: 80 },
    ];
    const frames = await captureMany(level, fixture.duration, entries, { max: 2, fetchImpl });
    expect(frames.size).toBe(2);
    expect(frames.has("0:10")).toBe(true);
    expect(frames.has("0:40")).toBe(true);
    expect(frames.has("1:20")).toBe(false);
  });

  it("ignores entries without a usable timestamp", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["tile"]) }));
    const frames = await captureMany(level, fixture.duration, [{ key: "bad", seconds: null }], { fetchImpl });
    expect(frames.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
