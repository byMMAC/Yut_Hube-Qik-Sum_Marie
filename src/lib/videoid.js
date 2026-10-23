const ID = /^[A-Za-z0-9_-]{11}$/;

/** Accept a bare 11-character id or any common YouTube URL shape. */
export function extractVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const raw = input.trim();
  if (ID.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return ID.test(id) ? id : null;
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const v = url.searchParams.get("v");
    if (v && ID.test(v)) return v;
    const match = url.pathname.match(/^\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
  }
  return null;
}
