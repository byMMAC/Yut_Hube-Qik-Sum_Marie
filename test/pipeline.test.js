import { describe, expect, it, vi } from "vitest";

import { extractPlayerResponse, parseVideoPage, pickTrack } from "../src/lib/extract.js";
import { buildTranscriptUrl, parseJson3, toTimestampedLines, fetchTranscript, parsePanelTranscript } from "../src/lib/transcript.js";
import { extractJson, normalizeSummary } from "../src/lib/summarize.js";
import { chatCompletion, describeHttpError, chatCompletionsUrl } from "../src/lib/llm.js";

/** A page shaped like a real watch page: the JSON is followed by more markup. */
const FAKE_PAGE = `<html><body><script>var ytInitialPlayerResponse = ${JSON.stringify({
  videoDetails: { videoId: "dQw4w9WgXcQ", title: "Top 3 Sodas", author: "Someone", lengthSeconds: "213", viewCount: "42" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=de", languageCode: "de", name: { simpleText: "Deutsch" } },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr", languageCode: "en", kind: "asr", name: { simpleText: "English (auto)" } },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=x&lang=en", languageCode: "en", name: { simpleText: "English" } },
      ],
    },
  },
  storyboards: { playerStoryboardSpecRenderer: { spec: "https://i.ytimg.com/sb/x/storyboard3_L$L/$N.jpg?$M|48#27#100#10#10#0#default#sig" } },
  playabilityStatus: { status: "OK" },
})};</script><div>trailing markup { not json }</div></body></html>`;

describe("player response extraction", () => {
  it("finds the object even when later markup contains braces", () => {
    const parsed = extractPlayerResponse(FAKE_PAGE);
    expect(parsed?.videoDetails?.videoId).toBe("dQw4w9WgXcQ");
  });

  it("returns null instead of throwing on a page without player data", () => {
    expect(extractPlayerResponse("<html>nothing here</html>")).toBeNull();
    expect(extractPlayerResponse(undefined)).toBeNull();
  });

  it("summarizes the page into meta, tracks and storyboard", () => {
    const page = parseVideoPage(FAKE_PAGE);
    expect(page.ok).toBe(true);
    expect(page.meta).toMatchObject({ videoId: "dQw4w9WgXcQ", title: "Top 3 Sodas", duration: 213 });
    expect(page.tracks).toHaveLength(3);
    expect(page.storyboardSpec).toContain("storyboard3_L$L");
  });

  it("reports a page with no player response as a clean failure", () => {
    expect(parseVideoPage("<html></html>").ok).toBe(false);
  });
});

describe("caption track selection", () => {
  it("prefers a human track in the wanted language over auto captions", () => {
    const page = parseVideoPage(FAKE_PAGE);
    expect(pickTrack(page.tracks, { preferredLanguage: "en" }).isAuto).toBe(false);
    expect(pickTrack(page.tracks, { preferredLanguage: "en" }).lang).toBe("en");
  });

  it("falls back to the first track when nothing matches", () => {
    expect(pickTrack([{ url: "u", lang: "de", isAuto: false }], { preferredLanguage: "fr" }).lang).toBe("de");
    expect(pickTrack([], { preferredLanguage: "en" })).toBeNull();
  });
});

describe("transcript parsing", () => {
  it("switches the format without dropping the signed parameters", () => {
    const url = buildTranscriptUrl("https://www.youtube.com/api/timedtext?v=x&lang=en&expire=1&sig=abc");
    expect(url).toContain("fmt=json3");
    expect(url).toContain("sig=abc");
  });

  it("parses json3 events into segments and plain text", () => {
    const parsed = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "Number three " }, { utf8: "is Sprite." }] },
        { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "Number two is Fanta." }] },
        { tStartMs: 2500, segs: [] },
      ],
    });
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]).toMatchObject({ start: 0, duration: 1.5, text: "Number three is Sprite." });
    expect(parsed.text).toBe("Number three is Sprite. Number two is Fanta.");
  });

  it("survives malformed payloads", () => {
    expect(parseJson3(null).segments).toEqual([]);
    expect(parseJson3({ events: "nope" }).text).toBe("");
  });

  it("groups segments into timestamped lines", () => {
    const segments = Array.from({ length: 20 }, (_, i) => ({ start: i * 2, duration: 2, text: `Sentence number ${i}.` }));
    const lines = toTimestampedLines(segments, { maxChars: 60 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].start).toBe(0);
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(80);
  });
});

describe("model output handling", () => {
  it("recovers JSON from code fences and surrounding prose", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("no json at all")).toBeNull();
  });

  it("normalizes a valid summary", () => {
    const summary = normalizeSummary({
      tldr: "A short recap.",
      keyPoints: ["One", "Two"],
      outline: [{ time: "0:30", label: "Intro" }, { time: "", label: "Dropped" }],
    });
    expect(summary.keyPoints).toEqual(["One", "Two"]);
    expect(summary.outline).toEqual([{ time: "0:30", label: "Intro" }]);
  });

  it("sorts ranked items from highest rank to number one", () => {
    const summary = normalizeSummary(
      { tldr: "x", items: [{ rank: 1, title: "First" }, { rank: 3, title: "Third" }, { rank: 2, title: "Second" }] },
      { countdown: true },
    );
    expect(summary.items.map((i) => i.rank)).toEqual([3, 2, 1]);
  });

  it("drops items without a usable rank or title", () => {
    const summary = normalizeSummary(
      { tldr: "x", items: [{ rank: 1, title: "Good" }, { rank: "nope", title: "Bad" }, { rank: 2, title: "" }] },
      { countdown: true },
    );
    expect(summary.items).toHaveLength(1);
  });

  it("ignores items when the video is not a countdown", () => {
    const summary = normalizeSummary({ tldr: "x", items: [{ rank: 1, title: "Nope" }] }, { countdown: false });
    expect(summary.items).toBeUndefined();
  });

  it("rejects an empty summary so the caller can retry", () => {
    expect(normalizeSummary({ tldr: "", keyPoints: [], outline: [] })).toBeNull();
    expect(normalizeSummary(null)).toBeNull();
  });
});

describe("provider client", () => {
  it("appends the completions path once", () => {
    expect(chatCompletionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatCompletionsUrl("http://localhost:11434/v1/chat/completions")).toBe("http://localhost:11434/v1/chat/completions");
    expect(() => chatCompletionsUrl("")).toThrow();
  });

  it("explains common failures", () => {
    expect(describeHttpError(401, "")).toMatch(/rejected the API key/);
    expect(describeHttpError(429, "")).toMatch(/Rate limited/);
    expect(describeHttpError(404, "")).toMatch(/no such model/);
  });

  it("sends the key and returns the text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }], model: "test-model" }),
    });
    const result = await chatCompletion({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    });
    expect(result.content).toBe("hello");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer secret");
  });

  it("turns an unreachable host into a helpful message", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      chatCompletion({ baseUrl: "https://nope.test/v1", apiKey: "k", model: "m", messages: [], fetchImpl }),
    ).rejects.toThrow(/Could not reach the provider/);
  });

  it("surfaces a refusal instead of returning empty text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "  " } }] }) });
    await expect(
      chatCompletion({ baseUrl: "https://x.test/v1", apiKey: "k", model: "m", messages: [], fetchImpl }),
    ).rejects.toThrow(/returned no text/);
  });
});

describe("transcript availability", () => {
  it("treats an empty 200 body as a token problem, not a success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    await expect(fetchTranscript("https://www.youtube.com/api/timedtext?v=x", { fetchImpl })).rejects.toMatchObject({
      name: "TranscriptUnavailableError",
      reason: "po-token",
    });
  });

  it("distinguishes a malformed body from an empty one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => "<html>nope</html>" });
    await expect(fetchTranscript("https://x.test", { fetchImpl })).rejects.toMatchObject({ reason: "malformed" });
  });

  it("parses the transcript YouTube renders in its own panel", () => {
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<div id="root">
      <ytd-transcript-segment-renderer>
        <div class="segment-timestamp">0:05</div><div class="segment-text">Number three is Sprite.</div>
      </ytd-transcript-segment-renderer>
      <ytd-transcript-segment-renderer>
        <div class="segment-timestamp">0:12</div><div class="segment-text">Number two is Fanta.</div>
      </ytd-transcript-segment-renderer>
    </div>`);
    const parsed = parsePanelTranscript(dom.window.document.getElementById("root"));
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]).toMatchObject({ start: 5, text: "Number three is Sprite." });
    expect(parsed.text).toBe("Number three is Sprite. Number two is Fanta.");
  });

  it("returns an empty result when the panel is not open", () => {
    expect(parsePanelTranscript(null).segments).toEqual([]);
  });
});
