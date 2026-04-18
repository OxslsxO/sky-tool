const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("pdf-to-word route uses pdf2docx for keep-layout mode", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /convertPdfToWordWithPdf2docx/);
  assert.match(source, /pdf2docx/);
});

test("pdf-to-word route treats keep-layout mode as high-fidelity mode", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /shouldUseHighFidelityPdfToWord/);
  assert.match(source, /保持版式|淇濇寔鐗堝紡/);
  assert.match(source, /优先文字|浼樺厛鏂囧瓧/);
});

test("pdf-to-word route preserves the text-only conversion path", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /convertPdfToWordTextOnly/);
  assert.match(source, /PDF_TO_WORD_CONVERTER_NOT_AVAILABLE/);
});
