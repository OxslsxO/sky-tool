const {
  buildServiceUrl,
  getServiceHeaders,
  hasBackendService,
} = require("./backend-tools");

function fetchToolUsageStats(retryCount) {
  if (!hasBackendService()) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      stats: [],
    });
  }

  var maxRetries = 3;
  var attempt = retryCount || 0;

  return new Promise((resolve) => {
    wx.request({
      url: buildServiceUrl("/api/tools/usage"),
      method: "GET",
      header: getServiceHeaders(),
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data || {});
          return;
        }

        if (response.statusCode === 403 && attempt < maxRetries) {
          var delay = 5000 * (attempt + 1);
          console.log("[tool-usage] 403 retry " + (attempt + 1) + "/" + maxRetries + " in " + delay + "ms");
          setTimeout(function () {
            fetchToolUsageStats(attempt + 1).then(resolve);
          }, delay);
          return;
        }

        resolve({ ok: false, stats: [] });
      },
      fail: () => {
        resolve({ ok: false, stats: [] });
      },
    });
  });
}

module.exports = {
  fetchToolUsageStats,
};
