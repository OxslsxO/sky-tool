const path = require("path");

function shouldInlineCompressedFile({ fileName, mimeType, fileBytes }) {
  // 先简化，只处理图片，其他都不内联
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return true;
  }

  const extension = path.extname(String(fileName || "")).toLowerCase();
  return [
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"
  ].includes(extension);
}

module.exports = {
  shouldInlineCompressedFile,
};
