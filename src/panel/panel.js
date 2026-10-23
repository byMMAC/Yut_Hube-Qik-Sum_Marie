import { getSettings } from "../lib/settings.js";
import { parseVideoPage, pickTrack } from "../lib/extract.js";
import { fetchTranscript, TranscriptUnavailableError } from "../lib/transcript.js";
import { detectCountdown } from "../lib/countdown.js";
import { parseStoryboardSpec, pickLevel } from "../lib/storyboard.js";
import { summarizeTranscript } from "../lib/summarize.js";
import { captureMany, clearTileCache } from "../lib/frames.js";
import { formatTimestamp, parseTimestamp, youtubeUrlAt } from "../lib/time.js";

const VIEW = document.getElementById("view");
const STATUS = document.getElementById("status");

let runController = null;
let currentVideoId = null;

/** Text always goes in through textContent: provider and page data are untrusted. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setStatus(text) {
  STATUS.textContent = text ?? "";
}

function section(title, children) {
  return el("section", {}, [el("h2", { text: title }), ...[].concat(children)]);
}

function timestampButton(videoId, seconds) {
  return el("button", {
    class: "time",
    type: "button",
    text: formatTimestamp(seconds),
    title: `Play from ${formatTimestamp(seconds)}`,
    onclick: () => chrome.tabs.create({ url: youtubeUrlAt(videoId, seconds) }),
  });
}

/**
 * Ask the content script to expand and read YouTube's transcript panel. This
 * uses the page's own session, which sidesteps the caption token requirement.
 */
async function readTranscriptFromPage(duration) {
  const { tabId } = await activeVideo();
  if (!tabId) return null;
  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "read-panel-transcript" }, (reply) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(reply);
    });
  });
  if (!response?.ok || !response.segments.length) return null;

  const segments = response.segments.map((segment, index) => ({
    start: parseTimestamp(segment.time) ?? 0,
    duration: 0,
    text: segment.text,
  }));
  // The panel gives start times only, so infer each gap from the next entry.
  for (let i = 0; i < segments.length; i += 1) {
    const next = segments[i + 1];
    segments[i].duration = next ? Math.max(0, next.start - segments[i].start) : Math.max(0, duration - segments[i].start);
  }
  return { segments, text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim() };
}

async function activeVideo() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-active-video" }, (response) => {
      if (chrome.runtime.lastError) resolve({ onYouTube: false });
      else resolve(response ?? { onYouTube: false });
    });
  });
}

function renderIdle(message, { action } = {}) {
  clear(VIEW);
  VIEW.append(
    el("p", { class: "hint", text: message }),
    action ? el("button", { class: "primary", type: "button", text: action.label, onclick: action.onClick }) : null,
  );
}

function renderError(message, { retry = true } = {}) {
  clear(VIEW);
  VIEW.append(
    el("p", { class: "error", text: message }),
    retry ? el("button", { class: "primary", type: "button", text: "Try again", onclick: () => run() }) : null,
  );
}

function renderLoading(label) {
  clear(VIEW);
  VIEW.append(el("p", { class: "hint" }, [el("span", { class: "spinner" }), label]));
}

function renderHeader(meta, videoId, countdown) {
  const nodes = [el("p", { class: "video-title", text: meta.title || "Untitled video" })];
  if (meta.author) nodes.push(el("p", { class: "hint", text: meta.author }));
  nodes.push(
    el("img", {
      class: "thumb",
      src: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      alt: "",
      loading: "lazy",
    }),
  );
  if (countdown.verdict !== "none") {
    const label =
      countdown.verdict === "countdown"
        ? `Ranked countdown detected${countdown.maxRank ? ` (top ${countdown.maxRank})` : ""}`
        : "Possibly a ranked list — the transcript did not make it clear";
    nodes.push(el("p", { class: "hint", text: label }));
  }
  return el("section", {}, nodes);
}

function renderSummary(summary, meta, videoId, frames, countdown) {
  const blocks = [renderHeader(meta, videoId, countdown)];

  if (summary.tldr) blocks.push(section("TL;DR", el("p", { text: summary.tldr })));

  if (summary.keyPoints?.length) {
    blocks.push(section("Key points", el("ul", {}, summary.keyPoints.map((point) => el("li", { text: point })))));
  }

  if (summary.items?.length) {
    blocks.push(
      section(
        "Ranked list",
        summary.items.map((item) => {
          const seconds = parseTimestamp(item.time);
          const capture = frames.get(item.time);
          const body = [
            el("div", { class: "rank-title", text: item.title }),
            item.description ? el("div", { class: "rank-desc", text: item.description }) : null,
            seconds !== null ? timestampButton(videoId, seconds) : null,
            capture ? el("img", { src: capture.dataUrl, alt: "", loading: "lazy" }) : null,
          ];
          return el("div", { class: "rank" }, [
            el("div", { class: "rank-badge", text: String(item.rank) }),
            el("div", { class: "rank-body" }, body),
          ]);
        }),
      ),
    );
  }

  if (summary.outline?.length) {
    blocks.push(
      section(
        "Timestamped outline",
        el(
          "ol",
          { class: "outline" },
          summary.outline.map((entry) => {
            const seconds = parseTimestamp(entry.time);
            const capture = frames.get(entry.time);
            const left = seconds !== null ? timestampButton(videoId, seconds) : el("span", { class: "time", text: entry.time });
            const right = [el("div", { text: entry.label })];
            if (capture) right.push(el("img", { src: capture.dataUrl, alt: "", loading: "lazy" }));
            return el("li", {}, [left, el("div", { class: "rank-body" }, right)]);
          }),
        ),
      ),
    );
  }

  blocks.push(
    el("button", {
      type: "button",
      text: "Copy as text",
      onclick: () => copySummary(summary, meta),
    }),
  );
  return blocks;
}

async function copySummary(summary, meta) {
  const lines = [meta.title, ""];
  if (summary.tldr) lines.push("TL;DR", summary.tldr, "");
  if (summary.keyPoints?.length) lines.push("Key points", ...summary.keyPoints.map((p) => `- ${p}`), "");
  if (summary.items?.length) {
    lines.push("Ranked list");
    for (const item of summary.items) lines.push(`#${item.rank} ${item.title} (${item.time})`, item.description ?? "", "");
  }
  if (summary.outline?.length) {
    lines.push("Outline", ...summary.outline.map((e) => `${e.time} ${e.label}`), "");
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n").trim());
    setStatus("Copied to the clipboard.");
  } catch {
    setStatus("Could not copy to the clipboard.");
  }
}

async function run() {
  runController?.abort();
  const controller = new AbortController();
  runController = controller;

  const settings = await getSettings();
  const { videoId, onYouTube } = await activeVideo();
  currentVideoId = videoId;

  if (!onYouTube || !videoId) {
    setStatus("");
    renderIdle("Open a YouTube watch page, then press Refresh.", {
      action: { label: "Refresh", onClick: () => run() },
    });
    return;
  }

  if (!settings.apiKey && !settings.baseUrl?.includes("localhost") && !settings.baseUrl?.includes("127.0.0.1")) {
    renderIdle("Add your provider API key to summarize videos.", {
      action: { label: "Open settings", onClick: () => chrome.runtime.openOptionsPage() },
    });
    return;
  }

  try {
    renderLoading("Reading the video…");
    setStatus("Fetching the watch page");

    const pageRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en&bpctr=9999999999&has_verified=1`,
      { signal: controller.signal, credentials: "omit" },
    );
    if (!pageRes.ok) throw new Error(`YouTube returned HTTP ${pageRes.status} for this video.`);
    const parsed = parseVideoPage(await pageRes.text());
    if (!parsed.ok) throw new Error("Could not read the player data. The video may be private, age-restricted, or region-locked.");

    const track = pickTrack(parsed.tracks, { preferredLanguage: settings.language });
    if (!track) throw new Error("This video has no captions, so there is no transcript to summarize.");

    setStatus(`Downloading the transcript (${track.lang}${track.isAuto ? ", auto-generated" : ""})`);
    let transcript;
    try {
      transcript = await fetchTranscript(track.url, { signal: controller.signal });
      transcript.language = track.lang;
    } catch (error) {
      if (!(error instanceof TranscriptUnavailableError)) throw error;
      setStatus("Direct captions were refused, reading the transcript from the page…");
      transcript = await readTranscriptFromPage(parsed.meta.duration);
      if (!transcript) throw error;
      transcript.language = track.lang;
    }

    const countdown = detectCountdown({ title: parsed.meta.title, text: transcript.text });
    setStatus(`Summarizing ${transcript.segments.length} caption segments with ${settings.model}`);

    const { summary } = await summarizeTranscript({
      transcript,
      meta: parsed.meta,
      countdown: countdown.verdict === "countdown",
      settings,
      signal: controller.signal,
      onProgress: ({ detail }) => setStatus(detail),
    });

    let frames = new Map();
    if (settings.includeFrames && parsed.storyboardSpec) {
      setStatus("Capturing frames");
      const level = pickLevel(parseStoryboardSpec(parsed.storyboardSpec), { minWidth: 320 });
      if (level) {
        const entries = [
          ...(summary.items ?? []).map((item) => ({ key: item.time, seconds: parseTimestamp(item.time) })),
          ...(summary.outline ?? []).map((entry) => ({ key: entry.time, seconds: parseTimestamp(entry.time) })),
        ].filter((entry) => entry.seconds !== null);
        frames = await captureMany(level, parsed.meta.duration, entries, {
          max: settings.maxFrames,
          signal: controller.signal,
        });
      }
    }

    if (controller.signal.aborted) return;
    clear(VIEW);
    VIEW.append(...renderSummary(summary, parsed.meta, videoId, frames, countdown));
    setStatus(`Done — ${summary.items?.length ?? 0} ranked items, ${frames.size} frames.`);
  } catch (error) {
    if (error?.name === "AbortError") return;
    renderError(error?.message ?? "Something went wrong.");
    setStatus("");
  }
}

document.getElementById("refresh").addEventListener("click", () => run());
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Re-run when the user switches to a different video.
chrome.tabs?.onActivated?.addListener(() => run());
chrome.tabs?.onUpdated?.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.active) run();
});

window.addEventListener("unload", () => {
  runController?.abort();
  clearTileCache();
});

run();
