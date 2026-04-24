const STORAGE_KEY = "sky_tools_backend_service";
const DEFAULT_SERVICE_CONFIG = {
  baseUrl: "https://oxslsxo-sky-tool.hf.space",
  //baseUrl: "http://127.0.0.1:3100",
  //baseUrl: "https://intercounty-distastefully-shanelle.ngrok-free.dev",
  token: "",
};

function getMiniProgramEnvVersion() {
  try {
    const accountInfo = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
    return accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion
      ? accountInfo.miniProgram.envVersion
      : "release";
  } catch (error) {
    return "release";
  }
}

function shouldAllowManualServiceConfig() {
  const envVersion = getMiniProgramEnvVersion();
  return envVersion === "develop" || envVersion === "trial";
}

function getServiceConfig() {
  const stored = wx.getStorageSync(STORAGE_KEY) || {};
  return {
    ...DEFAULT_SERVICE_CONFIG,
    ...stored,
  };
}

function saveServiceConfig(config) {
  const next = {
    ...getServiceConfig(),
    ...config,
  };

  wx.setStorageSync(STORAGE_KEY, next);
  return next;
}

function clearServiceConfig() {
  wx.removeStorageSync(STORAGE_KEY);
}

function hasBackendService() {
  const config = getServiceConfig();
  return !!config.baseUrl;
}

function buildServiceUrl(pathname) {
  const config = getServiceConfig();
  if (!config.baseUrl) {
    throw new Error("BACKEND_NOT_CONFIGURED");
  }

  return `${config.baseUrl.replace(/\/$/, "")}${pathname}`;
}

function getServiceHeaders() {
  const config = getServiceConfig();
  return config.token
    ? {
      Authorization: `Bearer ${config.token}`,
    }
    : {};
}

function requestHealthCheck() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: buildServiceUrl("/health"),
      method: "GET",
      header: getServiceHeaders(),
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response);
          return;
        }

        reject(response.data || new Error("HEALTH_CHECK_FAILED"));
      },
      fail: reject,
    });
  });
}

module.exports = {
  getServiceConfig,
  saveServiceConfig,
  clearServiceConfig,
  hasBackendService,
  getMiniProgramEnvVersion,
  shouldAllowManualServiceConfig,
  buildServiceUrl,
  getServiceHeaders,
  requestHealthCheck,
};
