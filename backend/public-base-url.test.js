const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePublicBaseUrl } = require("./lib/public-base-url");

test("resolvePublicBaseUrl prefers request localhost over hosted PUBLIC_BASE_URL", () => {
  assert.equal(
    resolvePublicBaseUrl(
      "https://oxslsxo-sky-tool.hf.space",
      "http://127.0.0.1:3100"
    ),
    "http://127.0.0.1:3100"
  );
});

test("resolvePublicBaseUrl keeps hosted PUBLIC_BASE_URL for hosted requests", () => {
  assert.equal(
    resolvePublicBaseUrl(
      "https://oxslsxo-sky-tool.hf.space",
      "https://oxslsxo-sky-tool.hf.space"
    ),
    "https://oxslsxo-sky-tool.hf.space"
  );
});

test("resolvePublicBaseUrl prefers configured url when both are local", () => {
  assert.equal(
    resolvePublicBaseUrl(
      "http://192.168.1.8:3100",
      "http://127.0.0.1:3100"
    ),
    "http://192.168.1.8:3100"
  );
});
