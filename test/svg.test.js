const test = require("node:test");
const assert = require("node:assert");
const loadCore = require("./load-core");

const core = loadCore();

function sampleDesign() {
  const d = core.defaultDesign();
  d.canvas = { widthCm: 20, heightCm: 25 };
  d.sea.spacingMm = 8;
  d.palette.letter = "#ff0000";
  d.elements = [
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
