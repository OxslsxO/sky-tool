const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function runCheck(cwd) {
  return spawnSync(process.execPath, ["scripts/check-miniapp-imports.js"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      MINIAPP_IMPORT_CHECK_ROOT: cwd,
    },
  });
}

test("miniapp import check rejects bare package requires in runtime source", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miniapp-import-check-"));
  fs.mkdirSync(path.join(fixtureRoot, "pages"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "check-miniapp-imports.js"),
    path.join(fixtureRoot, "scripts-check.js")
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "pages", "index.js"),
    'const qrcode = require("qrcode-generator");\nmodule.exports = qrcode;\n',
    "utf8"
  );

  const result = spawnSync(process.execPath, ["scripts-check.js"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MINIAPP_IMPORT_CHECK_ROOT: fixtureRoot,
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /qrcode-generator|bare package/i);
});

test("current miniapp source passes the import check", () => {
  const projectRoot = path.join(__dirname, "..");
  const result = runCheck(projectRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("miniapp import check ignores colocated test files", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miniapp-import-check-ignore-"));
  fs.mkdirSync(path.join(fixtureRoot, "pages"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "check-miniapp-imports.js"),
    path.join(fixtureRoot, "scripts-check.js")
  );
  fs.writeFileSync(
    path.join(fixtureRoot, "pages", "entry.test.js"),
    'require("node:test");\n',
    "utf8"
  );

  const result = spawnSync(process.execPath, ["scripts-check.js"], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MINIAPP_IMPORT_CHECK_ROOT: fixtureRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
