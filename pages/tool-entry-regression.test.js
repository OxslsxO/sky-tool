const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("user entry pages no longer navigate into workbench", () => {
  const userEntryFiles = [
    "pages/tool-detail/index.js",
    "pages/task-detail/index.js",
  ];

  for (const file of userEntryFiles) {
    const content = read(file);
    assert.doesNotMatch(
      content,
      /\/pages\/workbench\/index/,
      `${file} still routes users into workbench`
    );
  }
});

test("tool detail no longer asks users to enter a workbench before operating", () => {
  const js = read("pages/tool-detail/index.js");
  const wxml = read("pages/tool-detail/index.wxml");

  assert.doesNotMatch(js, /进入真实工作台|进入云处理工作台|launchCopy/);
  assert.doesNotMatch(wxml, /进入真实工作台|进入云处理工作台|进入工作台/);
});
