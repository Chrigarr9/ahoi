const test = require("node:test");
const assert = require("node:assert");
const loadCore = require("./load-core");

const core = loadCore();

function sampleDesign() {
  const d = core.defaultDesign();
  d.drawing.canvas = { widthCm: 20, heightCm: 25 };
  d.style.sea.spacingMm = 8;
  d.style.palette.letter = "#ff0000";
  d.drawing.elements = [
    { id: "s1", type: "stroke", transform: { x: 10, y: 5, s: 1.5, r: 0.2 }, points: [[0, 0], [30, 40], [60, 20]] },
    { id: "b1", type: "boat", transform: { x: 120, y: 90, s: 0.8, r: -0.1 } },
    // name with markup characters must survive embedding
    { id: "sv", type: "svg", name: 'logo <"club"> & co', transform: { x: 50, y: 200, s: 1, r: 0 }, color: "#123456",
      parts: [[[[0, 0], [10, 0], [10, 10]], [[2, 2], [4, 2], [4, 4]]]] },
  ];
  return d;
}

test("exported SVG has physical size and one path per ribbon and fill", () => {
  const d = sampleDesign();
  d.style.palette.transparent = null;
  const geo = core.generate(d);
  const svg = core.exportSVG(d, geo);

  assert.match(svg, /<svg[^>]* width="20cm" height="25cm" viewBox="0 0 200 250"/);
  assert.strictEqual((svg.match(/<path /g) || []).length, geo.ribbons.length + geo.fills.length);
  assert.match(svg, /<rect width="200" height="250" fill="#86C4E3"\/>/, "background colour");
});

test("reopening an exported SVG restores the exact design", () => {
  const d = sampleDesign();
  const svg = core.exportSVG(d, core.generate(d));
  // JSON round-trip on both sides: the core runs in its own VM realm with its own Object prototype
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(core.loadDesignFromSVG(svg)), plain(d));
});

test("an SVG without an embedded design is rejected with a clear message", () => {
  assert.throws(() => core.loadDesignFromSVG('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), /no wave design/i);
});

test("a version 1 design file opens as drawing + style", () => {
  const v1 = {
    version: 1,
    canvas: { widthCm: 30, heightCm: 40 },
    sea: { tilt: 5, turbulence: 0.5, scale: 200, seed: 7, spacingMm: 10, width: 0.6, length: 90, taper: 0.5 },
    palette: { background: "#101010", strokes: [{ color: "#ffffff", weight: 1 }], letter: "#ff0000" },
    emphasis: 0.2,
    bend: 0.7,
    elements: [
      { id: "a", type: "stroke", transform: { x: 1, y: 2, s: 1, r: 0 }, points: [[0, 0], [5, 5]] },
      { id: "b", type: "svg", transform: { x: 1, y: 2, s: 1, r: 0 }, color: "#123456", rings: [[[0, 0], [1, 0], [1, 1]]] },
    ],
  };
  const svg = `<svg><metadata id="wave-design">${JSON.stringify(v1).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</metadata></svg>`;
  const d = JSON.parse(JSON.stringify(core.loadDesignFromSVG(svg)));

  assert.strictEqual(d.version, 2);
  assert.deepStrictEqual(d.drawing.canvas, { widthCm: 30, heightCm: 40 });
  assert.strictEqual(d.drawing.elements[0].type, "stroke");
  assert.deepStrictEqual(d.drawing.elements[1].parts, [[[[0, 0], [1, 0], [1, 1]]]], "old single-ring SVGs become one part");
  assert.strictEqual(d.style.sea.seed, 7);
  assert.strictEqual(d.style.palette.letter, "#ff0000");
  assert.deepStrictEqual(d.style.letters, { emphasis: 0.2, bend: 0.7, smooth: 0 });
  assert.ok(d.style.variety && d.style.edges, "new style groups get defaults");
});

test("transparent background exports without a background, cut-out strokes as a mask", () => {
  const d = sampleDesign();
  d.style.palette.transparent = "background";
  let geo = core.generate(d);
  let svg = core.exportSVG(d, geo);
  assert.doesNotMatch(svg, /<rect width="200" height="250" fill=/);

  d.style.palette.transparent = 1;
  geo = core.generate(d);
  svg = core.exportSVG(d, geo);
  const cut = geo.ribbons.filter((r) => r.cutout).length;
  assert.ok(cut > 0);
  const mask = /<mask [^>]*>([\s\S]*?)<\/mask>/.exec(svg);
  assert.ok(mask, "mask present");
  assert.strictEqual((mask[1].match(/<path [^>]*fill="#000"/g) || []).length, cut, "each cut-out is a black mask path");
  assert.match(svg, /<g mask="url\(#cutouts\)">/);
  assert.strictEqual((svg.match(/<path /g) || []).length, geo.ribbons.length + geo.fills.length);
});

test("a style file round-trips with its name and fills in settings added later", () => {
  const style = core.defaultStyle();
  style.sea.seed = 99;
  style.palette.transparent = "background";
  const text = core.exportStyle(style, "Club blue");
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(core.parseStyle(text)), { name: "Club blue", style: plain(style) });

  const old = JSON.parse(text);
  delete old.style.variety;
  delete old.style.sea.fold;
  const upgraded = core.parseStyle(JSON.stringify(old));
  assert.strictEqual(upgraded.style.sea.fold, 0);
  assert.deepStrictEqual(plain(upgraded.style.variety), plain(core.defaultStyle().variety));

  assert.throws(() => core.parseStyle('{"hello": 1}'), /not a wave style/i);
  assert.throws(() => core.parseStyle("<svg/>"), /not a wave style/i);
});

test("exported SVG embeds each used figure picture once and places every figure", () => {
  const d = sampleDesign();
  d.style.variety.surfers = 1;
  const geo = core.generate(d);
  assert.ok(geo.figures.length > 0);
  const svg = core.exportSVG(d, geo);
  const used = new Set(geo.figures.map((s) => s.figure));
  assert.strictEqual((svg.match(/<image /g) || []).length, used.size);
  assert.match(svg, /<image [^>]*href="data:image\/(png|webp);base64,/);
  assert.strictEqual((svg.match(/<use /g) || []).length, geo.figures.length);
  assert.strictEqual((svg.match(/<path /g) || []).length, geo.ribbons.length + geo.fills.length);
});

test("a design saved before the jersey existed opens with the default back print", () => {
  const d = sampleDesign();
  delete d.drawing.jersey;
  const svg = core.exportSVG(d, core.generate(d));
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(core.loadDesignFromSVG(svg).drawing.jersey), { size: "M", color: "#86C4E3", printX: 0, printY: 8 });
});

test("jersey size, colour and print position survive export and reopen", () => {
  const d = sampleDesign();
  d.drawing.jersey = { size: "XL", color: "#d8433a", printX: -3.5, printY: 12.25 };
  const svg = core.exportSVG(d, core.generate(d));
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(core.loadDesignFromSVG(svg).drawing.jersey), { size: "XL", color: "#d8433a", printX: -3.5, printY: 12.25 });
});

test("brush, size, mode, colour, nib and pen pressure of painted strokes survive export and reopen", () => {
  const d = sampleDesign();
  d.drawing.elements.push(
    { id: "c", type: "stroke", transform: { x: 60, y: 60, s: 1, r: 0 }, points: [[0, 0], [20, 10], [40, 0]], brush: "calligraphy", size: 12, mode: "visible",
      color: { palette: 1 }, nib: 60, pressure: [0.2, 0.9, 0.5] },
    { id: "t", type: "stroke", transform: { x: 150, y: 40, s: 1, r: 0 }, points: [[0, 0]], brush: "round", size: 8, mode: "visible", color: "#aa3300" });
  const svg = core.exportSVG(d, core.generate(d));
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(core.loadDesignFromSVG(svg)).drawing.elements, plain(d.drawing.elements));
});

test("a design saved before edge fade opens with the fade off, and fade settings survive export and reopen", () => {
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const old = sampleDesign();
  old.style.edges = { enabled: true, inset: 25, amplitude: 12, top: true, right: true, bottom: true, left: true };
  const reopened = core.loadDesignFromSVG(core.exportSVG(old, core.generate(old))).style.edges;
  assert.deepStrictEqual(plain(reopened), { ...plain(old.style.edges), fadeWidth: 30, fadeShorter: 0, fadeThinner: 0, fadeSparser: 0 });

  const d = sampleDesign();
  Object.assign(d.style.edges, { enabled: true, fadeWidth: 45, fadeShorter: 0.4, fadeThinner: 0.7, fadeSparser: 0.25 });
  assert.deepStrictEqual(plain(core.loadDesignFromSVG(core.exportSVG(d, core.generate(d))).style.edges), plain(d.style.edges));
});

test("typed text with its font, layout and brush survives export and reopen", () => {
  const d = sampleDesign();
  d.drawing.elements.push({ id: "tx", type: "text", transform: { x: 100, y: 120, s: 1.2, r: 0.1 }, text: "Ahoi\nCrew <&>", font: "Allure", heightCm: 3.5,
    lineSpacing: 1.8, letterSpacing: 0.1, slant: -8, align: "right", brush: "calligraphy", size: 6, mode: "visible", color: { palette: 2 }, nib: 30 });
  const svg = core.exportSVG(d, core.generate(d));
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepStrictEqual(plain(core.loadDesignFromSVG(svg)).drawing.elements, plain(d.drawing.elements));
  assert.ok((svg.match(/<path /g) || []).length > 20, "the letters are painted into the print");
});
