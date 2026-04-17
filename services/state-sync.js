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

        reject(response.data || new Error("SERVICE_REQUEST_FAILED"));
      },
      fail: reject,
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
