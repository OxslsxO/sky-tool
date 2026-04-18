# CloudConvert PDF to Word Design

## Goal

Upgrade `PDF 转 Word` from plain text extraction to a high-fidelity, editable DOCX conversion path. The output should preserve the source PDF's visual layout, images, tables, and text editability as much as the external conversion engine allows.

## Current Behavior

The backend route `POST /api/pdf/to-word` currently uses `pdf2json` to extract text tokens and then builds a new DOCX with `docx`. This loses the original PDF layout because it only recreates paragraphs from text content.

## Chosen Approach

Use CloudConvert for the high-fidelity conversion mode.

When the request asks to keep layout and `CLOUDCONVERT_API_KEY` is configured, the backend will:

1. Decode and write the uploaded PDF to the request temp directory.
2. Create a CloudConvert job with these tasks:
   - import the uploaded PDF
   - convert PDF to DOCX
   - export the converted DOCX by URL
3. Download the converted DOCX result.
4. Save it through the existing `saveOutputFile` storage path.
5. Return the same response shape the mini program already expects.

## Modes

`layout === "保持版式"` uses CloudConvert and targets high-fidelity editable DOCX output.

`layout === "优先文字"` keeps the current local text-extraction path. This remains useful when the user wants a lightweight result or when no CloudConvert API key is configured.

If the frontend sends no layout, the backend should default to high-fidelity conversion when `CLOUDCONVERT_API_KEY` is available, otherwise use the local text path.

## Configuration

Add this environment variable:

```text
CLOUDCONVERT_API_KEY=<secret>
```

No key should be committed to the repository. Render should store it as an environment variable.

Optional future variables can be added later if needed:

```text
CLOUDCONVERT_SANDBOX=1
CLOUDCONVERT_TIMEOUT_MS=120000
```

They are not required for the first implementation.

## Error Handling

CloudConvert errors should be recorded in operation history with `toolId: "pdf-to-word"` and a clear error code.

Expected error cases:

- Missing API key while layout is `保持版式`
- CloudConvert job creation failure
- CloudConvert conversion failure
- Export URL missing from the finished job
- Downloaded result is empty
- Conversion timeout

If layout is `保持版式` and CloudConvert is unavailable, the route should fail clearly instead of silently returning a low-fidelity text-only DOCX. Silent fallback would make users think the feature preserved layout when it did not.

If layout is `优先文字`, the route should use the existing local conversion path and should not require CloudConvert.

## Data Flow

The request and response contract remains unchanged:

```text
mini program -> POST /api/pdf/to-word -> backend -> DOCX output -> existing file response
```

Internally, the route will be split into smaller helpers:

- `convertPdfToWordWithCloudConvert(inputPath, options)`
- `convertPdfToWordTextOnly(fileBuffer, file, inputName, layout)`
- `downloadCloudConvertResult(url)`

The route will choose the conversion helper, save the returned DOCX buffer, record the operation, and return the existing JSON shape.

## Security And Privacy

The uploaded PDF is sent to CloudConvert when high-fidelity mode is used. The UI copy or backend response detail should make this clear enough for users who care about third-party processing.

The API key must only live in server-side environment variables.

Temporary local files continue to be removed in the existing `finally` cleanup.

## Testing

Add focused backend tests that verify:

- `保持版式` uses the CloudConvert path when `CLOUDCONVERT_API_KEY` is present.
- `保持版式` fails clearly when the API key is missing.
- `优先文字` keeps using the local text-only path.
- CloudConvert result validation rejects missing or empty DOCX output.

Existing route startup and PDF text decoding tests should continue to pass.

## Non-Goals

This change will not guarantee perfect reconstruction for every PDF. PDF to editable DOCX conversion is inherently lossy for complex documents. The goal is to use a professional conversion engine so the result is much closer to the source than the current text-only implementation.

This change will not add OCR controls in the first pass. CloudConvert's default PDF to DOCX behavior will be used initially, and OCR-specific tuning can be added after testing real documents.
