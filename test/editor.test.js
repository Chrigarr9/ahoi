// End-to-end: drives index.html in headless Chromium and checks what the user gets out (exported files).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright-core");
const loadCore = require("./load-core");

const core = loadCore();
const TOOL_URL = pathToFileURL(path.join(__dirname, "..", "index.html")).href;
let browser;

test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function openTool() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(TOOL_URL);
  await page.getByRole("status").filter({ hasText: /ms/ }).waitFor();
  page.errors = errors;
  return page;
}

// Canvas fraction -> page pixels (the canvas shows exactly the print area)
async function at(page, fx, fy) {
  const box = await page.locator("#stage").boundingBox();
  return [box.x + fx * box.width, box.y + fy * box.height];
}

async function drag(page, from, to, steps = 12) {
  await page.mouse.move(...(await at(page, ...from)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, ...to)), { steps });
  await page.mouse.up();
}

async function download(page, buttonName) {
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: buttonName, exact: true }).click()]);
  return fs.readFileSync(await file.path());
}

const exportedDesign = async (page) => core.loadDesignFromSVG((await download(page, "Export SVG")).toString("utf8"));

function worldPoints(el) {
  const { x, y, s, r } = el.transform;
  return el.points.map(([px, py]) => [x + s * (Math.cos(r) * px - Math.sin(r) * py), y + s * (Math.sin(r) * px + Math.cos(r) * py)]);
}

test("drawing with the letter tool adds a stroke to the exported design", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.3, 0.3], [0.3, 0.6]);

  const d = await exportedDesign(page);
  assert.strictEqual(d.drawing.elements.length, 1);
  assert.strictEqual(d.drawing.elements[0].type, "stroke");
  const ys = worldPoints(d.drawing.elements[0]).map((p) => p[1] / (d.drawing.canvas.heightCm * 10));
  assert.ok(Math.abs(Math.min(...ys) - 0.3) < 0.02 && Math.abs(Math.max(...ys) - 0.6) < 0.02, `stroke spans ${Math.min(...ys)}..${Math.max(...ys)}`);
  assert.deepStrictEqual(page.errors, []);
});

test("a placed boat can be moved, and undo puts it back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Boat", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await drag(page, [0.5, 0.5], [0.7, 0.5]);

  const W = (d) => d.drawing.canvas.widthCm * 10;
  let d = await exportedDesign(page);
  assert.strictEqual(d.drawing.elements[0].type, "boat");
  assert.ok(Math.abs(d.drawing.elements[0].transform.x / W(d) - 0.7) < 0.02, `moved boat at ${d.drawing.elements[0].transform.x / W(d)}`);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  d = await exportedDesign(page);
  assert.ok(Math.abs(d.drawing.elements[0].transform.x / W(d) - 0.5) < 0.02, `undone boat at ${d.drawing.elements[0].transform.x / W(d)}`);
  assert.deepStrictEqual(page.errors, []);
});

test("an exported SVG reopens with the same design", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Dot", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByLabel("Seed", { exact: true }).fill("42");
  await page.getByLabel("Seed", { exact: true }).press("Enter");
  const svg = await download(page, "Export SVG");

  const fresh = await openTool();
  await fresh.locator("#open-file").setInputFiles({ name: "saved.svg", mimeType: "image/svg+xml", buffer: svg });
  await fresh.getByRole("status").filter({ hasText: /opened/i }).waitFor();
  const reopened = await exportedDesign(fresh);
  assert.deepStrictEqual(reopened, core.loadDesignFromSVG(svg.toString("utf8")));
  assert.strictEqual(reopened.style.sea.seed, 42);
  assert.strictEqual(reopened.drawing.elements[0].type, "dot");
});

test("PNG export size follows the canvas size in cm and the DPI", async () => {
  const page = await openTool();
  await page.getByLabel("Width (cm)").fill("10");
  await page.getByLabel("Width (cm)").press("Enter");
  await page.getByLabel("Height (cm)").fill("20");
  await page.getByLabel("Height (cm)").press("Enter");
  await page.getByLabel("DPI").fill("100");
  const png = await download(page, "Export PNG");
  // IHDR: width and height are big-endian at bytes 16 and 20
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [394, 787]);
});

test("clicking an element selects it so it can be deleted", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Dot", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByRole("button", { name: "Delete", exact: true }).click({ timeout: 2000 });

  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 0);
});

test("a selection colour picker keeps working across repeated changes", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Boat", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  const sail = await page.getByLabel("Sail").elementHandle(); // the same input a user keeps dragging in
  await sail.fill("#ff0000");
  await sail.fill("#00ff00");

  assert.strictEqual((await exportedDesign(page)).drawing.elements[0].sailColor, "#00ff00");
});

test("reset starts a fresh default design, and undo brings the old one back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Dot", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByLabel("Seed", { exact: true }).fill("42");
  await page.getByLabel("Seed", { exact: true }).press("Enter");

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  assert.deepStrictEqual(await exportedDesign(page), core.defaultDesign());

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const restored = await exportedDesign(page);
  assert.strictEqual(restored.style.sea.seed, 42);
  assert.strictEqual(restored.drawing.elements.length, 1);
});

test("the eraser cuts a letter stroke in two", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.2, 0.5], [0.8, 0.5], 30);
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  await drag(page, [0.5, 0.45], [0.5, 0.55], 10);

  const strokes = (await exportedDesign(page)).drawing.elements.filter((e) => e.type === "stroke");
  assert.strictEqual(strokes.length, 2);
  const xs = strokes.map((s) => worldPoints(s).map((p) => p[0] / 297));
  assert.ok(xs.some((x) => Math.max(...x) < 0.5) && xs.some((x) => Math.min(...x) > 0.5), "one piece left, one right of the cut");
});

test("Surprise me changes only the ticked style groups, keeps the drawing, and history jumps back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.3, 0.3], [0.3, 0.6]);
  const before = await exportedDesign(page);

  await page.getByLabel("Colours", { exact: true }).uncheck();
  await page.getByRole("button", { name: "🎲 Surprise me" }).click();
  const first = await exportedDesign(page);
  assert.deepStrictEqual(first.drawing, before.drawing);
  assert.deepStrictEqual(first.style.palette, before.style.palette, "colours were not ticked");
  assert.notDeepStrictEqual(first.style.sea, before.style.sea);

  await page.getByRole("button", { name: "🎲 Surprise me" }).click();
  await page.getByRole("button", { name: "Use look 1" }).click();
  assert.deepStrictEqual((await exportedDesign(page)).style, first.style);
});

test("a style exported from the library applies to another drawing", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "🎲 Surprise me" }).click();
  const styled = await exportedDesign(page);
  await page.getByRole("button", { name: "★ Save current style" }).click();
  await page.getByText("Style library", { exact: true }).click();
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Export style/ }).first().click()]);
  const styleJson = fs.readFileSync(await file.path());

  const other = await openTool();
  await other.getByRole("button", { name: "Dot", exact: true }).click();
  await other.mouse.click(...(await at(other, 0.5, 0.5)));
  await other.locator("#import-style").setInputFiles({ name: "look.json", mimeType: "application/json", buffer: styleJson });
  await other.getByRole("status").filter({ hasText: /applied style/i }).waitFor();
  const applied = await exportedDesign(other);
  assert.deepStrictEqual(applied.style, styled.style);
  assert.strictEqual(applied.drawing.elements[0].type, "dot");
});

test("a selected shape can be switched to woven", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Boat", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  await page.getByRole("button", { name: "Woven", exact: true }).click();
  assert.strictEqual((await exportedDesign(page)).drawing.elements[0].mode, "woven");
});

// Chromium DevTools input: real pen and multi-touch pointer events
async function penDrag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const [x0, y0] = await at(page, ...from), [x1, y1] = await at(page, ...to);
  const send = (type, x, y, buttons) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, pointerType: "pen", clickCount: 1 });
  await send("mousePressed", x0, y0, 1);
  for (let i = 1; i <= 10; i++) await send("mouseMoved", x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, 1);
  await send("mouseReleased", x1, y1, 0);
}
async function touch(page, frames) {
  const cdp = await page.context().newCDPSession(page);
  const [first, ...rest] = frames;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: first.map(([x, y], id) => ({ x, y, id })) });
  for (const f of rest) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: f.map(([x, y], id) => ({ x, y, id })) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("a pen draws, while a finger pans and two fingers zoom instead of drawing", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await penDrag(page, [0.3, 0.3], [0.3, 0.6]);
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 1, "pen stroke");

  const box0 = await page.locator("#stage").boundingBox();
  const [cx, cy] = [box0.x + box0.width / 2, box0.y + box0.height / 2];
  await touch(page, Array.from({ length: 8 }, (_, i) => [[cx + i * 10, cy]]));
  const box1 = await page.locator("#stage").boundingBox();
  assert.ok(Math.abs(box1.x - box0.x - 70) < 5, `one finger pans (moved ${box1.x - box0.x})`);

  await touch(page, Array.from({ length: 8 }, (_, i) => [[cx - 20 - i * 15, cy], [cx + 20 + i * 15, cy]]));
  const box2 = await page.locator("#stage").boundingBox();
  assert.ok(box2.width > box1.width * 1.5, `two fingers zoom (${box1.width} -> ${box2.width})`);
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 1, "fingers did not draw");
});

const pixelAt = (page, fx, fy) => page.evaluate(([fx, fy]) => {
  const c = document.getElementById("stage");
  return [...c.getContext("2d").getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data];
}, [fx, fy]);

test("letter view shows the painted letters on plain paper without the sea", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.5, 0.2], [0.5, 0.8], 20);
  await page.getByRole("button", { name: "Letter view" }).click();
  assert.deepStrictEqual(await pixelAt(page, 0.2, 0.5), [250, 248, 242, 255], "paper, no waves");
  assert.deepStrictEqual(await pixelAt(page, 0.5, 0.5), [29, 39, 51, 255], "the painted stroke");
});

test("a transparent background exports a PNG with transparent pixels", async () => {
  const page = await openTool();
  await page.getByLabel("Width (cm)").fill("10");
  await page.getByLabel("Width (cm)").press("Enter");
  await page.getByLabel("Height (cm)").fill("10");
  await page.getByLabel("Height (cm)").press("Enter");
  await page.locator("summary", { hasText: "Colours" }).click();
  await page.getByLabel("Transparent colour").selectOption("background");
  await page.locator("summary", { hasText: "Edges" }).click();
  await page.getByLabel("Wavy border").check(); // keeps the corner free of strokes
  const png = await download(page, "Export PNG");

  // first pixel of the first scanline: every PNG filter leaves it unchanged
  const zlib = require("node:zlib");
  const chunks = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o), type = png.toString("ascii", o + 4, o + 8);
    if (type === "IDAT") chunks.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  assert.strictEqual(png[25], 6, "RGBA colour type");
  assert.strictEqual(raw[4], 0, "corner pixel alpha");
});

test("two fingers moving together pan the canvas", async () => {
  const page = await openTool();
  const box0 = await page.locator("#stage").boundingBox();
  const [cx, cy] = [box0.x + box0.width / 2, box0.y + box0.height / 2];
  await touch(page, Array.from({ length: 8 }, (_, i) => [[cx - 40 + i * 10, cy], [cx + 40 + i * 10, cy]]));
  const box1 = await page.locator("#stage").boundingBox();
  assert.ok(Math.abs(box1.x - box0.x - 70) < 5, `moved ${box1.x - box0.x}px`);
  assert.ok(Math.abs(box1.width - box0.width) < 2, "no zoom without spreading the fingers");
});

// one DevTools session per page, so a pen press and its release pair up
const sessions = new WeakMap();
async function cdpFor(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}
async function penEvent(page, type, [fx, fy], buttons) {
  const cdp = await cdpFor(page);
  const [x, y] = await at(page, fx, fy);
  const button = type === "mouseMoved" && !buttons ? "none" : "left"; // hover has no button; press/release do
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, buttons, pointerType: "pen", clickCount: 1 });
}

test("a pen hovering over a stroke with the eraser does not erase", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.2, 0.5], [0.8, 0.5], 30);
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  for (let fy = 0.44; fy <= 0.56; fy += 0.005) await penEvent(page, "mouseMoved", [0.5, fy], 0);
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 1);
});

test("a palm resting while the pen draws does not erase after the pen lifts", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.2, 0.5], [0.8, 0.5], 30);
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  const cdp = await cdpFor(page);
  await penEvent(page, "mousePressed", [0.9, 0.1], 1);
  const palm = async (type, fy) => { const [x, y] = await at(page, 0.5, fy);
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 0 }] }); };
  await palm("touchStart", 0.4);
  await penEvent(page, "mouseReleased", [0.9, 0.1], 0);
  for (let fy = 0.44; fy <= 0.56; fy += 0.005) await palm("touchMove", fy);
  await palm("touchEnd");
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 1);
});

test("erasing near one end keeps the far end of the stroke exactly", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  await drag(page, [0.2, 0.5], [0.8, 0.5], 30);
  const original = worldPoints((await exportedDesign(page)).drawing.elements[0]);
  const farEnd = original.reduce((a, p) => (p[0] > a[0] ? p : a));
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  await page.getByRole("slider", { name: "Eraser size" }).fill("40");
  await drag(page, [0.2, 0.45], [0.2, 0.55], 10);

  const [piece] = (await exportedDesign(page)).drawing.elements;
  const end = worldPoints(piece).reduce((a, p) => (p[0] > a[0] ? p : a));
  assert.ok(Math.hypot(end[0] - farEnd[0], end[1] - farEnd[1]) < 0.5, `far end moved from ${farEnd} to ${end}`);
});

test("letter view shows the smoothed letters when smoothing is on", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Letter", exact: true }).click();
  // zigzag across the middle: 12 mm up and down every 8 mm (canvas is 297 x 420 mm)
  const pts = Array.from({ length: 21 }, (_, i) => [(68 + i * 8) / 297, (210 + (i % 2 ? 12 : -12)) / 420]);
  await page.mouse.move(...(await at(page, ...pts[0])));
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...(await at(page, ...p)), { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Letter view" }).click();
  const peak = [(68 + 10 * 8) / 297, (210 - 12) / 420];
  assert.deepStrictEqual(await pixelAt(page, ...peak), [29, 39, 51, 255], "raw zigzag peak is inked");

  await page.locator("summary", { hasText: "Letters" }).click();
  await page.getByRole("slider", { name: "Smooth letters" }).fill("1");
  assert.deepStrictEqual(await pixelAt(page, ...peak), [250, 248, 242, 255], "smoothed letter no longer reaches the peak");
});

test("on a phone the canvas and the tools both fit on screen, and a finger draws a letter", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(TOOL_URL);
  await page.getByRole("status").filter({ hasText: /ms/ }).waitFor();

  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scrolling");
  const stage = await page.locator("#stage").boundingBox();
  assert.ok(stage.y >= 0 && stage.y + stage.height <= 844 && stage.height > 250, `canvas on screen: ${JSON.stringify(stage)}`);
  const letter = await page.getByRole("button", { name: "Letter", exact: true }).boundingBox();
  assert.ok(letter.y + letter.height <= 844 && letter.height >= 40, `Letter tool reachable and finger-sized: ${JSON.stringify(letter)}`);

  await page.getByRole("button", { name: "Letter", exact: true }).tap();
  await touch(page, [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6].map((f) => [[stage.x + 0.4 * stage.width, stage.y + f * stage.height]]));
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 1, "finger stroke");
  assert.deepStrictEqual(errors, []);
});

test("the size is the first step and a new design starts as A3 portrait", async () => {
  const page = await openTool();
  assert.match(await page.locator(".step h2").first().innerText(), /size/i);
  const size = page.getByLabel("Size", { exact: true });
  assert.strictEqual(await size.evaluate((s) => s.selectedOptions[0].text), "A3 portrait 29.7 × 42");
  assert.deepStrictEqual(JSON.parse(JSON.stringify((await exportedDesign(page)).drawing.canvas)), { widthCm: 29.7, heightCm: 42 });

  await size.selectOption({ label: "A2 portrait 42 × 59.4" });
  assert.strictEqual(await size.evaluate((s) => s.selectedOptions[0].text), "A2 portrait 42 × 59.4", "the chosen size stays shown");
  assert.deepStrictEqual(JSON.parse(JSON.stringify((await exportedDesign(page)).drawing.canvas)), { widthCm: 42, heightCm: 59.4 });
  assert.deepStrictEqual(page.errors, []);
});
