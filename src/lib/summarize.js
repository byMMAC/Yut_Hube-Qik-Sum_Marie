import { chatCompletion } from "./llm.js";
import { buildSummaryMessages, buildChunkMessages } from "./prompts.js";
import { toTimestampedLines } from "./transcript.js";

/** Providers wrap JSON in fences often enough that stripping them is worth it. */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const asString = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Normalize whatever the model returned, and drop anything unusable. */
export function normalizeSummary(raw, { countdown = false } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints.map((p) => asString(p, 240)).filter(Boolean).slice(0, 10)
    : [];

  const outline = Array.isArray(raw.outline)
    ? raw.outline
        .map((entry) => ({ time: asString(entry?.time, 12), label: asString(entry?.label, 200) }))
        .filter((entry) => entry.time && entry.label)
        .slice(0, 15)
    : [];

  const items = countdown && Array.isArray(raw.items)
    ? raw.items
        .map((item) => ({
          rank: Number(item?.rank),
          title: asString(item?.title, 200),
          description: asString(item?.description, 500),
          time: asString(item?.time, 12),
        }))
        .filter((item) => Number.isFinite(item.rank) && item.rank > 0 && item.title)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, 100)
    : [];

  const summary = { tldr: asString(raw.tldr, 800), keyPoints, outline };
  if (countdown) summary.items = items;
  return summary.tldr || keyPoints.length || outline.length ? summary : null;
}

/**
 * Long transcripts are compressed in parts first: the final call sees one digest
 * per part instead of a prompt larger than the context window.
 */
export async function summarizeTranscript({
  transcript,
  meta = {},
  countdown = false,
  settings,
  signal,
  fetchImpl = fetch,
  chunkThreshold = 24000,
  onProgress = () => {},
}) {
  const lines = toTimestampedLines(transcript.segments);
  const numbered = lines.map((line) => `[${Math.floor(line.start)}s] ${line.text}`).join("\n");

  const call = (messages, maxTokens) =>
    chatCompletion({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      messages,
      maxTokens,
      signal,
      fetchImpl,
    });

  let body = numbered;
  if (numbered.length > chunkThreshold) {
    const linesPerChunk = Math.ceil(lines.length / Math.ceil(numbered.length / chunkThreshold));
    const chunks = [];
    for (let i = 0; i < lines.length; i += linesPerChunk) chunks.push(lines.slice(i, i + linesPerChunk));

    onProgress({ stage: "condensing", detail: `Summarizing ${chunks.length} parts` });
    const digests = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const chunk = chunks[i].map((line) => `[${Math.floor(line.start)}s] ${line.text}`).join("\n");
      const result = await call(buildChunkMessages({ title: meta.title, chunk, index: i, total: chunks.length }), 1024);
      digests.push(result.content);
      onProgress({ stage: "condensing", detail: `Part ${i + 1} of ${chunks.length}` });
    }
    body = digests.map((digest, i) => `--- Part ${i + 1} ---\n${digest}`).join("\n\n");
  }

  onProgress({ stage: "summarizing", detail: countdown ? "Building the ranked list" : "Writing the summary" });
  const messages = buildSummaryMessages({
    title: meta.title,
    author: meta.author,
    duration: meta.duration,
    language: transcript.language,
    transcript: body,
    countdown,
  });

  const first = await call(messages, 3000);
  const parsed = extractJson(first.content);
  const summary = normalizeSummary(parsed, { countdown });
  if (summary) return { summary, raw: first.content, model: first.model };

  // Some models narrate before the JSON; one repair pass is cheaper than failing.
  onProgress({ stage: "repairing", detail: "The model did not return JSON, retrying once" });
  const repair = await call(
    [...messages, { role: "assistant", content: first.content }, { role: "user", content: "Return only the JSON object described above." }],
    3000,
  );
  const repaired = normalizeSummary(extractJson(repair.content), { countdown });
  if (repaired) return { summary: repaired, raw: repair.content, model: repair.model };

  throw new Error("The model did not return usable JSON after two attempts. Try a different model.");
}
