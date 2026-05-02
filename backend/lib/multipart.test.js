const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMultipartBuffer } = require("./multipart");

test("parseMultipartBuffer extracts text fields and file bodies", () => {
  const boundary = "test-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n体积优先\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="demo.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const result = parseMultipartBuffer(body, boundary);

  assert.equal(result.fields.mode, "体积优先");
  assert.equal(result.files.file.fileName, "demo.mp4");
  assert.equal(result.files.file.contentType, "video/mp4");
  assert.deepEqual(Array.from(result.files.file.buffer), [1, 2, 3, 4]);
});
