/**
 * Adds a button to the watch page. YouTube is a single-page app, so the button
 * is re-attached on navigation instead of only on load.
 */
const BUTTON_ID = "ytsum-open-panel";

function openPanel() {
  chrome.runtime.sendMessage({ type: "open-panel" }, () => void chrome.runtime.lastError);
}

function mountButton() {
  if (document.getElementById(BUTTON_ID)) return;
  const anchor =
    document.querySelector("#actions-inner #top-level-buttons-computed") ??
    document.querySelector("#actions-inner") ??
    document.querySelector("#above-the-fold #title");
  if (!anchor) return;

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = "Summarize";
  button.setAttribute("aria-label", "Summarize this video in the side panel");
  button.style.cssText = [
    "margin-left:8px",
    "padding:0 16px",
    "height:36px",
    "border-radius:18px",
    "border:1px solid var(--yt-spec-10-percent-layer, #303030)",
    "background:var(--yt-spec-badge-chip-background, #272727)",
    "color:var(--yt-spec-text-primary, #f1f1f1)",
    "font:500 14px/36px Roboto, Arial, sans-serif",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", openPanel);
  anchor.append(button);
}

function removeButton() {
  document.getElementById(BUTTON_ID)?.remove();
}

function sync() {
  if (/^\/watch/.test(location.pathname)) mountButton();
  else removeButton();
}

sync();
// YouTube swaps the URL without a reload, so watch the path.
let lastPath = location.pathname;
new MutationObserver(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    sync();
  } else if (!document.getElementById(BUTTON_ID) && /^\/watch/.test(location.pathname)) {
    mountButton();
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// The side panel may ask which video is on screen.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "content-video-id") {
    sendResponse({ videoId: new URLSearchParams(location.search).get("v") });
  }
  return false;
});

/**
 * YouTube's own transcript panel is a reliable fallback when a direct caption
 * download is refused. The panel has to be expanded first, and the segments
 * render asynchronously, so poll briefly for them.
 */
const TRANSCRIPT_BUTTONS = [
  "ytd-video-description-transcript-section-renderer button",
  "ytd-expandable-video-description-body-renderer button",
  "button[aria-label*=\"transcript\" i]",
];

function waitFor(predicate, { timeout = 6000, interval = 200 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function readPanelTranscript() {
  const existing = document.querySelectorAll("ytd-transcript-segment-renderer").length;
  if (!existing) {
    for (const selector of TRANSCRIPT_BUTTONS) {
      const button = document.querySelector(selector);
      if (button) {
        button.click();
        break;
      }
    }
  }
  return waitFor(() => {
    const nodes = document.querySelectorAll("ytd-transcript-segment-renderer");
    if (!nodes.length) return null;
    const segments = [];
    for (const node of nodes) {
      const text = node.querySelector(".segment-text")?.textContent?.replace(/\s+/g, " ").trim();
      if (!text) continue;
      segments.push({ time: node.querySelector(".segment-timestamp")?.textContent?.trim() ?? "0:00", text });
    }
    return segments.length ? segments : null;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "read-panel-transcript") {
    readPanelTranscript().then(
      (segments) => sendResponse({ ok: Boolean(segments), segments: segments ?? [] }),
      () => sendResponse({ ok: false, segments: [] }),
    );
    return true; // async reply
  }
  return false;
});
