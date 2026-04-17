const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: "base64",
      success: (result) => resolve(result.data),
      fail: reject,
    });
  });
}

function requestJson(pathname, data, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: buildServiceUrl(pathname),
      method: "POST",
      timeout: options.timeout || 90000,
      header: {
        "content-type": "application/json",
        ...getServiceHeaders(),
      },
      data,
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (options.includeMeta) {
            resolve({
              data: response.data,
              statusCode: response.statusCode,
              header: response.header || {},
            });
            return;
          }

          resolve(response.data);
          return;
        }

        reject(response.data || new Error("REMOTE_REQUEST_FAILED"));
      },
      fail: reject,
    });
  });
}

function downloadRemoteFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: resolve,
      fail: reject,
    });
  });
}

async function packLocalFile(file) {
  return {
    name: file.name,
    sizeBytes: file.size || 0,
    base64: await readFileBase64(file.path),
  };
}

module.exports = {
  readFileBase64,
  requestJson,
  downloadRemoteFile,
  packLocalFile,
};
