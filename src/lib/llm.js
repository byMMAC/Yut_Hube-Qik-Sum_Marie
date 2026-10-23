/**
 * Any provider that speaks the OpenAI chat-completions shape works here, which
 * covers hosted APIs and local servers such as Ollama or LM Studio. The user
 * supplies the key; nothing is bundled.
 */
export const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    keyUrl: "https://openrouter.ai/keys",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  google: {
    label: "Google Gemini (OpenAI-compatible)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  local: {
    label: "Local server (Ollama, LM Studio)",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    keyUrl: "",
    keyOptional: true,
    needsHostPermission: true,
  },
  custom: {
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
    keyOptional: true,
  },
};

export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("No provider base URL configured");
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

/** Turn transport failures into something a person can act on. */
export function describeHttpError(status, body) {
  const detail = typeof body === "string" ? body.slice(0, 300) : "";
  if (status === 401 || status === 403) return `The provider rejected the API key (HTTP ${status}). Check it in settings. ${detail}`;
  if (status === 404) return `The provider has no such model or endpoint (HTTP 404). Check the model name and base URL. ${detail}`;
  if (status === 429) return `Rate limited or out of quota (HTTP 429). Try again shortly. ${detail}`;
  if (status >= 500) return `The provider failed with HTTP ${status}. Try again. ${detail}`;
  return `Provider request failed with HTTP ${status}. ${detail}`;
}

export async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens = 2048,
  temperature = 0.2,
  signal,
  fetchImpl = fetch,
}) {
  if (!model) throw new Error("No model configured");

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetchImpl(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(
      `Could not reach the provider at ${baseUrl}. Check the base URL, and grant the extension access to that host if it is not a public API.`,
    );
  }

  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* the status alone is enough */
    }
    throw new Error(describeHttpError(res.status, body));
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The provider returned no text. The model may have refused or hit a token limit.");
  }
  return { content, usage: payload?.usage ?? null, model: payload?.model ?? model };
}
