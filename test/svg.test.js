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
  const geo = core.generate(d, "full");
  const svg = core.exportSVG(d, geo);

  assert.match(svg, /<svg[^>]* width="20cm" height="25cm" viewBox="0 0 200 250"/);
  assert.strictEqual((svg.match(/<path /g) || []).length, geo.ribbons.length + geo.fills.length);
  assert.match(svg, /fill="#587ca0"/, "background colour");
});

test("reopening an exported SVG restores the exact design", () => {
  const d = sampleDesign();
  const svg = core.exportSVG(d, core.generate(d, "preview"));
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
  let geo = core.generate(d, "preview");
  let svg = core.exportSVG(d, geo);
  assert.doesNotMatch(svg, /<rect width="200" height="250" fill=/);

  d.style.palette.transparent = 1;
  geo = core.generate(d, "preview");
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
