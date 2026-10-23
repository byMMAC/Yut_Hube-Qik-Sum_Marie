/**
 * Rasterize the icon SVG into the four PNG sizes Chrome needs.
 *
 * Chromium is the renderer: it is already a project dependency, and it is the
 * same engine that will draw the icon in the toolbar, so what is measured here
 * is what the browser shows. The 16 px slot uses a simplified mark, because a
 * scaled-down detailed cassette turns to mush at that size.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "icons");
mkdirSync(outDir, { recursive: true });

const detailed = readFileSync(join(root, "assets", "icon.svg"), "utf8");
const small = readFileSync(join(root, "assets", "icon-16.svg"), "utf8");
const PLAN = [
  { size: 16, svg: small, label: "simplified" },
  { size: 32, svg: detailed, label: "detailed" },
  { size: 48, svg: detailed, label: "detailed" },
  { size: 128, svg: detailed, label: "detailed" },
];

const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage({ deviceScaleFactor: 1 });

const report = [];
for (const { size, svg, label } of PLAN) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    { waitUntil: "load" },
  );
  const buffer = await page.screenshot({ omitBackground: true, type: "png" });
  writeFileSync(join(outDir, `icon-${size}.png`), buffer);

  const stats = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const w = canvas.width;
    const h = canvas.height;

    let transparent = 0, shell = 0, band = 0, reel = 0;
    // Reels sit in the middle vertical band. The cassette outline is dark too and
    // runs the full width along the top and bottom edges, so counting dark pixels
    // over the whole height would report a reel in every column.
    const bandTop = Math.round(h * 0.3);
    const bandBottom = Math.round(h * 0.66);
    const darkColumns = new Array(w).fill(0);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 16) { transparent += 1; continue; }
        if (r > 190 && g < 95 && b < 95) band += 1;
        else if (r > 195 && g > 200 && b > 205) shell += 1;
        else if (r < 80 && g < 85 && b < 95) {
          reel += 1;
          if (y >= bandTop && y < bandBottom) darkColumns[x] += 1;
        }
      }
    }
    const total = w * h;
    const pct = (n) => +((n / total) * 100).toFixed(1);

    // Within the reel band, the only dark columns are the reels themselves, so a
    // light column between them proves they read as two distinct spools.
    const lo = Math.floor(w * 0.25);
    const hi = Math.ceil(w * 0.75);
    const darkInMiddle = [];
    for (let x = lo; x < hi; x += 1) if (darkColumns[x] > 0) darkInMiddle.push(x);
    let gapIsLight = false;
    if (darkInMiddle.length > 1) {
      const first = darkInMiddle[0];
      const last = darkInMiddle[darkInMiddle.length - 1];
      for (let x = first + 1; x < last; x += 1) if (darkColumns[x] === 0) gapIsLight = true;
    }
    const leftReel = darkInMiddle.length > 0 && darkInMiddle[0] < w / 2;
    const rightReel = darkInMiddle.length > 0 && darkInMiddle[darkInMiddle.length - 1] > w / 2;

    return {
      width: w,
      height: h,
      transparentPct: pct(transparent),
      shellPct: pct(shell),
      bandPct: pct(band),
      reelPct: pct(reel),
      twoDistinctReels: leftReel && rightReel && gapIsLight,
    };
  }, `data:image/png;base64,${buffer.toString("base64")}`);

  report.push({ size, label, bytes: buffer.length, ...stats });
}
await browser.close();

const failures = [];
for (const r of report) {
  const where = `${r.size}px (${r.label})`;
  if (r.width !== r.size || r.height !== r.size) failures.push(`${where}: wrong dimensions ${r.width}x${r.height}`);
  if (r.transparentPct < 3) failures.push(`${where}: background is not transparent (${r.transparentPct}%)`);
  if (r.bandPct < 3) failures.push(`${where}: the red label band is missing (${r.bandPct}%)`);
  if (r.shellPct < 10) failures.push(`${where}: the cassette shell is missing (${r.shellPct}%)`);
  if (r.reelPct < 2) failures.push(`${where}: the reels are missing (${r.reelPct}%)`);
  if (!r.twoDistinctReels) failures.push(`${where}: the two reels are not distinguishable`);
}

console.log("size  variant     bytes   shell%  band%  reel%  transp%  two reels");
for (const r of report) {
  console.log(
    `${String(r.size).padStart(4)}  ${r.label.padEnd(10)}  ${String(r.bytes).padStart(5)}  ${String(r.shellPct).padStart(6)}  ${String(r.bandPct).padStart(5)}  ${String(r.reelPct).padStart(5)}  ${String(r.transparentPct).padStart(7)}  ${r.twoDistinctReels}`,
  );
}
if (failures.length) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log("\nAll four icons rendered and verified.");
