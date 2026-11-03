#!/usr/bin/env node
/**
 * Render the approved mockup HTML and the running app at 1440×900,
 * save side-by-side PNGs, and report a pixelmatch diff % per screen.
 *
 *   BASE_URL=http://127.0.0.1:43123 node scripts/visual-compare/compare.mjs
 *   node scripts/visual-compare/compare.mjs --check
 *
 * --check exits 1 when a screen's diff exceeds baseline.json by more than 0.5
 * percentage points. The app must already be running and seeded
 * (olga@ambeauty.local / ambeauty). Mockup HTML is docs/design/src/.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(here, "out");
const baselinePath = path.join(here, "baseline.json");
const mockupDir = process.env.MOCKUP_DIR ?? path.join(root, "docs/design/src");
const baseUrl = (process.env.BASE_URL ?? "http://127.0.0.1:43123").replace(/\/$/, "");
const check = process.argv.includes("--check");
const tolerance = 0.5;
const view = { width: 1440, height: 900 };

const screens = [
  { id: "dashboard", mockup: "dashboard.html", route: "/dashboard", ready: "Обзор студии" },
  { id: "journal", mockup: "calendar.html", route: "/journal", ready: "ожидаемая выручка" },
];

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function blank(width, height, rgba) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = 255;
  }
  return png;
}

function sideBySide(left, right) {
  const gap = 24;
  const width = left.width + gap + right.width;
  const height = Math.max(left.height, right.height);
  const out = blank(width, height, [246, 242, 244]);
  PNG.bitblt(left, out, 0, 0, left.width, left.height, 0, 0);
  PNG.bitblt(right, out, 0, 0, right.width, right.height, left.width + gap, 0);
  return out;
}

function diffPercent(mockup, app) {
  if (mockup.width !== app.width || mockup.height !== app.height) {
    throw new Error(`Size mismatch mockup ${mockup.width}x${mockup.height} vs app ${app.width}x${app.height}`);
  }
  const diff = new PNG({ width: mockup.width, height: mockup.height });
  const mismatched = pixelmatch(mockup.data, app.data, diff.data, mockup.width, mockup.height, {
    threshold: 0.1,
    includeAA: false,
  });
  const pct = (mismatched / (mockup.width * mockup.height)) * 100;
  return { diff, pct: Math.round(pct * 100) / 100, mismatched };
}

async function fontReport(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const families = [...document.fonts].map((font) => ({
      family: font.family.replace(/['"]/g, ""),
      status: font.status,
      weight: font.weight,
    }));
    const probe = document.querySelector("h1") ?? document.body;
    const logo = document.querySelector(".font-serif");
    const bodyFamily = getComputedStyle(document.body).fontFamily;
    const displayFamily = getComputedStyle(probe).fontFamily;
    const logoFamily = logo ? getComputedStyle(logo).fontFamily : "";
    const has = (name) => families.some((font) => font.family.toLowerCase().includes(name) && font.status === "loaded");
    return {
      body: bodyFamily,
      display: displayFamily,
      logo: logoFamily,
      loaded: {
        inter: bodyFamily.toLowerCase().includes("inter") && has("inter"),
        unbounded: displayFamily.toLowerCase().includes("unbounded") && has("unbounded"),
        playfair: logoFamily.toLowerCase().includes("playfair") && has("playfair"),
      },
      families: [...new Set(families.map((font) => font.family))],
    };
  });
}

async function overflowReport(page) {
  return page.evaluate(() => {
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const problems = [];
    for (const el of document.querySelectorAll("body *")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const cls = typeof el.className === "string" ? el.className : "";
      if (cls.split(/\s+/).includes("blob") || cls.split(/\s+/).includes("grain")) continue;
      const pastRight = rect.right > viewport.w + 1;
      const pastBottom = rect.bottom > viewport.h + 1;
      const text = (el.childNodes.length && [...el.childNodes].every((node) => node.nodeType === Node.TEXT_NODE))
        ? (el.textContent ?? "").trim()
        : "";
      const wraps = text.length > 0 && style.whiteSpace !== "nowrap" && el.scrollHeight > el.clientHeight + 2 && rect.width < 280 && text.length < 48;
      const clipsText = text.length > 8 && el.scrollWidth > el.clientWidth + 4 && style.textOverflow !== "ellipsis" && style.overflow !== "hidden" && style.overflowX !== "hidden";
      if ((pastRight || pastBottom || clipsText) && problems.length < 40) {
        problems.push({
          tag: el.tagName.toLowerCase(),
          className: cls.slice(0, 80),
          text: text.slice(0, 48),
          pastRight,
          pastBottom,
          clipsText,
          wraps,
        });
      }
    }
    return { viewport, problems };
  });
}

async function shootMockup(page, file) {
  const url = `file://${path.join(mockupDir, file)}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll("svg").length > 8, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  return page.screenshot({ animations: "disabled", caret: "hide" });
}

async function shootApp(page, route, readyText) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle", timeout: 60000 });
  await page.getByText(readyText, { exact: false }).first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector(".skeleton"), { timeout: 20000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const fonts = await fontReport(page);
  const overflow = await overflowReport(page);
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  return { png, fonts, overflow };
}

if (!fs.existsSync(path.join(mockupDir, "dashboard.html"))) {
  console.error(`Mockup HTML not found in ${mockupDir}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-dev-shm-usage", "--font-render-hinting=none"],
});
const context = await browser.newContext({
  viewport: view,
  deviceScaleFactor: 1,
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
});
const page = await context.newPage();

const report = { baseUrl, mockupDir, viewport: view, screens: {}, fonts: null, overflow: {} };

try {
  const health = await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch((error) => {
    throw new Error(`App is not reachable at ${baseUrl} (${error.message}). Start it with npm run dev and seed the database.`);
  });
  if (!health || health.status() >= 500) {
    throw new Error(`App at ${baseUrl} returned ${health ? health.status() : "no response"}`);
  }
  const login = await context.request.post(`${baseUrl}/api/auth/login`, {
    data: { email: "olga@ambeauty.local", password: "ambeauty" },
  });
  if (!login.ok()) {
    throw new Error(`Login failed (${login.status()}). Seed the database with npm run db:seed.`);
  }

  for (const screen of screens) {
    const mockupPng = await shootMockup(page, screen.mockup);
    const mockupPath = path.join(outDir, `${screen.id}-mockup.png`);
    fs.writeFileSync(mockupPath, mockupPng);

    const shot = await shootApp(page, screen.route, screen.ready);
    const appPath = path.join(outDir, `${screen.id}-app.png`);
    fs.writeFileSync(appPath, shot.png);
    report.fonts = shot.fonts;
    report.overflow[screen.id] = shot.overflow;

    const mockup = readPng(mockupPath);
    const app = readPng(appPath);
    const { diff, pct, mismatched } = diffPercent(mockup, app);
    fs.writeFileSync(path.join(outDir, `${screen.id}-diff.png`), PNG.sync.write(diff));
    fs.writeFileSync(path.join(outDir, `${screen.id}-side.png`), PNG.sync.write(sideBySide(mockup, app)));
    report.screens[screen.id] = { diffPercent: pct, mismatchedPixels: mismatched, pixels: mockup.width * mockup.height };
    console.log(`${screen.id}: ${pct.toFixed(2)}% different`);
  }

  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    for (const screen of screens) {
      await page.goto(`${baseUrl}${screen.route}`, { waitUntil: "networkidle", timeout: 60000 });
      await page.getByText(screen.ready, { exact: false }).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(250);
      const key = `${screen.id}@${size.width}x${size.height}`;
      report.overflow[key] = await overflowReport(page);
      const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
      fs.writeFileSync(path.join(outDir, `${screen.id}-${size.width}x${size.height}.png`), shot);
    }
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

const fonts = report.fonts?.loaded ?? {};
console.log("fonts", JSON.stringify(fonts));
if (report.fonts && (!fonts.inter || !fonts.unbounded)) {
  console.error("Inter or Unbounded did not load");
  if (check) process.exitCode = 1;
}

if (check) {
  if (!fs.existsSync(baselinePath)) {
    console.error(`Missing ${baselinePath}`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  let failed = false;
  for (const screen of screens) {
    const actual = report.screens[screen.id].diffPercent;
    const allowed = Number(baseline[screen.id]) + tolerance;
    const ok = actual <= allowed + 1e-9;
    console.log(`${screen.id}: ${actual}% (baseline ${baseline[screen.id]}% + ${tolerance} → allow ${allowed}%) ${ok ? "ok" : "FAIL"}`);
    if (!ok) failed = true;
  }
  if (failed) process.exit(1);
}
