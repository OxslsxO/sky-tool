const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");

const MAX_BASE64_FILE_SIZE = 200 * 1024 * 1024;

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const fsm = wx.getFileSystemManager();
      
      const readFileDirectly = () => {
        fsm.readFile({
          filePath,
          encoding: "base64",
          success: (result) => {
            if (!result || !result.data) {
              reject(new Error("读取结果为空，请重试"));
              return;
            }
            resolve(result.data);
          },
          fail: (readErr) => {
            const errMsg = (readErr && readErr.errMsg) || "读取文件失败";
            reject(new Error(`读取文件失败：${errMsg} (文件路径: ${filePath})`));
          },
        });
      };

      try {
        fsm.getFileInfo({
          filePath,
          success: (info) => {
            if (info.size > MAX_BASE64_FILE_SIZE) {
              reject(new Error("文件过大，无法读取（超过200MB），请使用上传方式处理"));
              return;
            }
            readFileDirectly();
          },
          fail: () => {
            readFileDirectly();
          },
        });
      } catch (apiErr) {
        try {
          wx.getFileInfo({
            filePath,
            success: (info) => {
              if (info.size > MAX_BASE64_FILE_SIZE) {
                reject(new Error("文件过大，无法读取（超过200MB），请使用上传方式处理"));
                return;
              }
              readFileDirectly();
            },
            fail: () => {
              readFileDirectly();
            },
          });
        } catch (fallbackErr) {
          readFileDirectly();
        }
      }
    } catch (fatalErr) {
      reject(new Error(`文件处理失败：${(fatalErr && fatalErr.message) || "未知错误"}`));
    }
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

        const error = new Error(
          (response.data && (response.data.message || response.data.error)) ||
          `REMOTE_REQUEST_FAILED:${response.statusCode}`
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

function downloadRemoteFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res);
          return;
        }
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      },
      fail: (err) => {
        let message = "文件下载失败，请检查网络连接或后端服务";
        let code = "NETWORK_ERROR";
        
        // 检测是否是文件大小限制问题
        if (err && err.errMsg) {
          if (err.errMsg.indexOf("exceed") > -1 || err.errMsg.indexOf("max") > -1) {
            message = "文件过大，超过小程序下载限制，请直接访问下载链接";
            code = "FILE_TOO_LARGE";
          }
        }
        
        const error = new Error(message);
        error.code = code;
        error.downloadUrl = url;
        reject(error);
      },
    });
  });
}

function uploadFileForJson(pathname, file, formData = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: buildServiceUrl(pathname),
      filePath: file.path,
      name: "file",
      timeout: options.timeout || 600000,
      header: {
        ...getServiceHeaders(),
      },
      formData: {
        ...(formData || {}),
        fileName: file.name || "",
        sizeBytes: String(file.size || 0),
      },
      success: (response) => {
        let data = null;
        try {
          data = response.data ? JSON.parse(response.data) : null;
        } catch (error) {
          reject(new Error("INVALID_UPLOAD_RESPONSE"));
          return;
        }

        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(data);
          return;
        }

        reject(data || new Error("REMOTE_UPLOAD_FAILED"));
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || "";
        let message = "文件上传失败，请检查后端服务是否启动";
        let code = "NETWORK_ERROR";

        if (errMsg.indexOf("exceed") > -1 || errMsg.indexOf("too large") > -1) {
          message = "文件过大，超过上传限制";
          code = "FILE_TOO_LARGE";
        } else if (errMsg.indexOf("timeout") > -1 || errMsg.indexOf("超时") > -1) {
          message = "上传超时，请检查网络后重试";
          code = "UPLOAD_TIMEOUT";
        } else if (errMsg) {
          message = errMsg;
        }

        const error = new Error(message);
        error.code = code;
        reject(error);
      },
    });

    if (task && task.onProgressUpdate && typeof options.onProgressUpdate === "function") {
      task.onProgressUpdate(options.onProgressUpdate);
    }
  });
}

function downloadFileToTemp(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.tempFilePath);
          return;
        }
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      },
      fail: (err) => {
        reject(new Error((err && err.errMsg) || "文件下载失败"));
      },
    });
  });
}

async function packLocalFile(file) {
  let filePath = file.path;
  
  if (filePath && (filePath.startsWith("http://") || filePath.startsWith("https://"))) {
    try {
      filePath = await downloadFileToTemp(filePath);
    } catch (downloadErr) {
      throw new Error(`下载图片失败：${downloadErr.message}`);
    }
  }

  return {
    name: file.name,
    sizeBytes: file.size || 0,
    base64: await readFileBase64(filePath),
  };
}

async function uploadLocalFile(file, options = {}) {
  const response = await requestJson("/api/files/upload", {
    file: {
      name: file.name,
      sizeBytes: file.size || 0,
      base64: await readFileBase64(file.path),
      contentType: options.contentType || file.contentType || "application/octet-stream",
      extension: options.extension || file.extension || "",
    },
    folder: options.folder || "client-outputs",
    contentType: options.contentType || file.contentType || "application/octet-stream",
    baseName: options.baseName || "",
  });

  return response.file || null;
}

module.exports = {
  readFileBase64,
  requestJson,
  downloadRemoteFile,
  uploadFileForJson,
  packLocalFile,
  uploadLocalFile,
};
