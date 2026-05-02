const test = require("node:test");
const assert = require("node:assert/strict");
const { getPreferredRemoteFileUrl } = require("../utils/remote-file");

test("getPreferredRemoteFileUrl prefers downloadUrl", () => {
  assert.equal(
    getPreferredRemoteFileUrl({
      downloadUrl: "https://example.com/download",
      fallbackUrl: "https://example.com/fallback",
      url: "https://example.com/url",
      externalUrl: "https://example.com/external",
    }),
    "https://example.com/download"
  );
});

test("getPreferredRemoteFileUrl falls back through known URL fields", () => {
  assert.equal(
    getPreferredRemoteFileUrl({
      fallbackUrl: "https://example.com/fallback",
      url: "https://example.com/url",
    }),
    "https://example.com/fallback"
  );
});
