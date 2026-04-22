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

function withEnv(overrides, callback) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadFreshConfig() {
  const configPath = require.resolve("./lib/config");
  delete require.cache[configPath];
  return require("./lib/config").buildConfig();
}

test("local runtime honors explicit port and host", () => {
  withEnv(
    {
      SPACE_ID: undefined,
      SPACE_HOST: undefined,
      PORT: "3210",
      HOST: "127.0.0.1",
    },
    () => {
      const config = loadFreshConfig();

      assert.equal(config.port, 3210);
      assert.equal(config.host, "127.0.0.1");
    }
  );
});

test("Hugging Face runtime keeps the public Docker Space port reachable", () => {
  withEnv(
    {
      SPACE_ID: "OxslsxO/sky-tool",
      SPACE_HOST: "oxslsxo-sky-tool.hf.space",
      PORT: "3100",
      HOST: "127.0.0.1",
    },
    () => {
      const config = loadFreshConfig();

      assert.equal(config.port, 7860);
      assert.equal(config.host, "0.0.0.0");
    }
  );
});
