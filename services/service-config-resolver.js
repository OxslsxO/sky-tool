function isLocalDebugUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().toLowerCase();
  return (
    normalized.indexOf("127.0.0.1") > -1 ||
    normalized.indexOf("localhost") > -1 ||
    normalized.indexOf("0.0.0.0") > -1 ||
    /:\/\/192\.168\.\d+\.\d+/.test(normalized) ||
    /:\/\/10\.\d+\.\d+\.\d+/.test(normalized) ||
    /:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+/.test(normalized)
  );
}

function shouldDiscardStaleHostedDebugUrl(envVersion, defaultBaseUrl, storedBaseUrl) {
  if (!isLocalDebugUrl(defaultBaseUrl)) {
    return false;
  }

  const normalizedStored = String(storedBaseUrl || "").trim().toLowerCase();
  if (normalizedStored.indexOf("hf.space") > -1) {
    return true;
  }

  if (envVersion === "develop" || envVersion === "trial") {
    return /^https?:\/\//i.test(normalizedStored) && !isLocalDebugUrl(normalizedStored);
  }

  return false;
}

function resolveServiceConfig({ envVersion, defaultBaseUrl, storedConfig }) {
  try {
    const sanitizedStored = { ...(storedConfig || {}) };

    if (envVersion === "release" && isLocalDebugUrl(sanitizedStored.baseUrl)) {
      delete sanitizedStored.baseUrl;
    }

    if (shouldDiscardStaleHostedDebugUrl(envVersion, defaultBaseUrl, sanitizedStored.baseUrl)) {
      delete sanitizedStored.baseUrl;
    }

    return {
      baseUrl: defaultBaseUrl,
      token: "",
      ...sanitizedStored,
    };
  } catch (error) {
    console.warn("[service-config-resolver] resolveServiceConfig failed:", error);
    return {
      baseUrl: defaultBaseUrl,
      token: "",
    };
  }
}

module.exports = {
  isLocalDebugUrl,
  resolveServiceConfig,
};
