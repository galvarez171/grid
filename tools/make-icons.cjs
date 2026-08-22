/* Regenerates the Grid app icons.
 *
 *   node tools/make-icons.cjs
 *
 * Writes icon.svg (the master), icon-512.png and icon-180.png.
 *
 * sharp is pulled straight out of the worker's dev dependencies rather than
 * adding a package.json at the repo root — the frontend deliberately has no
 * build step, and one icon script isn't reason enough to introduce one.
 *
 * Refines the original five-bar mark rather than replacing it (PLAN_V2 §7):
 * softer two-stage glow, rounded bar caps, and a circuit node at the end of
 * each bar so it reads as a grid rather than a bar chart.
 *
 * Note: iOS reads apple-touch-icon only at Add-to-Home-Screen time, so
 * changing these files does NOT update an icon already on the home screen.
 * That needs a one-time delete and re-add.
 */

const fs = require("fs");
const path = require("path");
const sharp = require("../worker/node_modules/sharp");

const ROOT = path.join(__dirname, "..");
const SIZE = 512;

// Four circuits and the wordmark, which sits where the habits bar used to be.
// Keeping five rows preserves the original stack height and rhythm.
const ROWS = [
  { color: "#00B4FF", w: 280 },   // work
  { color: "#FF2D95", w: 186 },   // cheer
  { color: "#A855F7", w: 240 },   // classes
  { text: "GRID", color: "#C9D6E2" },
  { color: "#22E39A", w: 214 }    // personal
];

const X0 = 88;         // bars start here
const BAR_H = 34;
const GAP = 26;
const RX = 9;          // slightly rounded caps, not a pill
const NODE_R = 5.5;
const TRACE_END = 424; // dim trace ends here, mirroring the left inset

// The wordmark is set in the same monospace the app uses, tracked out to match
// the header's wide letter-spacing. Sized to occupy roughly a bar's width so
// the row doesn't read as a gap in the stack.
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const FONT_SIZE = 34;
const TRACK = 11;                 // extra letter-spacing, in px
// Monospace advance is ~0.6em; the last letter contributes no trailing track.
const textWidth = t => Math.round(t.length * FONT_SIZE * 0.6 + (t.length - 1) * TRACK);

// Vertically centre the whole stack.
const stackH = ROWS.length * BAR_H + (ROWS.length - 1) * GAP;
const Y0 = Math.round((SIZE - stackH) / 2);

// Everything meaningful stays inside the maskable safe zone (the centre 80%,
// i.e. 51.2–460.8) so a maskable crop never eats a bar or a node.
function shapes(b, i) {
  const y = Y0 + i * (BAR_H + GAP);
  const cy = y + BAR_H / 2;
  const w = b.text ? textWidth(b.text) : b.w;
  const nodeX = X0 + w + 20;
  // No dominant-baseline here: support for it is patchy across SVG
  // rasterisers, so the baseline is offset by hand instead.
  const lit = b.text
    // Nudged left by the glyph's side bearing so the wordmark optically
    // aligns with the bars' left edge rather than sitting a hair inside it.
    ? `<text x="${X0 - 3}" y="${cy + FONT_SIZE * 0.35}" font-family="${FONT}" font-size="${FONT_SIZE}" font-weight="600" letter-spacing="${TRACK}" fill="${b.color}">${b.text}</text>` +
      `<circle cx="${nodeX}" cy="${cy}" r="${NODE_R}" fill="${b.color}"/>`
    : `<rect x="${X0}" y="${y}" width="${b.w}" height="${BAR_H}" rx="${RX}" fill="${b.color}"/>` +
      `<circle cx="${nodeX}" cy="${cy}" r="${NODE_R}" fill="${b.color}"/>`;
  return {
    lit,
    isText: !!b.text,
    trace: `<line x1="${nodeX + 14}" y1="${cy}" x2="${TRACE_END}" y2="${cy}" stroke="#1E2C3A" stroke-width="3" stroke-linecap="round"/>`
  };
}

const body = ROWS.map((b, i) => {
  const s = shapes(b, i);
  // Two blur passes: a wide, faint halo and a tighter brighter one, then the
  // crisp shape on top. The single hard glow before this bloomed too evenly
  // and lost the edge of the bar.
  // Letterforms are thin, so the full three-pass bloom that flatters a solid
  // bar just smears them. The wordmark gets one restrained halo instead.
  const glow = s.isText
    ? `<g filter="url(#wide)" opacity=".22">${s.lit}</g>`
    : `<g filter="url(#wide)" opacity=".60">${s.lit}</g>
    <g filter="url(#wide)" opacity=".35">${s.lit}</g>
    <g filter="url(#tight)" opacity=".90">${s.lit}</g>`;
  return `  <g>
    ${glow}
    ${s.trace}
    ${s.lit}
  </g>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <filter id="wide" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
    <filter id="tight" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4"/>
    </filter>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="#05070A"/>
  <!-- iOS masks the icon to a squircle whose corner radius is ~22% of the
       icon, so a frame close to the edge loses its corners. This one sits
       inside the 80% safe zone with a radius that echoes the mask. -->
  <rect x="52.5" y="52.5" width="407" height="407" rx="56" fill="none" stroke="#16202B" stroke-width="1"/>
${body}
</svg>
`;

fs.writeFileSync(path.join(ROOT, "icon.svg"), svg);

(async () => {
  for (const size of [512, 180]) {
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(path.join(ROOT, `icon-${size}.png`));
    console.log(`wrote icon-${size}.png`);
  }
})();
