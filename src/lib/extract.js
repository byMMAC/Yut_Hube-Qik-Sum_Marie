/**
 * A watch page embeds the player response as JSON inside a script tag. A regex
 * cannot find its end, so walk the braces while respecting string literals.
 */
export function extractPlayerResponse(html) {
  if (typeof html !== "string") return null;
  const marker = html.indexOf("ytInitialPlayerResponse");
  if (marker === -1) return null;
  const start = html.indexOf("{", marker);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function videoMeta(playerResponse) {
  const details = playerResponse?.videoDetails ?? {};
  return {
    videoId: details.videoId ?? null,
    title: typeof details.title === "string" ? details.title : "",
    author: typeof details.author === "string" ? details.author : "",
    duration: Number(details.lengthSeconds) || 0,
    viewCount: Number(details.viewCount) || 0,
  };
}

export function captionTracks(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) return [];
  return tracks
    .map((track) => ({
      url: track?.baseUrl,
      lang: track?.languageCode ?? "",
      name: track?.name?.simpleText ?? track?.name?.runs?.[0]?.text ?? track?.languageCode ?? "",
      isAuto: track?.kind === "asr",
      isTranslatable: Boolean(track?.isTranslatable),
    }))
    .filter((track) => typeof track.url === "string" && track.url.length > 0);
}

export function storyboardSpec(playerResponse) {
  const spec = playerResponse?.storyboards?.playerStoryboardSpecRenderer?.spec;
  return typeof spec === "string" && spec ? spec : null;
}

/**
 * Prefer a human-written track, then one matching the wanted language, then
 * anything. Auto-generated captions are the last resort.
 */
export function pickTrack(tracks, { preferredLanguage = "" } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const wanted = preferredLanguage.trim().toLowerCase();
  const matchesLang = (t) => wanted && (t.lang.toLowerCase() === wanted || t.lang.toLowerCase().startsWith(`${wanted}-`));

  return (
    tracks.find((t) => !t.isAuto && matchesLang(t)) ??
    tracks.find((t) => !t.isAuto && t.lang.toLowerCase().startsWith("en")) ??
    tracks.find((t) => !t.isAuto) ??
    tracks.find(matchesLang) ??
    tracks.find((t) => t.lang.toLowerCase().startsWith("en")) ??
    tracks[0]
  );
}

/** Everything the extension needs from one watch page. */
export function parseVideoPage(html) {
  const playerResponse = extractPlayerResponse(html);
  if (!playerResponse) return { ok: false, reason: "no-player-response", meta: null };
  const meta = videoMeta(playerResponse);
  const tracks = captionTracks(playerResponse);
  return {
    ok: true,
    meta,
    tracks,
    storyboardSpec: storyboardSpec(playerResponse),
    playability: playerResponse?.playabilityStatus?.status ?? "UNKNOWN",
  };
}
