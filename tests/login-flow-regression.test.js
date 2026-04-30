const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("login page no longer requires bind-phone flow", () => {
  const js = read("pages/login/index.js");
  const wxml = read("pages/login/index.wxml");

  assert.doesNotMatch(js, /bind-phone|onGetPhoneNumber|\/api\/auth\/bind-phone/);
  assert.doesNotMatch(wxml, /phone|bind-phone|getPhoneNumber/i);
  assert.match(js, /wx\.login/);
  assert.match(js, /goHome\(\)/);
});
