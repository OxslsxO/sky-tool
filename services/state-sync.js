const {
  buildServiceUrl,
  getServiceHeaders,
} = require("./backend-tools");

function requestService(method, pathname, data) {
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

        const error = new Error(
          (response.data && (response.data.message || response.data.error)) ||
          `SERVICE_REQUEST_FAILED:${response.statusCode}`
        );
        error.statusCode = response.statusCode;
        reject(error);
      },
      fail: (err) => {
        const error = new Error(
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
