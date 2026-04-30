const test = require("node:test");
const assert = require("node:assert/strict");

function loadBackendTools(envVersion, storedConfig) {
  global.wx = {
    getAccountInfoSync() {
      return {
        miniProgram: {
          envVersion,
        },
      };
    },
    getStorageSync(key) {
      if (key === "sky_tools_backend_service") {
        return storedConfig;
      }
      return undefined;
    },
    setStorageSync() {},
    removeStorageSync() {},
  };

  delete require.cache[require.resolve("../services/backend-tools")];
  return require("../services/backend-tools");
}

test("release env defaults backend calls to the production Hugging Face Space", () => {
  const backendTools = loadBackendTools("release");

  assert.equal(backendTools.getServiceConfig().baseUrl, "https://oxslsxo-sky-tool.hf.space");
  assert.equal(backendTools.hasBackendService(), true);
});

test("release env hides manual service config when production backend is already configured", () => {
  const backendTools = loadBackendTools("release");

  assert.equal(backendTools.shouldAllowManualServiceConfig(), false);
});

test("release env ignores stale localhost overrides from earlier debugging", () => {
  const backendTools = loadBackendTools("release", {
    baseUrl: "http://127.0.0.1:3100",
    token: "debug-token",
  });

  assert.equal(backendTools.getServiceConfig().baseUrl, "https://oxslsxo-sky-tool.hf.space");
  assert.equal(backendTools.getServiceConfig().token, "debug-token");
});

test("develop env keeps the local backend default for debugging", () => {
  const backendTools = loadBackendTools("develop");

  assert.equal(backendTools.getServiceConfig().baseUrl, "http://127.0.0.1:3100");
  assert.equal(backendTools.shouldAllowManualServiceConfig(), true);
});
