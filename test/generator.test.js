const test = require("node:test");
const assert = require("node:assert");
const loadCore = require("./load-core");

const core = loadCore();

// Small canvas keeps generation fast: 20 x 25 cm, 8 mm spacing.
function design(overrides = {}) {
  const d = core.defaultDesign();
  d.canvas = { widthCm: 20, heightCm: 25 };
  d.sea.spacingMm = 8;
  return Object.assign(d, overrides);
}

function minDistanceBetween(linesA, linesB) {
  let best = Infinity;
  for (const a of linesA) for (const b of linesB) {
    if (a === b) continue;
    for (const [ax, ay] of a) for (const [bx, by] of b) best = Math.min(best, Math.hypot(ax - bx, ay - by));
  }
  return best;
}

const identity = { x: 0, y: 0, s: 1, r: 0 };
const verticalStroke = () => ({
  id: "s1", type: "stroke", transform: { ...identity },
  points: Array.from({ length: 41 }, (_, i) => [100, 40 + i * 4]),
});

test("sea streamlines stay at least half a spacing apart and clear of drawn strokes", () => {
  const d = design();
  d.elements = [verticalStroke()];
  const out = core.generate(d, "full");
  const spacing = d.sea.spacingMm;

  assert.ok(minDistanceBetween(out.streamlines, out.streamlines) >= spacing / 2);
  assert.ok(minDistanceBetween(out.streamlines, [d.elements[0].points]) >= spacing / 2);
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "letter").length, 1);
});

test("same design generates identical geometry; another seed does not", () => {
  const a = core.generate(design(), "full");
  const b = core.generate(design(), "full");
  assert.ok(a.ribbons.length > 20, `expected a filled sea, got ${a.ribbons.length} ribbons`);
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));

  const other = design();
  other.sea.seed += 1;
  assert.notStrictEqual(JSON.stringify(core.generate(other, "full")), JSON.stringify(a));
});

// Share of streamline steps within `radius` mm of x=100 that run more vertical than horizontal.
function verticalShareNear(lines, radius) {
  let vertical = 0, total = 0;
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const [x, y] = line[i], [px, py] = line[i - 1];
    if (Math.abs(x - 100) > radius || y < 60 || y > 180) continue;
    total++;
    if (Math.abs(y - py) > Math.abs(x - px)) vertical++;
  }
  return vertical / total;
}

test("the flow bends along a drawn stroke, more strongly with higher bend", () => {
  const d = design();
  d.sea.turbulence = 0; // flat horizontal sea, so any vertical flow comes from the stroke
  d.elements = [verticalStroke()];

  d.bend = 1;
  const strong = core.generate(d, "full");
  assert.ok(verticalShareNear(strong.streamlines, 25) > 0.6, "sea next to the stroke should follow it");

  d.bend = 0;
  const weak = core.generate(d, "full");
  assert.ok(verticalShareNear(weak.streamlines, 25) < verticalShareNear(strong.streamlines, 25));
});
