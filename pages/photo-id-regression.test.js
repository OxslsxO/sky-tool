const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("photo-id is no longer treated as a pure client-side tool", () => {
  const toolEngine = read("utils/tool-engine.js");

  assert.doesNotMatch(
    toolEngine,
    /["']photo-id["']/,
    "photo-id still appears in CLIENT_TOOL_IDS"
  );
});

test("photo-id page delegates processing to the backend photo-id API", () => {
  const toolDetail = read("pages/tool-detail/index.js");

  assert.match(toolDetail, /\/api\/photo-id/);
  assert.doesNotMatch(
    toolDetail,
    /async runPhotoId\(\)\s*\{[\s\S]*withCanvas\(/,
    "photo-id still renders locally with canvas instead of calling the backend"
  );
});

test("photo-id keeps the result on the current page while recording a task", () => {
  const toolDetail = read("pages/tool-detail/index.js");
  const wxml = read("pages/tool-detail/index.wxml");
  const runRemotePhotoIdBody = (toolDetail.match(/async runRemotePhotoId\(\)\s*\{([\s\S]*?)\n  \},\n\n  getClearedPhotoIdResult/) || [])[1] || "";

  assert.match(toolDetail, /photoIdResultReady/);
  assert.match(
    runRemotePhotoIdBody,
    /createTask\(/,
    "photo-id no longer records generated results in the task history"
  );
  assert.doesNotMatch(
    runRemotePhotoIdBody,
    /wx\.navigateTo\(\{\s*url:\s*[`"']\/pages\/task-detail\/index/,
    "photo-id should not auto-route away from the inline result"
  );
  assert.match(wxml, /bindtap="previewPhotoIdResult"/);
  assert.match(wxml, /class="result-card__image"/);
  assert.match(wxml, /photoIdDiagnosticsLines/);
});

test("photo-id shows recent tasks on the tool page", () => {
  const toolDetail = read("pages/tool-detail/index.js");

  assert.doesNotMatch(toolDetail, /showRecentTasks:\s*tool\.id\s*!==\s*["']photo-id["']/);
  assert.match(toolDetail, /showRecentTasks:\s*true/);
});

test("photo-id persists inline result state so page lifecycle refresh does not wipe it", () => {
  const toolDetail = read("pages/tool-detail/index.js");

  assert.match(toolDetail, /PHOTO_ID_SESSION_KEY/);
  assert.match(toolDetail, /readPhotoIdSession\(\)/);
  assert.match(toolDetail, /writePhotoIdSession\(nextState\)/);
  assert.match(toolDetail, /selections:\s*payload\.selections\s*\|\|\s*\{\}/);
  assert.match(toolDetail, /imageInput:\s*payload\.imageInput\s*\|\|\s*null/);
  assert.match(toolDetail, /photoIdDiagnosticsLines:\s*payload\.photoIdDiagnosticsLines\s*\|\|\s*\[\]/);
  assert.match(toolDetail, /persistPhotoIdSession\(\{\s*\.\.\.this\.data,\s*\.\.\.nextState,\s*\}\)/);
});

test("photo-id page surfaces request diagnostics on the result card", () => {
  const toolDetail = read("pages/tool-detail/index.js");

  assert.match(toolDetail, /includeMeta:\s*true/);
  assert.match(toolDetail, /buildPhotoIdDiagnosticsLines/);
  assert.match(toolDetail, /photoIdDiagnosticsLines/);
});
