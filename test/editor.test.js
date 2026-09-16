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
  assert.strictEqual(d.elements.length, 1);
  assert.strictEqual(d.elements[0].type, "stroke");
  const ys = worldPoints(d.elements[0]).map((p) => p[1] / (d.canvas.heightCm * 10));
  assert.ok(Math.abs(Math.min(...ys) - 0.3) < 0.02 && Math.abs(Math.max(...ys) - 0.6) < 0.02, `stroke spans ${Math.min(...ys)}..${Math.max(...ys)}`);
  assert.deepStrictEqual(page.errors, []);
});

test("a placed boat can be moved, and undo puts it back", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Boat", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await drag(page, [0.5, 0.5], [0.7, 0.5]);

  const W = (d) => d.canvas.widthCm * 10;
  let d = await exportedDesign(page);
  assert.strictEqual(d.elements[0].type, "boat");
  assert.ok(Math.abs(d.elements[0].transform.x / W(d) - 0.7) < 0.02, `moved boat at ${d.elements[0].transform.x / W(d)}`);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  d = await exportedDesign(page);
  assert.ok(Math.abs(d.elements[0].transform.x / W(d) - 0.5) < 0.02, `undone boat at ${d.elements[0].transform.x / W(d)}`);
  assert.deepStrictEqual(page.errors, []);
});

test("an exported SVG reopens with the same design", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Dot", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.4, 0.4)));
  await page.getByLabel("Seed").fill("42");
  await page.getByLabel("Seed").press("Enter");
  const svg = await download(page, "Export SVG");

  const fresh = await openTool();
  await fresh.locator("#open-file").setInputFiles({ name: "saved.svg", mimeType: "image/svg+xml", buffer: svg });
  await fresh.getByRole("status").filter({ hasText: /opened/i }).waitFor();
  const reopened = await exportedDesign(fresh);
  assert.deepStrictEqual(reopened, core.loadDesignFromSVG(svg.toString("utf8")));
  assert.strictEqual(reopened.sea.seed, 42);
  assert.strictEqual(reopened.elements[0].type, "dot");
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

  assert.strictEqual((await exportedDesign(page)).elements.length, 0);
});

test("a selection colour picker keeps working across repeated changes", async () => {
  const page = await openTool();
  await page.getByRole("button", { name: "Boat", exact: true }).click();
  await page.mouse.click(...(await at(page, 0.5, 0.5)));
  const sail = await page.getByLabel("Sail").elementHandle(); // the same input a user keeps dragging in
  await sail.fill("#ff0000");
  await sail.fill("#00ff00");

  assert.strictEqual((await exportedDesign(page)).elements[0].sailColor, "#00ff00");
});
