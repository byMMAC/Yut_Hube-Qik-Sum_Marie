import { PROVIDER_PRESETS } from "./llm.js";

export const DEFAULT_SETTINGS = {
  provider: "openai",
  baseUrl: PROVIDER_PRESETS.openai.baseUrl,
  model: PROVIDER_PRESETS.openai.defaultModel,
  apiKey: "",
  language: "",
  includeFrames: true,
  maxFrames: 8,
};

const store = () => globalThis.chrome?.storage?.local ?? null;

export async function getSettings() {
  const storage = store();
  if (!storage) return { ...DEFAULT_SETTINGS };
  const { settings } = await storage.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function saveSettings(patch) {
  const storage = store();
  const next = { ...(await getSettings()), ...patch };
  if (storage) await storage.set({ settings: next });
  return next;
}

export function applyPreset(current, provider) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return current;
  return {
    ...current,
    provider,
    baseUrl: preset.baseUrl || current.baseUrl,
    model: preset.defaultModel || current.model,
  };
}

/** The origin the extension needs to call, for optional host permission. */
export function originPatternFor(baseUrl) {
  try {
    const { origin } = new URL(baseUrl);
    return `${origin}/*`;
  } catch {
    return null;
  }
}
