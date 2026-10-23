export const SUMMARY_SCHEMA_INSTRUCTIONS = `Reply with JSON only, no prose and no code fences, shaped exactly like:
{
  "tldr": "two or three sentences",
  "keyPoints": ["short point", "..."],
  "outline": [{ "time": "m:ss", "label": "short section title" }]
}
Rules:
- "time" must be copied from a timestamp that appears in the transcript. Never invent one.
- Use 3 to 8 key points and 4 to 12 outline entries.
- Keep every string under 160 characters.`;

export const COUNTDOWN_SCHEMA_INSTRUCTIONS = `The video is a ranked countdown. Reply with JSON only, no prose and no code fences, shaped exactly like:
{
  "tldr": "two or three sentences",
  "keyPoints": ["short point", "..."],
  "outline": [{ "time": "m:ss", "label": "short section title" }],
  "items": [
    { "rank": 1, "title": "name of the entry", "description": "one or two sentences", "time": "m:ss" }
  ]
}
Rules:
- Include one item per rank, from the highest number down to number one.
- "rank" is a number. "title" is the entry's own name, not a restatement of the rank.
- "time" must be copied from a timestamp that appears in the transcript, and must be where that entry is introduced.
- Never invent ranks, entries, or timestamps. If a rank is missing from the transcript, leave it out.`;

export function buildSummaryMessages({ title, author, duration, transcript, language, countdown }) {
  const system = [
    "You summarize YouTube videos for someone deciding whether to watch.",
    "Work only from the transcript provided. If the transcript is thin, say less rather than guessing.",
    countdown ? COUNTDOWN_SCHEMA_INSTRUCTIONS : SUMMARY_SCHEMA_INSTRUCTIONS,
  ].join("\n\n");

  const header = [
    `Title: ${title || "(unknown)"}`,
    author ? `Channel: ${author}` : null,
    duration ? `Duration: ${duration} seconds` : null,
    language ? `Transcript language: ${language}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: `${header}\n\nTranscript (each line is prefixed with its start time):\n${transcript}` },
  ];
}

/** One chunk of a long transcript, summarized on its own before a final merge. */
export function buildChunkMessages({ title, chunk, index, total }) {
  return [
    {
      role: "system",
      content:
        "You compress one part of a longer video transcript. Reply with plain prose, no JSON. " +
        "Keep every timestamp that appears, because later steps cite them.",
    },
    {
      role: "user",
      content: `Video: ${title || "(unknown)"}\nPart ${index + 1} of ${total}.\n\nTranscript:\n${chunk}`,
    },
  ];
}
