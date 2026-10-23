import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { formatTimestamp, parseTimestamp, youtubeUrlAt } from "../src/lib/time.js";
import { extractVideoId } from "../src/lib/videoid.js";
import { detectCountdown, collectRankMentions, parseNumberWord } from "../src/lib/countdown.js";
import {
  parseStoryboardSpec,
  pickLevel,
  storyboardFrames,
  frameAt,
  frameCrop,
  frameTileUrl,
} from "../src/lib/storyboard.js";

const storyboardFixture = JSON.parse(
  readFileSync(new URL("./fixtures-storyboard.json", import.meta.url), "utf8"),
);

describe("time", () => {
  it("formats and parses timestamps", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(90)).toBe("1:30");
    expect(formatTimestamp(3661)).toBe("1:01:01");
    expect(parseTimestamp("1:30")).toBe(90);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("nonsense")).toBeNull();
  });

  it("builds deep links", () => {
    expect(youtubeUrlAt("dQw4w9WgXcQ", 90)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s");
  });
});

describe("video id extraction", () => {
  it("accepts every common shape", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=5")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rejects junk", () => {
    expect(extractVideoId("")).toBeNull();
    expect(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractVideoId("too-short")).toBeNull();
  });
});

describe("countdown detection", () => {
  it("detects a descending ranked list", () => {
    const text = "Number 10 is the Honda. Number 9 is the Ford. Number 8 is the Kia. Number 7 is the Mazda. " +
      "Number 6 is the Audi. Number 5 is the BMW. Number 4 is the Volvo. Number 3 is the Lexus. " +
      "Number 2 is the Toyota. Number 1 is the Porsche.";
    const result = detectCountdown({ title: "Top 10 Cars of 2024", text });
    expect(result.verdict).toBe("countdown");
    expect(result.maxRank).toBe(10);
    expect(result.signals).toContain("title");
  });

  it("detects a countdown from structure alone", () => {
    const result = detectCountdown({
      title: "My favourite sodas",
      text: "at number five Coke, at number four Pepsi, at number three Sprite, at number two Fanta, at number one Dr Pepper",
    });
    expect(result.verdict).toBe("countdown");
    expect(result.maxRank).toBe(5);
    expect(result.signals).not.toContain("title");
  });

  it("does not fire on numbered how-to steps", () => {
    const result = detectCountdown({
      title: "How to bake bread",
      text: "Step 1 mix the flour. Step 2 let it rise. Step 3 bake for thirty minutes.",
    });
    expect(result.verdict).toBe("none");
  });

  it("does not fire on a dated timeline", () => {
    const result = detectCountdown({
      title: "The history of the internet",
      text: "In 1991 the web went public. In 1998 Google launched. In 2007 the iPhone arrived.",
    });
    expect(result.verdict).toBe("none");
  });

  it("reports 'possible' when the title promises a list the transcript does not support", () => {
    const result = detectCountdown({ title: "Top 10 Worst Movies", text: "Number 10 was bad and number 1 was worse." });
    expect(result.verdict).toBe("possible");
    expect(result.signals).toContain("title");
  });

  it("parses number words", () => {
    expect(parseNumberWord("ten")).toBe(10);
    expect(parseNumberWord("7")).toBe(7);
    expect(parseNumberWord("twenty one")).toBe(21);
    expect(parseNumberWord("banana")).toBeNull();
  });

  it("collects mentions in transcript order", () => {
    const mentions = collectRankMentions("number three then #1 then number 2");
    expect(mentions.map((m) => m.rank)).toEqual([3, 1, 2]);
  });
});

describe("storyboard parsing (real spec fixture)", () => {
  const levels = parseStoryboardSpec(storyboardFixture.spec);

  it("parses every level in ascending resolution order", () => {
    expect(levels.map((l) => l.width)).toEqual([48, 80, 160, 320]);
    expect(levels[3]).toMatchObject({ frameCount: 108, columns: 3, rows: 3 });
  });

  it("substitutes $L and $N so no placeholder survives", () => {
    for (const level of levels) {
      expect(level.url).not.toContain("$L");
      expect(level.url).not.toContain("$N");
      expect(level.url).toContain("&sigh=");
    }
    expect(levels[3].url).toContain("storyboard3_L3");
  });

  it("rejects malformed specs instead of throwing", () => {
    expect(parseStoryboardSpec("")).toEqual([]);
    expect(parseStoryboardSpec("not-a-spec")).toEqual([]);
    expect(parseStoryboardSpec("https://i.ytimg.com/x.jpg?$L|garbage")).toEqual([]);
  });

  it("picks a legible level and covers the whole video", () => {
    const level = pickLevel(levels, { minWidth: 160 });
    expect(level.width).toBe(160);

    const frames = storyboardFrames(level, storyboardFixture.duration);
    expect(frames).toHaveLength(108);
    expect(frames[0].time).toBe(0);
    expect(frames[107].time).toBeLessThanOrEqual(storyboardFixture.duration);
    // Frames must be a couple of seconds apart for a still to land near a timestamp.
    expect(frames[1].time - frames[0].time).toBeLessThan(3);
  });

  it("maps a timestamp to the nearest frame and its crop", () => {
    const level = pickLevel(levels, { minWidth: 320 });
    const frame = frameAt(level, storyboardFixture.duration, 60);
    expect(Math.abs(frame.time - 60)).toBeLessThan(2);

    const crop = frameCrop(level, frame);
    expect(crop).toMatchObject({ width: 320, height: 180 });
    // The crop must sit inside the sprite sheet for this frame's grid position.
    expect(crop.x).toBe(frame.column * 320);
    expect(crop.y).toBe(frame.row * 180);
    expect(crop.x + crop.width).toBeLessThanOrEqual(320 * level.columns);
  });

  it("builds a fetchable absolute tile url", () => {
    const level = pickLevel(levels, { minWidth: 320 });
    const url = frameTileUrl(level, frameAt(level, storyboardFixture.duration, 60));
    expect(url.startsWith("https://i.ytimg.com/sb/")).toBe(true);
    expect(url).not.toContain("$M");
  });
});
