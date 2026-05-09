const path = require("path");

function shouldInlineCompressedFile({ fileName, mimeType, fileBytes }) {
  // 只内联图片文件，其他文件都不内联，使用下载方式（更快）
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    // 对于图片，只在文件较小时内联（降低到 1MB 防止小程序卡死）
    const MAX_INLINE_SIZE = 1 * 1024 * 1024; // 1MB
    return fileBytes && fileBytes.length <= MAX_INLINE_SIZE;
  }
  return false;
}

module.exports = {
  shouldInlineCompressedFile,
};
