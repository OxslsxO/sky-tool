const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");

const MAX_BASE64_FILE_SIZE = 200 * 1024 * 1024;

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    const fsm = wx.getFileSystemManager();
    let hasResolved = false;
    
    const timeoutId = setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        reject(new Error("文件读取超时"));
      }
    }, 60000);
    
    fsm.readFile({
      filePath: filePath,
      encoding: "base64",
      success: (result) => {
        clearTimeout(timeoutId);
        if (hasResolved) return;
        hasResolved = true;
        if (result && result.data) {
          resolve(result.data);
        } else {
          reject(new Error("读取结果为空，请重试"));
        }
      },
      fail: (readErr) => {
        clearTimeout(timeoutId);
        if (hasResolved) return;
        hasResolved = true;
        const errMsg = readErr && readErr.errMsg ? readErr.errMsg : "";
        reject(new Error(`文件读取失败，请重新选择文件。错误: ${errMsg || '未知错误'}`));
      }
    });
  });
}

function isRetryableNetworkError(errMsg) {
  if (!errMsg) return false;
  const retryableKeywords = [
    "TLS",
    "socket disconnected",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "network error",
    "网络",
    "getaddrinfo",
    "ETIMEDOUT",
    "EPIPE",
    "broken pipe",
    "SSL",
    "CERT",
  ];
  const lower = errMsg.toLowerCase();
  return retryableKeywords.some((kw) => lower.indexOf(kw.toLowerCase()) > -1);
}

async function requestJson(pathname, data, options = {}) {
  const maxRetries = options.maxRetries != null ? options.maxRetries : 2;
  const retryDelay = options.retryDelay || 1500;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay * attempt));
    }

    try {
      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: buildServiceUrl(pathname),
          method: options.method || "POST",
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
            const errMsg = (err && err.errMsg) || "";
            const error = new Error(
              errMsg || "网络请求失败，请检查后端服务是否启动"
            );
            error.code = "NETWORK_ERROR";
            error.errMsg = errMsg;
            reject(error);
          },
        });
      });

      return result;
    } catch (error) {
      lastError = error;
      const errMsg = error.errMsg || error.message || "";
      const canRetry = isRetryableNetworkError(errMsg) && attempt < maxRetries;
      if (!canRetry) {
        break;
      }
    }
  }

  throw lastError;
}

async function downloadRemoteFile(url, options = {}) {
  const maxRetries = options.maxRetries != null ? options.maxRetries : 2;
  const retryDelay = options.retryDelay || 1500;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay * attempt));
    }

    try {
      const result = await new Promise((resolve, reject) => {
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

            if (err && err.errMsg) {
              if (err.errMsg.indexOf("exceed") > -1 || err.errMsg.indexOf("max") > -1) {
                message = "文件过大，超过小程序下载限制，请直接访问下载链接";
                code = "FILE_TOO_LARGE";
              } else if (err.errMsg.indexOf("domain list") > -1 || err.errMsg.indexOf("not in domain") > -1) {
                code = "DOMAIN_NOT_ALLOWED";
              }
            }

            const error = new Error(message);
            error.code = code;
            error.downloadUrl = url;
            error.errMsg = (err && err.errMsg) || "";
            reject(error);
          },
        });
      });

      return result;
    } catch (error) {
      lastError = error;
      if (error.code === "DOMAIN_NOT_ALLOWED") {
        try {
          const reqRes = await new Promise((resolve, reject) => {
            wx.request({
              url,
              method: "GET",
              responseType: "arraybuffer",
              timeout: 120000,
              success: (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                  resolve(res);
                } else {
                  reject(new Error(`下载失败: HTTP ${res.statusCode}`));
                }
              },
              fail: (err) => {
                reject(new Error(`下载失败: ${(err && err.errMsg) || "网络错误"}`));
              },
            });
          });
          const extMatch = /\.([A-Za-z0-9]+)(\?|$)/.exec(url || "");
          const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : ".bin";
          const destPath = `${wx.env.USER_DATA_PATH}/_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
          const fs = wx.getFileSystemManager();
          fs.writeFileSync(destPath, reqRes.data);
          return { tempFilePath: destPath, statusCode: 200 };
        } catch (reqError) {
          throw reqError;
        }
      }
      const errMsg = error.errMsg || error.message || "";
      const canRetry = isRetryableNetworkError(errMsg) && error.code !== "FILE_TOO_LARGE" && attempt < maxRetries;
      if (!canRetry) {
        break;
      }
    }
  }

  throw lastError;
}

async function uploadFileForJson(pathname, file, formData = {}, options = {}) {
  const uploadUrl = /^https?:\/\//i.test(pathname) ? pathname : buildServiceUrl(pathname);
  const maxRetries = options.maxRetries != null ? options.maxRetries : 3;
  const retryDelay = options.retryDelay || 2000;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay * attempt));
    }

    try {
      const result = await new Promise((resolve, reject) => {
        const task = wx.uploadFile({
          url: uploadUrl,
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
            error.errMsg = errMsg;
            reject(error);
          },
        });

        if (task && task.onProgressUpdate && typeof options.onProgressUpdate === "function") {
          task.onProgressUpdate(options.onProgressUpdate);
        }
      });

      return result;
    } catch (error) {
      lastError = error;
      const errMsg = error.errMsg || error.message || "";
      const canRetry = isRetryableNetworkError(errMsg) && attempt < maxRetries;
      if (!canRetry) {
        break;
      }
    }
  }

  throw lastError;
}

async function uploadMultipleFilesForJson(pathname, files, formData = {}, options = {}) {
  const results = [];
  for (const file of files) {
    try {
      const result = await uploadFileForJson(pathname, file, formData, options);
      if (result && result.files && result.files.length > 0) {
        results.push(...result.files);
      } else {
        results.push({
          name: file.name,
          sizeBytes: file.size || 0,
          pageCount: 0,
        });
      }
    } catch (err) {
      console.error("Failed to upload file:", err);
      results.push({
        name: file.name,
        sizeBytes: file.size || 0,
        pageCount: 0,
      });
    }
  }
  return { ok: true, files: results };
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
        const errMsg = (err && err.errMsg) || "";
        if (errMsg.indexOf("domain list") > -1 || errMsg.indexOf("not in domain") > -1) {
          wx.request({
            url,
            method: "GET",
            responseType: "arraybuffer",
            timeout: 120000,
            success: (reqRes) => {
              if (reqRes.statusCode >= 200 && reqRes.statusCode < 300) {
                const extMatch = /\.([A-Za-z0-9]+)(\?|$)/.exec(url || "");
                const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : ".bin";
                const destPath = `${wx.env.USER_DATA_PATH}/_tmp_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
                const fs = wx.getFileSystemManager();
                fs.writeFileSync(destPath, reqRes.data);
                resolve(destPath);
              } else {
                reject(new Error(`下载失败: HTTP ${reqRes.statusCode}`));
              }
            },
            fail: (reqErr) => {
              reject(new Error(`下载失败: ${(reqErr && reqErr.errMsg) || "网络错误"}`));
            },
          });
        } else {
          reject(new Error(errMsg || "文件下载失败"));
        }
      },
    });
  });
}

function downloadFileToUserData(url) {
  const extMatch = /\.([A-Za-z0-9]+)(\?|$)/.exec(url || "");
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : ".jpg";
  const destPath = `${wx.env.USER_DATA_PATH}/_tmp_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;

  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      filePath: destPath,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(destPath);
          return;
        }
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || "";
        if (errMsg.indexOf("domain list") > -1 || errMsg.indexOf("not in domain") > -1) {
          wx.request({
            url,
            method: "GET",
            responseType: "arraybuffer",
            timeout: 120000,
            success: (reqRes) => {
              if (reqRes.statusCode >= 200 && reqRes.statusCode < 300) {
                const fs = wx.getFileSystemManager();
                fs.writeFileSync(destPath, reqRes.data);
                resolve(destPath);
              } else {
                reject(new Error(`下载失败: HTTP ${reqRes.statusCode}`));
              }
            },
            fail: (reqErr) => {
              reject(new Error(`下载失败: ${(reqErr && reqErr.errMsg) || "网络错误"}`));
            },
          });
        } else {
          reject(new Error(errMsg || "文件下载失败"));
        }
      },
    });
  });
}

async function ensureReadablePath(filePath) {
  if (!filePath) return filePath;

  if (filePath.startsWith("http://tmp/") || filePath.startsWith("wxfile://")) {
    try {
      return await new Promise((resolve, reject) => {
        let hasResolved = false;
        const timeoutId = setTimeout(() => {
          if (!hasResolved) {
            hasResolved = true;
            resolve(filePath);
          }
        }, 10000);
        
        wx.getFileSystemManager().saveFile({
          tempFilePath: filePath,
          success: (saveRes) => {
            clearTimeout(timeoutId);
            if (hasResolved) return;
            hasResolved = true;
            resolve(saveRes.savedFilePath);
          },
          fail: () => {
            clearTimeout(timeoutId);
            if (hasResolved) return;
            hasResolved = true;
            resolve(filePath);
          },
        });
      });
    } catch (saveErr) {
      return filePath;
    }
  }

  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    try {
      const tempPath = await downloadFileToTemp(filePath);
      return tempPath;
    } catch (downloadErr) {
      throw new Error(`下载图片失败：${downloadErr.message}`);
    }
  }

  return filePath;
}

async function packLocalFile(file) {
  const filePath = await ensureReadablePath(file.path);
  const base64 = await readFileBase64(filePath);

  return {
    name: file.name,
    sizeBytes: file.size || 0,
    base64: base64,
  };
}

async function uploadLocalFile(file, options = {}) {
  const filePath = await ensureReadablePath(file.path);
  const response = await requestJson("/api/files/upload", {
    file: {
      name: file.name,
      sizeBytes: file.size || 0,
      base64: await readFileBase64(filePath),
      contentType: options.contentType || file.contentType || "application/octet-stream",
      extension: options.extension || file.extension || "",
    },
    folder: options.folder || "client-outputs",
    contentType: options.contentType || file.contentType || "application/octet-stream",
    baseName: options.baseName || "",
  });

  return response.file || null;
}

function safeDownloadFile(url, options = {}) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      timeout: options.timeout || 120000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res);
        } else {
          reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        }
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || "";
        if (errMsg.indexOf("domain list") > -1 || errMsg.indexOf("not in domain") > -1) {
          wx.request({
            url,
            method: "GET",
            responseType: "arraybuffer",
            timeout: options.timeout || 120000,
            success: (reqRes) => {
              if (reqRes.statusCode >= 200 && reqRes.statusCode < 300) {
                const extMatch = /\.([A-Za-z0-9]+)(\?|$)/.exec(url || "");
                const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : ".bin";
                const destPath = `${wx.env.USER_DATA_PATH}/_safe_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
                const fs = wx.getFileSystemManager();
                fs.writeFileSync(destPath, reqRes.data);
                resolve({ tempFilePath: destPath, statusCode: 200 });
              } else {
                reject(new Error(`下载失败: HTTP ${reqRes.statusCode}`));
              }
            },
            fail: (reqErr) => {
              reject(new Error(`下载失败: ${(reqErr && reqErr.errMsg) || "网络错误"}`));
            },
          });
        } else {
          reject(new Error(errMsg || "文件下载失败"));
        }
      },
    });
  });
}

module.exports = {
  readFileBase64,
  requestJson,
  downloadRemoteFile,
  safeDownloadFile,
  uploadFileForJson,
  uploadMultipleFilesForJson,
  packLocalFile,
  uploadLocalFile,
  ensureReadablePath,
};
