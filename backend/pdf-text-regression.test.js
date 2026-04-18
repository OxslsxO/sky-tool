const test = require("node:test");
const assert = require("node:assert/strict");

const { decodePdfTextToken } = require("./lib/pdf-text");

test("decodePdfTextToken decodes valid pdf2json URI text", () => {
  assert.equal(decodePdfTextToken("hello%20world"), "hello world");
});

test("decodePdfTextToken keeps malformed URI text instead of throwing", () => {
  assert.equal(decodePdfTextToken("progress 100% complete"), "progress 100% complete");
  assert.equal(decodePdfTextToken("%E4%B8%AD%"), "%E4%B8%AD%");
});
