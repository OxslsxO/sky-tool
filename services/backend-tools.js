const STORAGE_KEY = "sky_tools_backend_service";
const { resolveServiceConfig } = require("./service-config-resolver");
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

function getDefaultBaseUrl() {
  //return "https://oxslsxo-sky-tool.hf.space";
  return "http://127.0.0.1:3100";
  //return "https://intercounty-distastefully-shanelle.ngrok-free.dev"
}

function shouldAllowManualServiceConfig() {
  const envVersion = getMiniProgramEnvVersion();
  if (envVersion === "develop" || envVersion === "trial") {
    return true;
  }

  return false;
}

function getServiceConfig() {
  try {
    const envVersion = getMiniProgramEnvVersion();
    let stored = {};
    try {
      stored = wx.getStorageSync(STORAGE_KEY) || {};
    } catch (e) {
      console.warn("[backend-tools] Failed to read storage:", e);
    }
    
    return resolveServiceConfig({
      envVersion,
      defaultBaseUrl: getDefaultBaseUrl(),
      storedConfig: stored,
    });
  } catch (error) {
    console.warn("[backend-tools] getServiceConfig failed:", error);
    return {
      baseUrl: null,
      token: "",
    };
  }
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
  try {
    const config = getServiceConfig();
    if (!config || !config.baseUrl) {
      return false;
    }
    const baseUrl = config.baseUrl.toLowerCase().trim();
    const envVersion = getMiniProgramEnvVersion();
    
    // 开发模式下允许本地地址
    if (envVersion === "develop" || envVersion === "trial") {
      return true;
    }
    
    // 生产模式下禁止本地地址
    if (baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost")) {
      console.warn("[backend-tools] Local backend address detected, treating as unavailable in release");
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[backend-tools] hasBackendService check failed:", error);
    return false;
  }
}

function buildServiceUrl(pathname) {
  const config = getServiceConfig();
  if (!config || !config.baseUrl) {
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

        var error = new Error("HEALTH_CHECK_FAILED:" + response.statusCode);
        error.statusCode = response.statusCode;
        reject(error);
      },
      fail: reject,
    });
  });
}

function warmUpBackend(options) {
  var maxAttempts = (options && options.maxAttempts) || 6;
  var baseDelay = (options && options.baseDelay) || 5000;
  var attempt = 0;

  function tryWake() {
    attempt++;
    return requestHealthCheck()
      .then(function (res) {
        console.log("[backend-tools] backend awake (attempt " + attempt + ")");
        return { ok: true, attempt: attempt, data: res };
      })
      .catch(function (err) {
        var is403 = err && err.statusCode === 403;
        var isSleeping = is403 || (err && err.message && err.message.indexOf("403") > -1);
        if (isSleeping && attempt < maxAttempts) {
          var delay = baseDelay * attempt;
          console.log("[backend-tools] backend sleeping, retry " + attempt + "/" + maxAttempts + " in " + delay + "ms");
          return new Promise(function (r) { setTimeout(r, delay); }).then(tryWake);
        }
        console.warn("[backend-tools] warmUp failed after " + attempt + " attempts:", err);
        return { ok: false, attempt: attempt, error: err };
      });
  }

  if (!hasBackendService()) {
    return Promise.resolve({ ok: false, attempt: 0, error: "BACKEND_NOT_CONFIGURED" });
  }

  return tryWake();
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
  warmUpBackend,
};
