# CloudConvert PDF to Word Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a high-fidelity editable PDF to DOCX conversion path using CloudConvert while preserving the existing text-only fallback mode.

**Architecture:** Keep the route response contract unchanged. Move CloudConvert-specific API calls into a focused backend helper module, keep local text-only DOCX generation available, and let `POST /api/pdf/to-word` choose the conversion mode from `layout` and `CLOUDCONVERT_API_KEY`.

**Tech Stack:** Node.js, Express, built-in `fetch`, `FormData`, `Blob`, `node:test`, existing `docx`, `pdf2json`, and storage helpers.

---

## File Structure

- Create `backend/lib/cloudconvert.js`: owns CloudConvert job creation, polling, export URL extraction, result download, and validation.
- Create `backend/cloudconvert.test.js`: unit tests for mode-independent CloudConvert helper behavior using injected `fetch`.
- Modify `backend/server.js`: route-level mode selection and use the CloudConvert helper for `保持版式`.
- Modify `backend/pdf-text-regression.test.js` or create `backend/pdf-to-word-mode.test.js`: regression coverage for route source behavior without needing real CloudConvert network calls.
- Keep `backend/lib/pdf-text.js`: remains responsible only for safe PDF text token decoding.
- Keep `docs/superpowers/specs/2026-04-19-cloudconvert-pdf-to-word-design.md`: no implementation changes required unless behavior changes during implementation.

---

### Task 1: CloudConvert Helper

**Files:**
- Create: `backend/lib/cloudconvert.js`
- Create: `backend/cloudconvert.test.js`

- [ ] **Step 1: Write failing tests for missing API key, job creation payload, export URL extraction, and empty output validation**

Create `backend/cloudconvert.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  convertPdfToDocxWithCloudConvert,
  extractCloudConvertExportUrl,
} = require("./lib/cloudconvert");

test("extractCloudConvertExportUrl returns the first exported file URL", () => {
  const job = {
    data: {
      tasks: [
        { name: "import-pdf", operation: "import/upload" },
        {
          name: "export-docx",
          operation: "export/url",
          result: {
            files: [{ url: "https://example.test/result.docx" }],
          },
        },
      ],
    },
  };

  assert.equal(extractCloudConvertExportUrl(job), "https://example.test/result.docx");
});

test("extractCloudConvertExportUrl throws when the export URL is missing", () => {
  assert.throws(
    () => extractCloudConvertExportUrl({ data: { tasks: [] } }),
    /CloudConvert export URL missing/
  );
});

test("convertPdfToDocxWithCloudConvert requires an API key", async () => {
  await assert.rejects(
    () =>
      convertPdfToDocxWithCloudConvert({
        apiKey: "",
        fileBuffer: Buffer.from("%PDF test"),
        fileName: "input.pdf",
      }),
    /CLOUDCONVERT_API_KEY is required/
  );
});

test("convertPdfToDocxWithCloudConvert creates a PDF to DOCX job and downloads the result", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });

    if (url === "https://api.cloudconvert.com/v2/jobs") {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            id: "job-123",
            tasks: [
              {
                name: "import-pdf",
                operation: "import/upload",
                result: { form: { url: "https://upload.example.test", parameters: {} } },
              },
            ],
          },
        }),
      };
    }

    if (url === "https://upload.example.test") {
      return { ok: true, status: 201, text: async () => "" };
    }

    if (url === "https://api.cloudconvert.com/v2/jobs/job-123") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            status: "finished",
            tasks: [
              {
                name: "export-docx",
                operation: "export/url",
                result: {
                  files: [{ url: "https://download.example.test/result.docx" }],
                },
              },
            ],
          },
        }),
      };
    }

    if (url === "https://download.example.test/result.docx") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("docx").buffer,
      };
    }

    throw new Error(`unexpected fetch URL ${url}`);
  };

  const result = await convertPdfToDocxWithCloudConvert({
    apiKey: "secret",
    fileBuffer: Buffer.from("%PDF test"),
    fileName: "source.pdf",
    fetchImpl,
    pollIntervalMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(Buffer.isBuffer(result), true);
  assert.equal(result.length > 0, true);
  assert.equal(calls[0].url, "https://api.cloudconvert.com/v2/jobs");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.headers.Authorization, /^Bearer secret$/);
  assert.match(calls[0].options.body, /"operation":"convert"/);
  assert.match(calls[0].options.body, /"input_format":"pdf"/);
  assert.match(calls[0].options.body, /"output_format":"docx"/);
});

test("convertPdfToDocxWithCloudConvert rejects an empty downloaded DOCX", async () => {
  const fetchImpl = async (url) => {
    if (url === "https://api.cloudconvert.com/v2/jobs") {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            id: "job-123",
            tasks: [
              {
                name: "import-pdf",
                result: { form: { url: "https://upload.example.test", parameters: {} } },
              },
            ],
          },
        }),
      };
    }

    if (url === "https://upload.example.test") {
      return { ok: true, status: 201, text: async () => "" };
    }

    if (url === "https://api.cloudconvert.com/v2/jobs/job-123") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            status: "finished",
            tasks: [
              {
                name: "export-docx",
                result: { files: [{ url: "https://download.example.test/result.docx" }] },
              },
            ],
          },
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };

  await assert.rejects(
    () =>
      convertPdfToDocxWithCloudConvert({
        apiKey: "secret",
        fileBuffer: Buffer.from("%PDF test"),
        fileName: "source.pdf",
        fetchImpl,
        pollIntervalMs: 1,
        timeoutMs: 1000,
      }),
    /empty DOCX/
  );
});
```

- [ ] **Step 2: Run tests and verify they fail because the helper does not exist**

Run:

```powershell
node --test backend/cloudconvert.test.js
```

Expected: FAIL with `Cannot find module './lib/cloudconvert'`.

- [ ] **Step 3: Implement the CloudConvert helper**

Create `backend/lib/cloudconvert.js`:

```js
const CLOUDCONVERT_API_BASE_URL = "https://api.cloudconvert.com/v2";

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readJsonResponse(response, fallbackMessage) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && payload.message
        ? payload.message
        : `${fallbackMessage}: HTTP ${response.status}`;
    throw createError(message, "PDF_TO_WORD_CLOUDCONVERT_FAILED");
  }

  return payload;
}

function extractImportUploadForm(job) {
  const tasks = job && job.data && Array.isArray(job.data.tasks) ? job.data.tasks : [];
  const importTask = tasks.find((task) => task.name === "import-pdf");
  const form = importTask && importTask.result && importTask.result.form;

  if (!form || !form.url) {
    throw createError("CloudConvert upload form missing", "PDF_TO_WORD_CLOUDCONVERT_FAILED");
  }

  return form;
}

function extractCloudConvertExportUrl(job) {
  const tasks = job && job.data && Array.isArray(job.data.tasks) ? job.data.tasks : [];
  const exportTask = tasks.find((task) => task.name === "export-docx");
  const files = exportTask && exportTask.result && Array.isArray(exportTask.result.files)
    ? exportTask.result.files
    : [];
  const firstFile = files.find((file) => file && file.url);

  if (!firstFile) {
    throw createError("CloudConvert export URL missing", "PDF_TO_WORD_CLOUDCONVERT_FAILED");
  }

  return firstFile.url;
}

function buildCloudConvertJobPayload(fileName) {
  return {
    tasks: {
      "import-pdf": {
        operation: "import/upload",
      },
      "convert-docx": {
        operation: "convert",
        input: "import-pdf",
        input_format: "pdf",
        output_format: "docx",
        filename: fileName.replace(/\.pdf$/i, ".docx"),
      },
      "export-docx": {
        operation: "export/url",
        input: "convert-docx",
      },
    },
  };
}

async function createCloudConvertJob({ apiKey, fileName, fetchImpl }) {
  const response = await fetchImpl(`${CLOUDCONVERT_API_BASE_URL}/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildCloudConvertJobPayload(fileName)),
  });

  return readJsonResponse(response, "CloudConvert job creation failed");
}

async function uploadPdfToCloudConvert({ form, fileBuffer, fileName, fetchImpl }) {
  const body = new FormData();
  const parameters = form.parameters || {};

  Object.keys(parameters).forEach((key) => {
    body.append(key, parameters[key]);
  });

  body.append("file", new Blob([fileBuffer], { type: "application/pdf" }), fileName);

  const response = await fetchImpl(form.url, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    throw createError(
      `CloudConvert upload failed: HTTP ${response.status}`,
      "PDF_TO_WORD_CLOUDCONVERT_FAILED"
    );
  }
}

async function waitForCloudConvertJob({ apiKey, jobId, fetchImpl, pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchImpl(`${CLOUDCONVERT_API_BASE_URL}/jobs/${jobId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const job = await readJsonResponse(response, "CloudConvert job polling failed");
    const status = job && job.data && job.data.status;

    if (status === "finished") {
      return job;
    }

    if (status === "error") {
      throw createError("CloudConvert conversion failed", "PDF_TO_WORD_CLOUDCONVERT_FAILED");
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw createError("CloudConvert conversion timed out", "PDF_TO_WORD_CLOUDCONVERT_TIMEOUT");
}

async function downloadCloudConvertResult({ url, fetchImpl }) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw createError(
      `CloudConvert DOCX download failed: HTTP ${response.status}`,
      "PDF_TO_WORD_CLOUDCONVERT_FAILED"
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw createError("CloudConvert returned an empty DOCX", "PDF_TO_WORD_CLOUDCONVERT_FAILED");
  }

  return buffer;
}

async function convertPdfToDocxWithCloudConvert(options) {
  const apiKey = options.apiKey || "";
  if (!apiKey) {
    throw createError("CLOUDCONVERT_API_KEY is required", "PDF_TO_WORD_CLOUDCONVERT_NOT_CONFIGURED");
  }

  const fetchImpl = options.fetchImpl || fetch;
  const pollIntervalMs = options.pollIntervalMs || 1500;
  const timeoutMs = options.timeoutMs || 120000;
  const fileName = options.fileName || "input.pdf";

  const createdJob = await createCloudConvertJob({
    apiKey,
    fileName,
    fetchImpl,
  });
  const form = extractImportUploadForm(createdJob);

  await uploadPdfToCloudConvert({
    form,
    fileBuffer: options.fileBuffer,
    fileName,
    fetchImpl,
  });

  const finishedJob = await waitForCloudConvertJob({
    apiKey,
    jobId: createdJob.data.id,
    fetchImpl,
    pollIntervalMs,
    timeoutMs,
  });
  const exportUrl = extractCloudConvertExportUrl(finishedJob);

  return downloadCloudConvertResult({
    url: exportUrl,
    fetchImpl,
  });
}

module.exports = {
  convertPdfToDocxWithCloudConvert,
  extractCloudConvertExportUrl,
};
```

- [ ] **Step 4: Run CloudConvert helper tests**

Run:

```powershell
node --test backend/cloudconvert.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit helper**

Run:

```powershell
git add -- backend/lib/cloudconvert.js backend/cloudconvert.test.js
git commit -m "Add CloudConvert PDF to DOCX helper"
```

---

### Task 2: Route Mode Selection

**Files:**
- Modify: `backend/server.js`
- Create: `backend/pdf-to-word-mode.test.js`

- [ ] **Step 1: Write failing source-level regression tests for mode selection**

Create `backend/pdf-to-word-mode.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("pdf-to-word route imports the CloudConvert helper", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /convertPdfToDocxWithCloudConvert/);
  assert.match(source, /require\("\.\/lib\/cloudconvert"\)/);
});

test("pdf-to-word route treats keep-layout mode as CloudConvert mode", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /shouldUseHighFidelityPdfToWord/);
  assert.match(source, /CLOUDCONVERT_API_KEY/);
  assert.match(source, /保持版式|淇濇寔鐗堝紡/);
  assert.match(source, /优先文字|浼樺厛鏂囧瓧/);
});

test("pdf-to-word route preserves the text-only conversion path", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

  assert.match(source, /convertPdfToWordTextOnly/);
  assert.match(source, /PDF_TO_WORD_CLOUDCONVERT_NOT_CONFIGURED/);
});
```

- [ ] **Step 2: Run the route mode tests and verify they fail**

Run:

```powershell
node --test backend/pdf-to-word-mode.test.js
```

Expected: FAIL because `server.js` has no CloudConvert helper import or mode selector yet.

- [ ] **Step 3: Import the helper and add mode selection helpers near the PDF to Word route**

Modify the imports in `backend/server.js`:

```js
const { convertPdfToDocxWithCloudConvert } = require("./lib/cloudconvert");
```

Add these helpers above `app.post("/api/pdf/to-word", ...)`:

```js
function shouldUseHighFidelityPdfToWord(layout) {
  const normalized = String(layout || "").trim();
  if (!normalized) {
    return Boolean(process.env.CLOUDCONVERT_API_KEY);
  }

  if (normalized === "优先文字" || normalized === "浼樺厛鏂囧瓧") {
    return false;
  }

  return normalized === "保持版式" || normalized === "淇濇寔鐗堝紡";
}

function assertCloudConvertConfigured() {
  if (!process.env.CLOUDCONVERT_API_KEY) {
    const error = new Error("PDF转Word保持版式需要配置 CLOUDCONVERT_API_KEY");
    error.code = "PDF_TO_WORD_CLOUDCONVERT_NOT_CONFIGURED";
    throw error;
  }
}
```

- [ ] **Step 4: Extract the existing local conversion body into a helper**

Still in `backend/server.js`, move the existing `pdf2json` and `docx` generation logic into:

```js
async function convertPdfToWordTextOnly(fileBuffer, file, inputName) {
  console.log("[PDF to Word] 开始提取PDF文本...");
  const pdfParser = new PDFParser(this, 1);

  const data = await new Promise((resolve, reject) => {
    pdfParser.on("pdfParser_dataError", (errData) => {
      reject(new Error(errData.parserError));
    });
    pdfParser.on("pdfParser_dataReady", (pdfData) => {
      resolve(pdfData);
    });
    pdfParser.parseBuffer(fileBuffer);
  });

  const numPages = data.Pages.length;
  console.log("[PDF to Word] 提取完成, 共", numPages, "页");
  console.log("[PDF to Word] 生成Word文档...");

  const paragraphs = [];
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: "PDF转换结果", bold: true, size: 32 })],
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: "文档信息", bold: true, size: 24 })],
    heading: HeadingLevel.HEADING_2,
    spacing: { after: 200 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: `原文件: ${file.name || inputName}` })],
    spacing: { after: 100 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: `页数: ${numPages}` })],
    spacing: { after: 200 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: "文档内容", bold: true, size: 24 })],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 400, after: 200 },
  }));

  for (let pageIndex = 0; pageIndex < data.Pages.length; pageIndex += 1) {
    const page = data.Pages[pageIndex];

    if (pageIndex > 0) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: `--- 第 ${pageIndex + 1} 页 ---`, bold: true })],
        spacing: { before: 200, after: 100 },
      }));
    }

    if (page.Texts) {
      const textParts = page.Texts.map((t) =>
        t.R && t.R[0] ? decodePdfTextToken(t.R[0].T) : ""
      );
      const pageText = textParts.join(" ").replace(/\s+/g, " ").trim();

      const textLines = pageText.split(/\n+/);
      for (const line of textLines) {
        if (line.trim()) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line.trim() })],
            spacing: { after: 100 },
          }));
        }
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return {
    buffer,
    pages: numPages,
    engine: "text-only",
  };
}
```

- [ ] **Step 5: Update the route to choose CloudConvert or text-only**

In `app.post("/api/pdf/to-word", ...)`, after writing `inputPath`, replace the inline conversion block with:

```js
    const highFidelity = shouldUseHighFidelityPdfToWord(layout);
    let conversion;

    if (highFidelity) {
      assertCloudConvertConfigured();
      console.log("[PDF to Word] 使用 CloudConvert 保持版式转换...");
      const convertedBuffer = await convertPdfToDocxWithCloudConvert({
        apiKey: process.env.CLOUDCONVERT_API_KEY,
        fileBuffer,
        fileName: file.name || inputName,
      });
      conversion = {
        buffer: convertedBuffer,
        pages: 0,
        engine: "cloudconvert",
      };
    } else {
      conversion = await convertPdfToWordTextOnly(fileBuffer, file, inputName);
    }

    console.log("[PDF to Word] Word文档生成完成, 大小:", conversion.buffer.length, "bytes");
```

Then update `saveOutputFile` to use `conversion.buffer`, operation `meta.pages` to use `conversion.pages`, and `meta` to include `engine: conversion.engine`.

Use response text:

```js
detail:
  conversion.engine === "cloudconvert"
    ? "已通过高保真转换服务生成可编辑Word文档，尽量保留原PDF版式。"
    : "已提取PDF文本内容并转换为可编辑的Word文档。",
metaLines: [
  `原文件 ${file.name || inputName}`,
  conversion.pages ? `共 ${conversion.pages} 页` : "",
  `输出格式 DOCX`,
  conversion.engine === "cloudconvert" ? "模式 保持版式" : "模式 优先文字",
].filter(Boolean),
```

- [ ] **Step 6: Run route mode tests**

Run:

```powershell
node --test backend/pdf-to-word-mode.test.js
```

Expected: PASS.

- [ ] **Step 7: Run existing focused tests**

Run:

```powershell
node --test backend/pdf-text-regression.test.js backend/env-loading-regression.test.js backend/photo-id-route.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit route integration**

Run:

```powershell
git add -- backend/server.js backend/pdf-to-word-mode.test.js
git commit -m "Use CloudConvert for keep-layout PDF to Word"
```

---

### Task 3: Documentation And Deployment Notes

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-04-19-cloudconvert-pdf-to-word-design.md` if implementation details changed

- [ ] **Step 1: Add README configuration notes**

Add a backend environment variable note to `README.md` near existing backend/deployment guidance:

```md
### CloudConvert PDF to Word

`PDF 转 Word` supports a high-fidelity editable DOCX mode through CloudConvert.

Set this environment variable on the backend service:

```text
CLOUDCONVERT_API_KEY=your_cloudconvert_api_key
```

When the mini program sends `layout: "保持版式"`, the backend sends the uploaded PDF to CloudConvert and stores the returned DOCX through the existing output storage. When the mini program sends `layout: "优先文字"`, the backend uses the local text-only converter and does not require CloudConvert.
```

- [ ] **Step 2: Run a placeholder scan**

Run:

```powershell
Select-String -Path .\\README.md,.\\docs\\superpowers\\specs\\2026-04-19-cloudconvert-pdf-to-word-design.md -Pattern 'TODO|TBD|placeholder|待定' -CaseSensitive:$false
```

Expected: no output for the CloudConvert sections.

- [ ] **Step 3: Run all focused tests**

Run:

```powershell
node --test backend/cloudconvert.test.js backend/pdf-to-word-mode.test.js backend/pdf-text-regression.test.js backend/env-loading-regression.test.js backend/photo-id-route.test.js backend/server-startup.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

Run:

```powershell
git add -- README.md docs/superpowers/specs/2026-04-19-cloudconvert-pdf-to-word-design.md
git commit -m "Document CloudConvert PDF to Word setup"
```

---

## Self-Review

Spec coverage:

- High-fidelity CloudConvert path: Task 1 and Task 2.
- Existing text-only mode preserved: Task 2 route mode tests and helper extraction.
- Missing API key error: Task 1 helper test and Task 2 route helper.
- Existing response shape: Task 2 keeps route response structure and only changes detail/meta content.
- Render configuration documentation: Task 3 README update.

Placeholder scan:

- The plan intentionally includes exact code snippets and commands.
- No `TODO`, `TBD`, or unresolved placeholders are required for implementation.

Type consistency:

- The CloudConvert module exports `convertPdfToDocxWithCloudConvert` and `extractCloudConvertExportUrl`.
- The route imports `convertPdfToDocxWithCloudConvert`.
- The local helper returns `{ buffer, pages, engine }`, and the route consumes those names consistently.
