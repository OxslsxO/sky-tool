const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("server loads .env from project root even when started outside the root directory", () => {
  const serverPath = path.join(__dirname, "server.js");
  const source = fs.readFileSync(serverPath, "utf8");

  assert.match(
    source,
    /dotenv"\)\.config\(\{\s*path:\s*require\("path"\)\.join\(__dirname,\s*"\.\.",\s*"\.env"\)\s*\}\)/,
  );
});

test("server warms the photo-id model during startup", () => {
  const serverPath = path.join(__dirname, "server.js");
  const source = fs.readFileSync(serverPath, "utf8");

  assert.match(source, /warmPhotoIdModel\(config\)/);
});

test("photo-id route returns visible processing diagnostics", () => {
  const serverPath = path.join(__dirname, "server.js");
  const source = fs.readFileSync(serverPath, "utf8");

  assert.match(source, /diagnostics:\s*\{/);
  assert.match(source, /processingMs/);
});
