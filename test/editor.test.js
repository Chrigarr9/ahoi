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

test("painting with the brush adds a stroke to the exported design", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  await page.getByRole("button", { name: "Letter boat", exact: true }).click();
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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
  assert.strictEqual(reopened.drawing.elements[0].type, "stroke");
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByRole("button", { name: "Delete", exact: true }).click({ timeout: 2000 });

  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 0);
});

test("a selection colour picker keeps working across repeated changes", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  await page.getByRole("button", { name: "Letter boat", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  const sail = await page.getByLabel("Sail").elementHandle(); // the same input a user keeps dragging in
  await sail.fill("#ff0000");
  await sail.fill("#00ff00");

  assert.strictEqual((await exportedDesign(page)).drawing.elements[0].sailColor, "#00ff00");
});

test("reset starts a fresh default design, and undo brings the old one back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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
  await other.getByRole("button", { name: "Brush", exact: true }).click();
  await other.mouse.click(...(await at(other, 0.5, 0.5)));
  await other.locator("#import-style").setInputFiles({ name: "look.json", mimeType: "application/json", buffer: styleJson });
  await other.getByRole("status").filter({ hasText: /applied style/i }).waitFor();
  const applied = await exportedDesign(other);
  assert.deepStrictEqual(applied.style, styled.style);
  assert.strictEqual(applied.drawing.elements[0].type, "stroke");
});

test("a selected shape can be switched to woven", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  await page.getByRole("button", { name: "Letter boat", exact: true }).click();
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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

test("paint view shows the painted strokes on plain paper without the sea", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await drag(page, [0.5, 0.2], [0.5, 0.8], 20);
  await page.getByRole("button", { name: "Paint view", exact: true }).click();
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await drag(page, [0.2, 0.5], [0.8, 0.5], 30);
  await page.getByRole("button", { name: "Eraser", exact: true }).click();
  for (let fy = 0.44; fy <= 0.56; fy += 0.005) await penEvent(page, "mouseMoved", [0.5, fy], 0);
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 1);
});

test("a palm resting while the pen draws does not erase after the pen lifts", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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
  await page.getByRole("button", { name: "Brush", exact: true }).click();
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

test("paint view shows the smoothed strokes when smoothing is on", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  // zigzag across the middle: 12 mm up and down every 8 mm (canvas is 297 x 420 mm)
  const pts = Array.from({ length: 21 }, (_, i) => [(68 + i * 8) / 297, (210 + (i % 2 ? 12 : -12)) / 420]);
  await page.mouse.move(...(await at(page, ...pts[0])));
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...(await at(page, ...p)), { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Paint view", exact: true }).click();
  // 2 mm inside a zigzag tip: the painted outline (like the print) rounds off the very tip
  const peak = [(68 + 10 * 8) / 297, (210 - 10) / 420];
  assert.deepStrictEqual(await pixelAt(page, ...peak), [29, 39, 51, 255], "raw zigzag peak is inked");

  await page.locator("summary", { hasText: "Hidden paint" }).click();
  await page.getByRole("slider", { name: "Smooth paint" }).fill("1");
  assert.deepStrictEqual(await pixelAt(page, ...peak), [250, 248, 242, 255], "smoothed letter no longer reaches the peak");
});

test("on a phone the canvas and the tools both fit on screen, and a finger paints a stroke", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(TOOL_URL);
  await page.getByRole("status").filter({ hasText: /ms/ }).waitFor();

  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scrolling");
  const stage = await page.locator("#stage").boundingBox();
  assert.ok(stage.y >= 0 && stage.y + stage.height <= 844 && stage.height > 250, `canvas on screen: ${JSON.stringify(stage)}`);
  const letter = await page.getByRole("button", { name: "Brush", exact: true }).boundingBox();
  assert.ok(letter.y + letter.height <= 844 && letter.height >= 40, `Brush tool reachable and finger-sized: ${JSON.stringify(letter)}`);

  await page.getByRole("button", { name: "Brush", exact: true }).tap();
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

test("surfer pictures show up on the canvas where the exported SVG places them", async () => {
  const page = await openTool();
  await page.locator("summary", { hasText: "Variety" }).click();
  await page.getByRole("slider", { name: "Surfer size" }).fill("6");
  const before = await page.locator("#status").innerText();
  await page.getByRole("slider", { name: "Surfers", exact: true }).fill("1");
  await page.waitForFunction((t) => document.getElementById("status").textContent !== t, before); // preview rebuilt
  const svg = (await download(page, "Export SVG")).toString("utf8");
  const [, W, H] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg).map(Number);
  const placed = [...svg.matchAll(/<use [^>]*?translate\(([\d.-]+) ([\d.-]+)\)/g)].map((m) => [m[1] / W, m[2] / H]);
  assert.ok(placed.length > 0, "no surfers in the export");

  // the palette is blue and cream; only the pictures (skin, boards, swimwear) are clearly warm
  const warmPixels = (fx, fy) => page.evaluate(([fx, fy]) => {
    const c = document.getElementById("stage");
    const r = Math.round(c.width * 0.03), x0 = Math.floor(fx * c.width) - r, y0 = Math.floor(fy * c.height) - r;
    const d = c.getContext("2d").getImageData(x0, y0, 2 * r, 2 * r).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] - d[i + 2] > 40) n++;
    return n;
  }, [fx, fy]);
  let shown = 0;
  for (const [fx, fy] of placed) if ((await warmPixels(fx, fy)) > 10) shown++;
  assert.strictEqual(shown, placed.length, `${shown} of ${placed.length} surfers visible`);
  assert.deepStrictEqual(page.errors, []);
});

test("the stamp tool places a picture that follows the flow, and it can become an obstacle keeping its angle", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  await page.getByRole("button", { name: "Boat 1", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.7, 0.3)));
  await page.mouse.click(...(await at(page, 0.3, 0.75)));

  let d = await exportedDesign(page);
  const stamps = d.drawing.elements.filter((e) => e.type === "stamp");
  assert.strictEqual(stamps.length, 2, "stamping twice places two pictures");
  assert.strictEqual(stamps[0].figure, core.figure(stamps[0].figure).id);
  assert.strictEqual(core.figure(stamps[0].figure).kind, "boat");
  assert.strictEqual(stamps[0].mode, "riding");
  assert.strictEqual(stamps[0].transform.r, null, "a new stamp follows the flow");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.7, 0.3)));
  await page.getByRole("button", { name: "Obstacle", exact: true }).click();
  d = await exportedDesign(page);
  const [first] = d.drawing.elements.filter((e) => e.type === "stamp");
  assert.strictEqual(first.mode, "obstacle");
  assert.strictEqual(typeof first.transform.r, "number", "switching to obstacle keeps the angle it had");
  assert.deepStrictEqual(page.errors, []);
});

test("figures can be recoloured into the palette so they blend into the sea", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  await page.getByRole("button", { name: "Surfer 1", exact: true }).click();
  const before = await page.locator("#status").innerText();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  await page.waitForFunction((t) => document.getElementById("status").textContent !== t, before);
  await page.getByRole("button", { name: "Brush", exact: true }).click(); // no orange selection frame in the way
  // the default palette is blue and cream; the painted surfer (skin, orange board) is clearly warm
  const warm = () => page.evaluate(() => {
    const c = document.getElementById("stage"), r = Math.round(c.width * 0.08);
    const d = c.getContext("2d").getImageData(Math.floor(c.width / 2) - r, Math.floor(c.height / 2) - r, 2 * r, 2 * r).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] - d[i + 2] > 40) n++;
    return n;
  });
  assert.ok((await warm()) > 50, "own colours: surfer not visible");

  await page.locator("summary", { hasText: "Colours" }).click();
  await page.getByLabel("Surfers & boats in palette colours").check();
  await page.waitForTimeout(600);
  assert.strictEqual(await warm(), 0, "palette colours: warm pixels left");
  const svg = (await download(page, "Export SVG")).toString("utf8");
  assert.strictEqual(core.loadDesignFromSVG(svg).style.palette.figureColours, "palette");
  const own = new RegExp(`<image id="figure-(\\w+)" data-kind="surfer"[^>]* href="([^"]+)"`).exec(svg);
  assert.ok(own && own[2] === core.figure(own[1]).href, "the original picture must travel in the SVG so other devices can switch back to own colours");
  assert.deepStrictEqual(page.errors, []);
});

// A generated-style sheet: two orange subjects on flat magenta, one lying and one standing upright
const magentaSheet = (page) => page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 600; c.height = 300;
  const x = c.getContext("2d");
  x.fillStyle = "#ff00ff"; x.fillRect(0, 0, 600, 300);
  x.fillStyle = "#e07030";
  x.beginPath(); x.ellipse(150, 150, 90, 28, 0, 0, 2 * Math.PI); x.fill();
  x.fillStyle = "#2a9d8f";
  x.beginPath(); x.ellipse(450, 150, 26, 100, 0, 0, 2 * Math.PI); x.fill();
  return c.toDataURL("image/png").split(",")[1];
});

async function importSheet(page, button) {
  const buffer = Buffer.from(await magentaSheet(page), "base64");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: button, exact: true }).click()]);
  await chooser.setFiles({ name: "sheet.png", mimeType: "image/png", buffer });
}

test("an imported magenta sheet becomes clean, lying stamps that survive a reload and travel inside the exported SVG", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  const surfers = await page.getByRole("button", { name: /^Surfer \d+$/ }).count();
  await importSheet(page, "Import surfers sheet…");
  await page.getByRole("button", { name: `Surfer ${surfers + 2}`, exact: true }).waitFor();

  for (const [n, fy] of [[1, 0.3], [2, 0.7]]) {
    await page.getByRole("button", { name: `Surfer ${surfers + n}`, exact: true }).click();
    await page.mouse.click(...(await at(page, 0.5, fy)));
  }
  const svg = (await download(page, "Export SVG")).toString("utf8");
  const stampFigures = core.loadDesignFromSVG(svg).drawing.elements.filter((e) => e.type === "stamp").map((e) => e.figure);
  assert.strictEqual(new Set(stampFigures).size, 2);
  const images = stampFigures.map((id) => new RegExp(`<image id="figure-${id}" data-kind="surfer"[^>]* width="(\\d+)" height="(\\d+)" href="([^"]+)"`).exec(svg));
  assert.ok(images.every(Boolean), "imported picture not embedded in the SVG");
  for (const image of images) assert.ok(+image[1] > 2 * +image[2], `subject not laid along its long axis: ${image[1]}x${image[2]}`);
  const stampFigure = stampFigures[0], image = images[0];
  const magenta = await page.evaluate(async (href) => {
    const img = new Image();
    img.src = href;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40 && d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90) n++;
    return n;
  }, image[3]);
  assert.strictEqual(magenta, 0, "magenta left in the cut-out");

  await page.reload();
  await page.getByRole("status").filter({ hasText: /ms/ }).waitFor();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  await page.getByRole("button", { name: `Surfer ${surfers + 2}`, exact: true }).waitFor({ timeout: 5000 });

  const other = await openTool(); // a fresh browser profile knows nothing about the import
  const [chooser] = await Promise.all([other.waitForEvent("filechooser"), other.getByRole("button", { name: "Open SVG…" }).click()]);
  await chooser.setFiles({ name: "design.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await other.getByRole("button", { name: "Stamp", exact: true }).click();
  await other.getByRole("button", { name: `Surfer ${surfers + 1}`, exact: true }).waitFor({ timeout: 5000 });
  assert.match((await download(other, "Export SVG")).toString("utf8"), new RegExp(`<image id="figure-${stampFigure}"`));
  assert.deepStrictEqual(page.errors, []);
  assert.deepStrictEqual(other.errors, []);
});

test("importing a lopsided figure keeps its far-reaching parts after laying it flat", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Stamp", exact: true }).click();
  const surfers = await page.getByRole("button", { name: /^Surfer \d+$/ }).count();
  // a heavy body with a long thin paddle reaching far out on one side: 40 + 260 px long
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 500; c.height = 200;
    const x = c.getContext("2d");
    x.fillStyle = "#ff00ff"; x.fillRect(0, 0, 500, 200);
    x.fillStyle = "#e07030"; x.beginPath(); x.ellipse(80, 100, 40, 40, 0, 0, 2 * Math.PI); x.fill();
    x.fillRect(80, 96, 260, 8);
    return c.toDataURL("image/png").split(",")[1];
  });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import surfers sheet…", exact: true }).click()]);
  await chooser.setFiles({ name: "sheet.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.getByRole("button", { name: `Surfer ${surfers + 1}`, exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  const svg = (await download(page, "Export SVG")).toString("utf8");
  const id = core.loadDesignFromSVG(svg).drawing.elements.find((e) => e.type === "stamp").figure;
  const [, w] = new RegExp(`<image id="figure-${id}"[^>]* width="(\\d+)"`).exec(svg);
  assert.ok(+w >= 290, `figure cut off: ${w} px long instead of about 298`);
});

// Share of fully transparent pixels in an exported PNG, decoded by the browser
const transparentShare = (page, png) => page.evaluate(async (b64) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] === 0) n++;
  return n / (d.length / 4);
}, png.toString("base64"));

// the jersey photo decodes asynchronously: wait until the shirt shows on the stage centre line
const shirtPainted = (page) => page.waitForFunction(() => {
  const c = document.getElementById("stage");
  return c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.95), 1, 1).data[3] > 0;
});

test("a new design previews on the jersey as a transparent back print in the shirt colour", async () => {
  const page = await openTool();
  const d = await exportedDesign(page);
  assert.strictEqual(d.style.palette.transparent, "background");
  assert.strictEqual(d.style.palette.background, "#86C4E3");
  await page.getByLabel("DPI").fill("40");
  assert.ok((await transparentShare(page, await download(page, "Export PNG"))) > 0.2, "the print has no background");

  await page.getByRole("button", { name: "Jersey", exact: true }).click();
  await shirtPainted(page);
  // near the hem on the centre line: far below the print (it starts 8 cm under the neck and is 42 cm tall)
  const [r, g, b, a] = await pixelAt(page, 0.5, 0.95);
  assert.ok(a === 255 && b > 200 && g > 160 && r > 100 && r < 180, `light-blue shirt, got ${[r, g, b, a]}`);
  assert.deepStrictEqual(page.errors, []);
});

test("dragging in the jersey view moves the print in cm, and Back print default puts it back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Jersey", exact: true }).click();
  await shirtPainted(page);
  // the photo keeps its proportions, scaled so the M jersey's 627.5 px from neck to hem are 72 cm: the stage is 453 px of that wide
  const box = await page.locator("#stage").boundingBox();
  const pxPerCm = box.width / ((453 / 627.5) * 72);
  const [x0, y0] = [box.x + box.width / 2, box.y + box.height * 0.4];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 5 * pxPerCm, y0 + 3 * pxPerCm, { steps: 10 });
  await page.mouse.up();

  let { jersey } = (await exportedDesign(page)).drawing;
  assert.ok(Math.abs(jersey.printX - 5) < 0.5 && Math.abs(jersey.printY - 11) < 0.5, `print at ${jersey.printX} / ${jersey.printY} cm`);
  await page.getByRole("button", { name: "Back print default", exact: true }).click();
  ({ jersey } = (await exportedDesign(page)).drawing);
  assert.deepStrictEqual([jersey.printX, jersey.printY], [0, 8]);
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 0, "the drag drew nothing");
  assert.deepStrictEqual(page.errors, []);
});

test("changing the shirt colour recolours the jersey and the transparent background", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Jersey", exact: true }).click();
  await shirtPainted(page);
  await page.getByLabel("Shirt colour").fill("#d8433a");
  const [r, g, b] = await pixelAt(page, 0.5, 0.95);
  assert.ok(r > 150 && r > g + 60 && r > b + 60, `reddish shirt, got ${[r, g, b]}`);
  assert.strictEqual((await exportedDesign(page)).style.palette.background, "#d8433a");
  assert.deepStrictEqual(page.errors, []);
});

test("a bigger jersey size makes the same print look smaller on the shirt", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Jersey", exact: true }).click();
  await shirtPainted(page);
  // the waves' extent across the middle of the back, as a share of the whole shirt shown on the stage
  const printShare = () => page.evaluate(() => {
    const c = document.getElementById("stage"), x = c.getContext("2d");
    const shirtRed = x.getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.95), 1, 1).data[0];
    let x0 = Infinity, x1 = -Infinity;
    for (let y = Math.floor(c.height * 0.25); y < c.height * 0.5; y += 5) {
      const row = x.getImageData(0, y, c.width, 1).data;
      for (let i = Math.floor(c.width * 0.2); i < c.width * 0.8; i++) {
        if (row[4 * i + 3] === 255 && Math.abs(row[4 * i] - shirtRed) > 50) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); }
      }
    }
    return (x1 - x0) / c.width;
  });
  await page.getByLabel("Jersey size").selectOption("S");
  const small = await printShare();
  await page.getByLabel("Jersey size").selectOption("XXL");
  const big = await printShare();
  assert.ok(small > 0.2 && big < small * 0.95, // lengths 70 -> 78 cm: expected share ratio 0.9
    `print share on S ${small}, on XXL ${big}`);
  assert.deepStrictEqual(page.errors, []);
});

for (const [device, width, height] of [["an iPad in portrait", 820, 1180], ["an iPad in landscape", 1180, 820], ["a phone in landscape", 844, 390]]) {
  test(`on ${device} nothing scrolls sideways, the canvas and view buttons are on screen, and a finger drags the print on the jersey`, async () => {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e));
    await page.goto(TOOL_URL);
    await page.getByRole("status").filter({ hasText: /ms/ }).waitFor();

    assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), width, "no sideways scrolling");
    const stage = await page.locator("#stage").boundingBox();
    assert.ok(stage.x >= 0 && stage.x + stage.width <= width && stage.y + stage.height <= height && stage.height > height * 0.5, `canvas on screen: ${JSON.stringify(stage)}`);
    const jerseyButton = await page.getByRole("button", { name: "Jersey", exact: true }).boundingBox();
    assert.ok(jerseyButton.x + jerseyButton.width <= width && jerseyButton.height >= 40, `Jersey button reachable and finger-sized: ${JSON.stringify(jerseyButton)}`);

    await page.getByRole("button", { name: "Jersey", exact: true }).tap();
    await shirtPainted(page);
    const box = await page.locator("#stage").boundingBox();
    await touch(page, Array.from({ length: 8 }, (_, i) => [[box.x + box.width / 2 + i * 4, box.y + box.height * 0.4]]));
    assert.ok((await exportedDesign(page)).drawing.jersey.printX > 1, "one finger moved the print");
    assert.deepStrictEqual(errors, []);
  });
}

test("the canvas shows exactly the waves that get exported, so there is no separate full render", async () => {
  const page = await openTool();
  const shown = Number(/(\d+) strokes/.exec(await page.locator("#status").innerText())[1]);
  const svg = (await download(page, "Export SVG")).toString("utf8");
  assert.strictEqual((svg.match(/<path /g) || []).length, shown, "the default design has no fills: one path per stroke on the canvas");
  assert.strictEqual(await page.getByRole("button", { name: "Render full" }).count(), 0);
  assert.deepStrictEqual(page.errors, []);
});

test("brush settings picked before painting land on the stroke, and a tap paints a dot", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByRole("button", { name: "Round", exact: true }).click();
  await page.getByLabel("Brush size").selectOption({ label: "12 mm" });
  await page.getByRole("button", { name: "Visible", exact: true }).click();
  await page.getByLabel("Custom paint colour").fill("#ff00aa");
  await drag(page, [0.3, 0.3], [0.3, 0.6]);
  await page.mouse.click(...(await at(page, 0.7, 0.5)));

  const [stroke, dot] = (await exportedDesign(page)).drawing.elements;
  const settings = (el) => ({ type: el.type, brush: el.brush, size: el.size, mode: el.mode, color: el.color });
  const expected = { type: "stroke", brush: "round", size: 12, mode: "visible", color: "#ff00aa" };
  assert.deepStrictEqual(settings(stroke), expected);
  assert.ok(stroke.points.length > 2);
  assert.deepStrictEqual(settings(dot), expected);
  assert.strictEqual(dot.points.length, 1, "a tap is a one-point stroke");
  assert.ok(Math.abs(dot.transform.x / 297 - 0.7) < 0.02 && Math.abs(dot.transform.y / 420 - 0.5) < 0.02, `dot at ${dot.transform.x}, ${dot.transform.y}`);
  assert.strictEqual(await page.getByRole("button", { name: "Dot", exact: true }).count(), 0, "no separate Dot tool");
  assert.deepStrictEqual(page.errors, []);
});

test("a selected stroke's brush, size, mode and colour can be changed after painting", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await drag(page, [0.5, 0.3], [0.5, 0.6]);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.45)));

  const panel = page.locator("#selection-panel");
  await panel.getByRole("button", { name: "Calligraphy", exact: true }).click();
  await panel.getByLabel("Brush size").selectOption({ label: "20 mm" });
  await panel.getByRole("button", { name: "Visible", exact: true }).click();
  await panel.getByRole("button", { name: "Paint colour: stroke colour 2", exact: true }).click();
  await panel.getByRole("slider", { name: "Nib angle" }).fill("90");

  const [stroke] = (await exportedDesign(page)).drawing.elements;
  assert.deepStrictEqual(JSON.parse(JSON.stringify({ brush: stroke.brush, size: stroke.size, mode: stroke.mode, color: stroke.color, nib: stroke.nib })),
    { brush: "calligraphy", size: 20, mode: "visible", color: { palette: 1 }, nib: 90 });
  assert.deepStrictEqual(page.errors, []);
});

test("paint view shows a visible stroke in its colour at its brush width", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByRole("button", { name: "Round", exact: true }).click();
  await page.getByLabel("Brush size").selectOption({ label: "20 mm" });
  await page.getByRole("button", { name: "Visible", exact: true }).click();
  await page.getByLabel("Custom paint colour").fill("#ff0000");
  await drag(page, [0.5, 0.2], [0.5, 0.8], 20);
  await page.getByRole("button", { name: "Paint view", exact: true }).click();

  // the canvas is 297 mm wide: 20 mm of red centred on x = 0.5
  const mm = (dx) => 0.5 + dx / 297;
  assert.deepStrictEqual(await pixelAt(page, 0.5, 0.5), [255, 0, 0, 255], "painted centre");
  assert.deepStrictEqual(await pixelAt(page, mm(8), 0.5), [255, 0, 0, 255], "8 mm out: still paint");
  assert.deepStrictEqual(await pixelAt(page, mm(12), 0.5), [250, 248, 242, 255], "12 mm out: paper");
  assert.deepStrictEqual(page.errors, []);
});

test("removing a palette colour keeps the colour of visible paint that used it or a later one", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByRole("button", { name: "Visible", exact: true }).click();
  await page.getByRole("button", { name: "Paint colour: stroke colour 2", exact: true }).click();
  await drag(page, [0.3, 0.3], [0.3, 0.6]);
  await page.getByRole("button", { name: "Paint colour: stroke colour 3", exact: true }).click();
  await drag(page, [0.6, 0.3], [0.6, 0.6]);
  const before = (await exportedDesign(page)).style.palette.strokes.map((s) => s.color);

  await page.locator("summary", { hasText: "Colours" }).click();
  await page.getByRole("button", { name: "Remove colour 2", exact: true }).click();
  const d = await exportedDesign(page);
  const [removed, shifted] = d.drawing.elements;
  assert.strictEqual(removed.color, before[1], "the removed colour stays on its paint as a fixed colour");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(shifted.color)), { palette: 1 }, "a later colour keeps following its palette slot");
  assert.strictEqual(d.style.palette.strokes[1].color, before[2]);
});

test("the edge fade sliders set how strokes fade out towards the border", async () => {
  const page = await openTool();
  await page.getByText("Edges", { exact: true }).click();
  await page.getByLabel("Wavy border").check();
  for (const [name, value] of [["Fade width", "50"], ["Fade: shorter", "0.6"], ["Fade: thinner", "0.3"], ["Fade: fewer", "0.8"]]) {
    await page.getByRole("slider", { name, exact: true }).fill(value);
  }
  const { edges } = (await exportedDesign(page)).style;
  assert.deepStrictEqual([edges.enabled, edges.fadeWidth, edges.fadeShorter, edges.fadeThinner, edges.fadeSparser], [true, 50, 0.6, 0.3, 0.8]);
  assert.deepStrictEqual(page.errors, []);
});

test("Add text drops text in the middle; typing, font, layout and brush change it; undo steps back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.getByLabel("Text", { exact: true }).fill("Ahoi\nCrew");
  await page.getByLabel("Font", { exact: true }).selectOption("Allure");
  await page.getByRole("button", { name: "Align right", exact: true }).click();
  await page.getByLabel("Letter height (cm)", { exact: true }).fill("6.5");
  await page.getByLabel("Letter height (cm)", { exact: true }).press("Enter");
  await page.getByRole("slider", { name: "Line spacing", exact: true }).fill("2");
  await page.getByRole("slider", { name: "Letter spacing", exact: true }).fill("0.2");
  await page.getByRole("button", { name: "Visible", exact: true }).click();
  await page.getByRole("slider", { name: "Slant", exact: true }).fill("-10");

  const [text] = (await exportedDesign(page)).drawing.elements;
  const { type, transform: { x, y }, font, align, heightCm, lineSpacing, letterSpacing, slant, mode } = text;
  assert.deepStrictEqual({ type, x, y, text: text.text, font, align, heightCm, lineSpacing, letterSpacing, slant, mode },
    { type: "text", x: 148.5, y: 210, text: "Ahoi\nCrew", font: "Allure", align: "right", heightCm: 6.5, lineSpacing: 2, letterSpacing: 0.2, slant: -10, mode: "visible" });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.strictEqual((await exportedDesign(page)).drawing.elements[0].slant, 0);
  assert.deepStrictEqual(page.errors, []);
});

test("text emptied of letters can still be selected and deleted", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  await page.getByLabel("Text", { exact: true }).fill("   ");
  await page.getByRole("button", { name: "Undo", exact: true }).focus(); // leave the text box
  await page.mouse.click(...(await at(page, 0.05, 0.05))); // select nothing
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  assert.strictEqual((await exportedDesign(page)).drawing.elements.length, 0);
  assert.deepStrictEqual(page.errors, []);
});
