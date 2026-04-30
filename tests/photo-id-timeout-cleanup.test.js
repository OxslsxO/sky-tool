const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("photo-id model timeouts are cleared so node --test can exit cleanly", () => {
  const source = read("backend/lib/photo-id.js");

  assert.match(source, /const timeoutId = setTimeout\(\(\) => reject\(new Error\(`Model \$\{model\.key\} loading timeout`\)\), 60000\);/);
  assert.match(source, /clearTimeout\(timeoutId\)/);
  assert.match(source, /const runTimeoutId = setTimeout\(\(\) => reject\(new Error\("Model inference timeout"\)\), 120000\);/);
  assert.match(source, /clearTimeout\(runTimeoutId\)/);
});
