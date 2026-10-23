# YouTube Summarizer (Chrome extension)

A Manifest V3 extension that summarizes a YouTube video into a TL;DR, key points,
and a timestamped outline. When the video is a ranked countdown, it also lists every
rank with its own title, description, and a frame captured from the video.

You supply your own model provider API key. Nothing is bundled, and no server is
required.

It works on YouTube only; see [Site support](#site-support-youtube-only).

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. The settings page opens on first install. Pick a provider and paste an API key.

Then open any YouTube watch page and click the extension icon, or the **Summarize**
button next to the video.

## How it works

| Step | Where | Notes |
| --- | --- | --- |
| Read the video | Extension fetch of the watch page | `host_permissions` cover `youtube.com` and `i.ytimg.com` |
| Get the transcript | Caption track, or YouTube's own transcript panel | See the limitation below |
| Detect a countdown | Local code, no model | Title and rank structure, deterministic |
| Summarize | Your provider's chat-completions API | Any OpenAI-compatible endpoint |
| Frame captures | YouTube storyboard sprite sheets | Decoded and cropped in the browser, no ffmpeg |

### Countdown detection is deterministic

Whether a video is a ranked list is a structural property of the text, so it is
decided by local code rather than a model: the title is matched against patterns
such as `top 10` or `5 best`, the transcript is scanned for rank markers like
`number seven` or `#3`, and the ranks must form a near-complete descending
sequence. This is free, instant, offline, and repeatable.

### Frame captures

YouTube publishes storyboard sprite sheets: grids of frames in one image. The
extension reads the signed spec from the player response, downloads the tile that
contains the timestamp it needs, crops that frame on a canvas, and re-encodes it as
JPEG. Frames are about two seconds apart, so a still lands close to the timestamp
it illustrates.

## Settings

| Field | Purpose |
| --- | --- |
| Provider | Preset for OpenAI, OpenRouter, Groq, Google Gemini, a local server, or a custom endpoint |
| Base URL | Any OpenAI-compatible base URL. `/chat/completions` is appended if absent |
| Model | Model name passed through to the provider |
| API key | Stored in `chrome.storage.local` for this browser profile only |
| Transcript language | Preferred caption language, blank for best available |
| Include frame captures | Turn screenshots off to save time and requests |
| Maximum frames | Upper bound on captured stills |

**Test connection** sends a one-token request so you can confirm the key, base URL,
and model before summarizing.

A non-public base URL needs the optional host permission, which the settings page
requests on your behalf. Local servers such as Ollama or LM Studio work with no key.

## Known limitation: caption downloads

YouTube now requires a proof-of-origin token for direct caption downloads. Without
one, the caption endpoint answers `200` with an empty body. The extension detects
this specifically rather than reporting a vague failure, then falls back to reading
the transcript from YouTube's own transcript panel using your logged-in session,
which is not subject to the token requirement.

If both paths fail, the panel says so and suggests trying a video whose transcript
panel opens.

## Site support: YouTube only

This extension works on YouTube and nowhere else. Three things pin it there:

- `host_permissions` covers only `youtube.com` and `i.ytimg.com`
- The content script matches only `https://www.youtube.com/watch*`
- Ingestion reads YouTube-specific structures: `ytInitialPlayerResponse` in the page
  HTML, `ytd-transcript-segment-renderer` elements, the `/api/timedtext` caption
  endpoint, and `i.ytimg.com` storyboard sprites

Chrome will not run the content script on another site, and requests to other hosts
would be blocked.

### About half is already portable

The pipeline splits in two, and the split is not where you might guess.

| Portable | Coupled to the source |
| --- | --- |
| `countdown.js` ranked-list detection | `extract.js` watch page reading |
| `summarize.js` chunking and JSON repair | `transcript.js` caption fetching |
| `prompts.js` prompt construction | `storyboard.js` sprite-sheet geometry |
| `llm.js` provider client | `frames.js` frame cropping |
| `settings.js` | `videoid.js` URL parsing |
| | `time.js` one deep-link builder |

Deciding whether a video is a countdown, and turning a transcript into a structured
summary, involves no YouTube references at all. Those modules would work unchanged on
any site that can supply a transcript.

`frames.js` is worth calling out because it looks portable and is not. Its API takes
storyboard `level` and `frame` objects, so it is tied to that abstraction even though
it contains no YouTube strings. Only its blob-to-data-URL and canvas encoding helpers
would carry over.

### What a new site needs

Two things, and the second is the hard one.

**A transcript.** Usually easy. Vimeo has caption tracks, and most players expose
WebVTT somewhere.

**Frames.** Here the difficulty inverts:

- A plain HTML5 `<video>` element is easier than YouTube. Seek to the timestamp, draw
  the element to a canvas, and the result is an exact frame, more accurate than
  YouTube's storyboard grid.
- DRM-protected services such as Netflix, Disney+, and Prime Video are not possible.
  Widevine blocks canvas reads by design, and there is no legitimate way around it.
- Live streams have no caption track and no fixed timeline, so a timestamped outline
  has nothing to point at.

| Site | Transcript | Frames | Verdict |
| --- | --- | --- | --- |
| YouTube | done | storyboards | shipped |
| Vimeo | easy | undocumented | feasible |
| Any HTML5 `<video>` | varies | easy, seek and capture | feasible |
| Netflix, Disney+, Prime Video | n/a | blocked by DRM | not possible |
| Twitch and other live streams | usually none | n/a | not possible |

### Adding a site

The clean approach is a site adapter: each site implements `getTranscript()` and
`getFrames()`, and everything downstream stays as it is. Adapters can then be added
one at a time, and a site that cannot supply frames still gets a summary.

## Privacy

- The transcript is sent to the provider you configure. Nothing else leaves the browser.
- The API key is stored locally and is never sent anywhere except your chosen provider.
- No analytics, no telemetry, no remote code.
- The icon is generated locally from a checked-in SVG; no third-party artwork is bundled.

## Development

```sh
npm install
npm test          # 48 unit tests
npm run icons     # regenerate icons/*.png from assets/*.svg
```

### Icons

The mark is a VHS cassette: a light shell, two reels, and a red label band. It is
authored as SVG in `assets/` and rasterized to the four sizes Chrome needs by
`scripts/make-icons.mjs`, which uses Chromium so the output matches what the
toolbar draws.

The 16 px slot uses `assets/icon-16.svg`, a separate mark drawn on a 16-unit grid
rather than the detailed cassette scaled down, because at that size the outline and
reel holes collapse into mush.

The script measures each PNG after rendering and fails if a required element is
missing, so the icons cannot silently regress into a solid square.

Layout:

```
manifest.json          MV3 manifest
src/background.js      service worker: side panel wiring, active tab lookup
src/content.js         watch-page button, transcript panel reader
src/panel/             side panel UI and orchestration
src/options/           settings page
src/lib/               pure modules, unit tested
  extract.js             player response, caption tracks, storyboard spec
  transcript.js          caption fetch, json3 parsing, panel fallback
  countdown.js           deterministic ranked-list detection
  storyboard.js          sprite-sheet spec parsing and frame geometry
  frames.js              tile download, canvas crop, JPEG encoding
  summarize.js           prompt orchestration, JSON recovery, normalization
  llm.js                 provider-agnostic chat client
  prompts.js             prompt and schema construction
  settings.js            defaults, storage, provider presets
  time.js                timestamp formatting and parsing
  videoid.js             video id extraction from URLs
test/                  unit tests and a real captured storyboard fixture
assets/icon.svg        detailed cassette, used at 32/48/128
assets/icon-16.svg     simplified mark for the 16 px slot
icons/                 generated PNGs referenced by the manifest
scripts/make-icons.mjs renders and verifies the icon PNGs
```

`test/fixtures-storyboard.json` holds a real storyboard spec captured from a live
video, so the sprite-sheet geometry is tested against genuine data.
