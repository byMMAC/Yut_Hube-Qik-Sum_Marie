const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const WORD = String.raw`(?:\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;

// Titles that announce a ranked list, e.g. "Top 10 Cars", "5 Best Sodas".
const TITLE_PATTERNS = [
  new RegExp(String.raw`\btop\s+${WORD}\b`, "i"),
  new RegExp(String.raw`\b${WORD}\s+(?:best|worst|greatest|biggest|smallest|fastest|slowest|rarest|strongest|weirdest|funniest|coolest|scariest|most\s+\w+)\b`, "i"),
  /\bcountdown\b/i,
  /\branked\b|\brankings?\b/i,
  /\btier\s+list\b/i,
  new RegExp(String.raw`#\s*\d{1,3}\b`),
];

// Spoken/typographic rank markers found in transcripts.
const RANK_PATTERNS = [
  /#\s*(\d{1,3})\b/g,
  new RegExp(String.raw`\bnumber\s+(${WORD})\b`, "gi"),
  new RegExp(String.raw`\b(?:at|in)\s+(?:position|place|spot)\s+(${WORD})\b`, "gi"),
  new RegExp(String.raw`\brank(?:ed|ing)?\s+(${WORD})\b`, "gi"),
  new RegExp(String.raw`\b(${WORD})\s+(?:place|spot|position)\b`, "gi"),
];

export function parseNumberWord(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (/^\d{1,3}$/.test(t)) return Number(t);
  if (t in NUMBER_WORDS) return NUMBER_WORDS[t];
  const parts = t.split(/[\s-]+/);
  if (parts.length === 2 && parts.every((p) => p in NUMBER_WORDS)) {
    const [a, b] = parts.map((p) => NUMBER_WORDS[p]);
    // "twenty three" -> 23, but "hundred five" is not a rank we care about.
    if (a >= 20 && a % 10 === 0 && b < 10) return a + b;
  }
  return null;
}

/** Every rank number mentioned, in transcript order, with the text around it. */
export function collectRankMentions(text) {
  if (typeof text !== "string" || !text) return [];
  const mentions = [];
  const seen = new Set();
  for (const pattern of RANK_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rank = parseNumberWord(match[1]);
      if (!rank || rank < 1 || rank > 100) continue;
      const key = `${rank}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push({ rank, index: match.index, raw: match[0].trim() });
    }
  }
  return mentions.sort((a, b) => a.index - b.index);
}

/**
 * Decide whether a transcript reads as a ranked countdown.
 * Deterministic on purpose: this is a structural property of the text, not a
 * judgement call, so it needs no model and no network.
 */
export function detectCountdown({ title = "", text = "" } = {}) {
  const titleHit = TITLE_PATTERNS.find((p) => p.test(title))?.source ?? null;
  const mentions = collectRankMentions(text);
  const distinct = [...new Set(mentions.map((m) => m.rank))].sort((a, b) => a - b);

  const signals = [];
  if (titleHit) signals.push("title");

  let verdict = "none";
  let maxRank = null;

  if (distinct.length >= 2) {
    const max = distinct[distinct.length - 1];
    const min = distinct[0];
    // The last rank mentioned first is the strongest structural signal: a real
    // countdown states its top entry before working down to number one.
    const order = mentions.map((m) => m.rank);
    const descends = order[0] === max && order[order.length - 1] === min;
    const coverage = distinct.length / max;

    if (max >= 3 && coverage >= 0.5) {
      verdict = "countdown";
      maxRank = max;
      signals.push("ranks");
      if (descends) signals.push("descending");
    } else if (titleHit) {
      verdict = "possible";
      maxRank = max;
      signals.push("sparse-ranks");
    } else {
      verdict = "none";
    }
  } else if (titleHit) {
    verdict = "possible";
    signals.push("title-only");
  }

  return { verdict, signals, maxRank, distinctRanks: distinct, mentions };
}
