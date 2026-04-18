const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("photo-id model download streams to disk instead of buffering the full model in memory", () => {
  const source = fs.readFileSync(path.join(__dirname, "lib", "photo-id.js"), "utf8");

  assert.doesNotMatch(source, /arrayBuffer\(\)/);
  assert.match(source, /pipeline\(/);
  assert.match(source, /createWriteStream/);
});
