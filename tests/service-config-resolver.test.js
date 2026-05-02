const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveServiceConfig } = require("../services/service-config-resolver");

test("resolveServiceConfig discards stale hf.space config in develop when local default exists", () => {
  const result = resolveServiceConfig({
    envVersion: "develop",
    defaultBaseUrl: "http://127.0.0.1:3100",
    storedConfig: {
      baseUrl: "https://oxslsxo-sky-tool.hf.space",
      token: "abc",
    },
  });

  assert.deepEqual(result, {
    baseUrl: "http://127.0.0.1:3100",
    token: "abc",
  });
});

test("resolveServiceConfig keeps manual local config in develop", () => {
  const result = resolveServiceConfig({
    envVersion: "develop",
    defaultBaseUrl: "http://127.0.0.1:3100",
    storedConfig: {
      baseUrl: "http://192.168.1.8:3100",
      token: "abc",
    },
  });

  assert.equal(result.baseUrl, "http://192.168.1.8:3100");
  assert.equal(result.token, "abc");
});

test("resolveServiceConfig discards stale hf.space config even when envVersion is release if local default exists", () => {
  const result = resolveServiceConfig({
    envVersion: "release",
    defaultBaseUrl: "http://127.0.0.1:3100",
    storedConfig: {
      baseUrl: "https://oxslsxo-sky-tool.hf.space",
      token: "abc",
    },
  });

  assert.deepEqual(result, {
    baseUrl: "http://127.0.0.1:3100",
    token: "abc",
  });
});
