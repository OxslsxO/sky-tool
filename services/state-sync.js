const {
  buildServiceUrl,
  getServiceHeaders,
} = require("./backend-tools");

function requestService(method, pathname, data, retryCount) {
  var maxRetries = 3;
  var attempt = retryCount || 0;

  return new Promise((resolve, reject) => {
    wx.request({
      url: buildServiceUrl(pathname),
      method,
      header: {
        "content-type": "application/json",
        ...getServiceHeaders(),
      },
      data,
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }

        var error = new Error(
          (response.data && (response.data.message || response.data.error)) ||
          `SERVICE_REQUEST_FAILED:${response.statusCode}`
        );
        error.statusCode = response.statusCode;

        if (response.statusCode === 403 && attempt < maxRetries) {
          var delay = 5000 * (attempt + 1);
          console.log("[state-sync] 403 retry " + (attempt + 1) + "/" + maxRetries + " in " + delay + "ms");
          setTimeout(function () {
            requestService(method, pathname, data, attempt + 1)
              .then(resolve)
              .catch(reject);
          }, delay);
          return;
        }

        reject(error);
      },
      fail: (err) => {
        var error = new Error(
          (err && err.errMsg) || "网络请求失败，请检查后端服务是否启动"
        );
        error.code = "NETWORK_ERROR";
        reject(error);
      },
    });
  });
}

function buildQueryString(params) {
  const pairs = Object.keys(params || {})
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);

  return pairs.length ? `?${pairs.join("&")}` : "";
}

function fetchClientState(identity) {
  return requestService("GET", `/api/client/state${buildQueryString(identity)}`);
}

function syncClientState(payload) {
  return requestService("POST", "/api/client/state/sync", payload);
}

module.exports = {
  fetchClientState,
  syncClientState,
};
