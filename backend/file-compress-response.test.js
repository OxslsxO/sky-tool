const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldInlineCompressedFile } = require("./lib/file-compress-response");

test("shouldInlineCompressedFile returns true for image outputs", () => {
  assert.equal(
    shouldInlineCompressedFile({
      fileName: "compressed-demo.png",
      mimeType: "image/png",
    }),
    true
  );
});

test("shouldInlineCompressedFile returns false for document outputs", () => {
  assert.equal(
    shouldInlineCompressedFile({
      fileName: "compressed-demo.pdf",
      mimeType: "application/pdf",
    }),
    false
  );
});
