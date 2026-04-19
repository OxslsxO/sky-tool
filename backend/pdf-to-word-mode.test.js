const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("pdf-to-word route uses Adobe PDF Services export", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /@adobe\/pdfservices-node-sdk/);
  assert.match(source, /convertPdfToWordWithAdobe/);
  assert.match(source, /ExportPDFTargetFormat\.DOCX/);
  assert.match(source, /ExportPDFTargetFormat\.DOC/);
  assert.match(source, /ExportOCRLocale/);
  assert.match(source, /ocrLocale/);
  assert.match(source, /ExportPDFJob/);
  assert.doesNotMatch(source, /convertPdfToWordWithPdf2docx/);
  assert.doesNotMatch(source, /convertPdfToWordTextOnly/);
});

test("pdf-to-word route supports Adobe credentials and optional protected PDFs", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /PDF_SERVICES_CLIENT_ID/);
  assert.match(source, /PDF_SERVICES_CLIENT_SECRET/);
  assert.match(source, /RemoveProtectionJob/);
  assert.match(source, /RemoveProtectionParams/);
  assert.match(source, /req\.body\.password \|\| req\.body\.pdfPassword/);
});

test("pdf-to-word route defaults OCR locale to Chinese while allowing overrides", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /PDF_SERVICES_OCR_LOCALE/);
  assert.match(source, /"zh-CN"/);
  assert.match(source, /req\.body\.ocrLocale \|\| req\.body\.language \|\| req\.body\.locale/);
});
