const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");

function parseHeaders(headerText) {
  const headers = {};
  String(headerText || "")
    .split("\r\n")
    .forEach((line) => {
      const index = line.indexOf(":");
      if (index <= 0) {
        return;
      }
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      headers[key] = value;
    });
  return headers;
}

function parseContentDisposition(value) {
  const result = {};
  String(value || "")
    .split(";")
    .map((item) => item.trim())
    .forEach((item, index) => {
      if (index === 0) {
        result.type = item.toLowerCase();
        return;
      }
      const eqIndex = item.indexOf("=");
      if (eqIndex <= 0) {
        return;
      }
      const key = item.slice(0, eqIndex).trim().toLowerCase();
      const rawValue = item.slice(eqIndex + 1).trim();
      result[key] = rawValue.replace(/^"|"$/g, "");
    });
  return result;
}

function parseMultipartBuffer(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(delimiter);

  if (cursor < 0) {
    throw new Error("INVALID_MULTIPART_BOUNDARY");
  }

  cursor += delimiter.length + 2;

  while (cursor < buffer.length) {
    const nextDelimiterIndex = buffer.indexOf(delimiter, cursor);
    if (nextDelimiterIndex < 0) {
      break;
    }

    const rawPart = buffer.slice(cursor, nextDelimiterIndex - 2);
    const headerEnd = rawPart.indexOf(HEADER_SEPARATOR);
    if (headerEnd >= 0) {
      const headerText = rawPart.slice(0, headerEnd).toString("utf8");
      const body = rawPart.slice(headerEnd + HEADER_SEPARATOR.length);
      const headers = parseHeaders(headerText);
      const disposition = parseContentDisposition(headers["content-disposition"]);
      parts.push({
        headers,
        disposition,
        body,
      });
    }

    cursor = nextDelimiterIndex + delimiter.length;
    const maybeEnd = buffer.slice(cursor, cursor + 2).toString("utf8");
    if (maybeEnd === "--") {
      break;
    }
    cursor += 2;
  }

  const fields = {};
  const files = {};

  parts.forEach((part) => {
    const fieldName = part.disposition.name || "";
    if (!fieldName) {
      return;
    }

    if (part.disposition.filename) {
      files[fieldName] = {
        fieldName,
        fileName: part.disposition.filename,
        contentType: part.headers["content-type"] || "application/octet-stream",
        buffer: part.body,
        sizeBytes: part.body.length,
      };
      return;
    }

    fields[fieldName] = part.body.toString("utf8");
  });

  return { fields, files };
}

async function readRequestBuffer(req, maxBytes = 2 * 1024 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += nextChunk.length;
    if (total > maxBytes) {
      const error = new Error("上传文件过大");
      error.code = "MULTIPART_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(nextChunk);
  }

  return Buffer.concat(chunks);
}

async function parseMultipartRequest(req, maxBytes) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/boundary=([^;]+)/i);
  if (!match) {
    const error = new Error("缺少 multipart boundary");
    error.code = "INVALID_MULTIPART_REQUEST";
    throw error;
  }

  const boundary = match[1].trim().replace(/^"|"$/g, "");
  const bodyBuffer = await readRequestBuffer(req, maxBytes);
  return parseMultipartBuffer(bodyBuffer, boundary);
}

module.exports = {
  parseMultipartBuffer,
  parseMultipartRequest,
};
