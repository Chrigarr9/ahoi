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

test("same design generates identical geometry; another seed does not", () => {
  const a = core.generate(design(), "full");
  const b = core.generate(design(), "full");
  assert.ok(a.ribbons.length > 20, `expected a filled sea, got ${a.ribbons.length} ribbons`);
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));

  const other = design();
  other.sea.seed += 1;
  assert.notStrictEqual(JSON.stringify(core.generate(other, "full")), JSON.stringify(a));
});
