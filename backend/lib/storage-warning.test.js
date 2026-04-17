const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { createStorage } = require("./storage");

test("loading storage does not print the punycode deprecation warning", () => {
  const projectRoot = path.join(__dirname, "..", "..");
  const result = spawnSync(
    process.execPath,
    ["-e", "require('./backend/lib/storage')"],
    {
      cwd: projectRoot,
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /\bDEP0040\b/);
  assert.doesNotMatch(result.stderr, /The `punycode` module is deprecated/);
});

test("createStorage reports Qiniu mode when Qiniu config is present", () => {
  const storage = createStorage({
    publicBaseUrl: "http://127.0.0.1:3100",
    outputDir: path.join(__dirname, "..", "storage", "outputs"),
    fileTtlHours: 24,
    qiniu: {
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "sky-toolbox",
      region: "z2",
      prefix: "sky-toolbox",
      publicBaseUrl: "https://cdn.example.com",
      privateBucket: false,
      downloadExpiresSeconds: 3600,
    },
  });

  assert.deepEqual(storage.getHealth(), {
    provider: "qiniu",
    qiniuEnabled: true,
    bucket: "sky-toolbox",
    region: "z2",
    privateBucket: false,
  });
});
