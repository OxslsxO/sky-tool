function isLocalDebugUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().toLowerCase();
  return (
    normalized.includes("127.0.0.1") ||
    normalized.includes("localhost") ||
    normalized.includes("0.0.0.0") ||
    /:\/\/192\.168\.\d+\.\d+/.test(normalized) ||
    /:\/\/10\.\d+\.\d+\.\d+/.test(normalized) ||
    /:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+/.test(normalized)
  );
}

function resolvePublicBaseUrl(configPublicBaseUrl, requestBaseUrl) {
  const configured = String(configPublicBaseUrl || "").trim().replace(/\/$/, "");
  const requestUrl = String(requestBaseUrl || "").trim().replace(/\/$/, "");

  if (!configured) {
    return requestUrl;
  }

  if (requestUrl && isLocalDebugUrl(requestUrl) && !isLocalDebugUrl(configured)) {
    return requestUrl;
  }

  return configured || requestUrl;
}

module.exports = {
  isLocalDebugUrl,
  resolvePublicBaseUrl,
};
