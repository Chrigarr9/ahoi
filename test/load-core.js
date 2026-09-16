// Runs the <script id="core"> block of index.html in a fresh VM context.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

module.exports = function loadCore() {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const m = /<script id="core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('index.html has no <script id="core"> block');
  const ctx = vm.createContext({});
  const sprites = /<script id="figure-library">([\s\S]*?)<\/script>/.exec(html);
  if (sprites) vm.runInContext(sprites[1], ctx);
  vm.runInContext(m[1], ctx);
  return ctx.WaveCore;
};
