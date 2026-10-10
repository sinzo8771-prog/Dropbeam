/**
 * Records the README demo: two browser contexts ("two devices") pair
 * over loopback WebRTC and move a file + a note. Each side is recorded
 * in its own video, then stitched side by side into one GIF.
 *
 *   node scripts/record-demo.mjs
 *
 * Needs a preview server on :4199 (npm run build && npx vite preview).
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const BASE = "http://localhost:4199";
const OUT = "docs";
const WORK = "demo-recording";
const VIEW = { width: 380, height: 760 };

/** Beat length: how long each step holds on screen, in ms. */
const HOLD = 1300;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const browser = await chromium.launch();

async function device(name) {
  const context = await browser.newContext({
    viewport: VIEW,
    recordVideo: { dir: join(WORK, name), size: VIEW },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // The guest stages into OPFS like Firefox/Safari do (PRD 8.5): a headless
  // browser can never finish a native save picker.
  if (name === "guest") {
    await context.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    });
  }
  const page = await context.newPage();
  return { context, page };
}

const host = await device("host");
const guest = await device("guest");

try {
  // 1. Both devices on the home screen.
  await host.page.goto(BASE + "/");
  await guest.page.goto(BASE + "/");
  await pause(HOLD);

  // 2. Host starts: the offer code appears as a QR and as text.
  await host.page.getByRole("button", { name: "Start" }).click();
  await host.page.getByTestId("code-text").waitFor({ timeout: 60000 });
  const offer = (await host.page.getByTestId("code-text").textContent()).replace(/\s+/g, "");
  await pause(HOLD * 1.6);

  // 3. Guest joins and pastes the offer (the paste route).
  await guest.page.evaluate((code) => navigator.clipboard.writeText(code), offer);
  await guest.page.getByRole("button", { name: "Join" }).click();
  await guest.page.getByRole("button", { name: "Paste" }).click();
  await guest.page.getByTestId("code-text").waitFor({ timeout: 60000 });
  const answer = (await guest.page.getByTestId("code-text").textContent()).replace(/\s+/g, "");
  await pause(HOLD * 1.6);

  // 4. Host pastes the reply: both sides connect and show the same words.
  await host.page.evaluate((code) => navigator.clipboard.writeText(code), answer);
  await host.page.getByRole("button", { name: "Paste reply" }).click();
  await host.page.locator('main[data-screen="CONNECTED"]').waitFor({ timeout: 60000 });
  await guest.page.locator('main[data-screen="CONNECTED"]').waitFor({ timeout: 60000 });
  await host.page.locator(".verify-card-words").waitFor({ timeout: 30000 });
  await guest.page.locator(".verify-card-words").waitFor({ timeout: 30000 });
  await pause(HOLD * 2);

  // 5. The host allows the peer — nothing may move before this.
  await host.page.getByRole("button", { name: "Allow" }).click();
  await pause(HOLD);

  // 6. The host sends a file; the guest accepts it.
  const payload = Buffer.from(
    "Dropbeam moves this file straight between the two devices.\n".repeat(8),
  );
  await host.page.getByTestId("file-input").setInputFiles({
    name: "holiday-notes.txt",
    mimeType: "text/plain",
    buffer: payload,
  });
  await guest.page.getByRole("button", { name: "Accept" }).click();
  await guest.page.getByTestId("saved-row").waitFor({ timeout: 60000 });
  await pause(HOLD * 1.6);

  // 7. A note travels back the other way.
  const note = "Got it — straight from your laptop, nothing uploaded.";
  await guest.page.locator("#note-body").fill(note);
  await guest.page.getByRole("button", { name: "Send" }).click();
  await host.page.getByTestId("note-row").waitFor({ timeout: 30000 });
  await pause(HOLD * 2);
} finally {
  await host.context.close();
  await guest.context.close();
  await browser.close();
}

const videoOf = (dir) => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".webm"));
  if (files.length !== 1) throw new Error(`expected one video in ${dir}, got ${files.length}`);
  return join(dir, files[0]);
};
const hostVideo = videoOf(join(WORK, "host"));
const guestVideo = videoOf(join(WORK, "guest"));

/**
 * Pane labels, drawn from a font copied next to the videos: a relative
 * path keeps the ffmpeg filtergraph free of colon escaping, and the label
 * space is backslash-escaped (the level-1 filtergraph escape).
 */
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/segoeui.ttf",
  "C:/Windows/Fonts/arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];
const font = FONT_CANDIDATES.find((p) => statSync(p, { throwIfNoEntry: false }));
const draw = (text, x) =>
  font
    ? `drawtext=fontfile=${basename(font)}:text=${text.replace(/ /g, "\\ ")}:x=${x}:y=16:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10`
    : null;
// The stitched frame is 380 + 380 px wide, so the right pane's label
// starts one pane-width in.
const labels = [draw("This device", 16), draw("Other device", 396)].filter(Boolean);
if (font) copyFileSync(font, join(WORK, basename(font)));

// Side-by-side: the two devices, one frame, like a split-screen demo. The
// leading blank frames (before the pages paint) are trimmed.
const filter = [
  "[0:v]setpts=PTS-STARTPTS,scale=380:760[a];",
  "[1:v]setpts=PTS-STARTPTS,scale=380:760[b];",
  "[a][b]hstack=inputs=2[v0];",
  `[v0]${labels.join(",")}[v]`,
].join("");
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    hostVideo,
    "-i",
    guestVideo,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-shortest",
    "-r",
    "10",
    "-an",
    "-ss",
    "0.6",
    join(WORK, "pair.mp4"),
  ],
  { stdio: "inherit" },
);

// Paletted GIF: 128 colours, 760px wide, so it stays presentational, not huge.
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    join(WORK, "pair.mp4"),
    "-vf",
    "fps=8,scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4",
    join(OUT, "demo.gif"),
  ],
  { stdio: "inherit" },
);

const size = statSync(join(OUT, "demo.gif")).size;
console.log(`demo.gif written: ${(size / 1024 / 1024).toFixed(2)} MB`);
