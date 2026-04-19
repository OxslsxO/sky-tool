const {
  buildServiceUrl,
  getServiceHeaders,
  hasBackendService,
} = require("./backend-tools");

function fetchToolUsageStats() {
  if (!hasBackendService()) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      stats: [],
    });
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: buildServiceUrl("/api/tools/usage"),
      method: "GET",
      header: getServiceHeaders(),
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data || {});
          return;
        }

        reject(response.data || new Error("TOOL_USAGE_STATS_FAILED"));
      },
      fail: reject,
    });
  });
}

module.exports = {
  fetchToolUsageStats,
};
