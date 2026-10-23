import { PROVIDER_PRESETS, chatCompletion } from "../lib/llm.js";
import { getSettings, saveSettings, applyPreset, originPatternFor } from "../lib/settings.js";

const form = document.getElementById("form");
const fields = {
  provider: document.getElementById("provider"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  apiKey: document.getElementById("apiKey"),
  language: document.getElementById("language"),
  includeFrames: document.getElementById("includeFrames"),
  maxFrames: document.getElementById("maxFrames"),
};
const message = document.getElementById("message");
const keyLink = document.getElementById("keyLink");

for (const [value, preset] of Object.entries(PROVIDER_PRESETS)) {
  fields.provider.append(new Option(preset.label, value));
}

let current = null;

function say(text, kind = "") {
  message.textContent = text;
  message.className = kind;
}

function syncKeyLink() {
  const preset = PROVIDER_PRESETS[fields.provider.value];
  if (preset?.keyUrl) {
    keyLink.href = preset.keyUrl;
    keyLink.hidden = false;
  } else {
    keyLink.hidden = true;
  }
}

function fill(settings) {
  fields.provider.value = settings.provider;
  fields.baseUrl.value = settings.baseUrl ?? "";
  fields.model.value = settings.model ?? "";
  fields.apiKey.value = settings.apiKey ?? "";
  fields.language.value = settings.language ?? "";
  fields.includeFrames.checked = Boolean(settings.includeFrames);
  fields.maxFrames.value = String(settings.maxFrames ?? 8);
  syncKeyLink();
}

function read() {
  return {
    provider: fields.provider.value,
    baseUrl: fields.baseUrl.value.trim(),
    model: fields.model.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    language: fields.language.value.trim(),
    includeFrames: fields.includeFrames.checked,
    maxFrames: Math.max(0, Math.min(20, Number(fields.maxFrames.value) || 0)),
  };
}

/** A non-public endpoint needs the optional host permission before it can be called. */
async function ensureHostAccess(baseUrl) {
  const pattern = originPatternFor(baseUrl);
  if (!pattern) return true;
  if (pattern.startsWith("https://api.openai.com") || pattern.startsWith("https://openrouter.ai") || pattern.startsWith("https://api.groq.com") || pattern.startsWith("https://generativelanguage.googleapis.com")) {
    return true;
  }
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

fields.provider.addEventListener("change", () => {
  current = applyPreset(current ?? read(), fields.provider.value);
  fill(current);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = read();
  await saveSettings(next);
  current = next;
  say("Saved.", "ok");
});

document.getElementById("test").addEventListener("click", async () => {
  const settings = read();
  const button = document.getElementById("test");
  button.disabled = true;
  say("Testing…");
  try {
    const granted = await ensureHostAccess(settings.baseUrl);
    if (!granted) throw new Error("Access to that host was not granted.");
    const { model } = await chatCompletion({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 16,
    });
    say(`Connected. ${model} replied.`, "ok");
  } catch (error) {
    say(error?.message ?? "The test failed.", "err");
  } finally {
    button.disabled = false;
  }
});

current = await getSettings();
fill(current);
