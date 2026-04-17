const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

test("default runtime storage lives outside the mini program project directory", () => {
  delete process.env.STORAGE_ROOT_DIR;

  const configPath = require.resolve("./lib/config");
  delete require.cache[configPath];
  const { ROOT_DIR, STORAGE_DIR } = require("./lib/config");

  const projectRoot = path.resolve(ROOT_DIR, "..");
  const relativePath = path.relative(projectRoot, STORAGE_DIR);
  const isInsideProject =
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath);

  assert.equal(
    isInsideProject,
    false,
    `expected runtime storage to be outside project root, got ${STORAGE_DIR}`
  );
});
