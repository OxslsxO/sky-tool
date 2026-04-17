function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;

  if (diff < 60 * 1000) {
    return "刚刚";
  }

  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  }

  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  }

  return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
}

function formatMegabytes(value) {
  if (value === null || value === undefined) {
    return "--";
  }

  if (value < 1) {
    return `${Math.round(value * 1024)} KB`;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} MB`;
}

function bytesToMegabytesValue(bytes) {
  if (bytes === null || bytes === undefined) {
    return null;
  }

  return bytes / (1024 * 1024);
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) {
    return "--";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return formatMegabytes(bytesToMegabytesValue(bytes));
}

function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}`;
}

module.exports = {
  formatRelativeTime,
  formatMegabytes,
  bytesToMegabytesValue,
  formatFileSize,
  formatDateTime,
};
