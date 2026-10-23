/**
 * MV3 service workers are evicted when idle, so this file only wires events.
 * All long-lived state lives in the side panel, which shares the extension origin.
 */
import { DEFAULT_SETTINGS } from "./lib/settings.js";

async function enableSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* Older builds ignore this; the action click handler below still works. */
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  enableSidePanel();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(enableSidePanel);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    /* The panel may already be open, or the tab may not allow it. */
  }
});

/** The panel asks for the active tab; only the worker can see it. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "get-active-video") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = tab?.url ?? "";
      const videoId = url.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ?? null;
      sendResponse({ tabId: tab?.id ?? null, url, videoId, onYouTube: /youtube\.com\/watch/.test(url) });
    })();
    return true; // keep the message channel open for the async reply
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});
