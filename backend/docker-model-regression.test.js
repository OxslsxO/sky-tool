const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Docker image preloads the photo-id model during build", () => {
  const dockerfilePath = path.join(__dirname, "..", "Dockerfile");
  const source = fs.readFileSync(dockerfilePath, "utf8");

  assert.match(source, /backend\/storage\/models\/u2net_human_seg\.onnx/);
  assert.match(
    source,
    /danielgatis\/rembg\/releases\/download\/v0\.0\.0\/u2net_human_seg\.onnx/
  );
  assert.doesNotMatch(source, /arrayBuffer\(\)/);
});
