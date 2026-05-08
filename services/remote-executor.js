const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");

const MAX_BASE64_FILE_SIZE = 200 * 1024 * 1024;

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const fsm = wx.getFileSystemManager();
      
      console.log("[readFileBase64] 开始读取文件，路径:", filePath);
      
      // 直接读取，不做多余的检查
      fsm.readFile({
        filePath: filePath,
        encoding: "base64",
        success: (result) => {
          if (result && result.data) {
            console.log("[readFileBase64] 读取成功，数据长度:", result.data.length);
            resolve(result.data);
          } else {
            console.error("[readFileBase64] 读取结果为空");
            reject(new Error("读取结果为空，请重试"));
          }
        },
        fail: (readErr) => {
          console.error("[readFileBase64] 读取失败:", readErr);
          
          // 检查是否是微信临时文件路径问题
          const errMsg = readErr && readErr.errMsg ? readErr.errMsg : "";
          console.error("[readFileBase64] 错误详情:", errMsg);
          
          // 给一个清晰的错误信息
          reject(new Error(`文件读取失败，请重新选择文件。错误: ${errMsg || '未知错误'}`));
        }
      });
    } catch (fatalErr) {
      console.error("[readFileBase64] 发生致命错误:", fatalErr);
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

async function uploadFileForJson(pathname, file, formData = {}, options = {}) {
  const readablePath = await ensureReadablePath(file.path);
  const uploadUrl = /^https?:\/\//i.test(pathname) ? pathname : buildServiceUrl(pathname);
  console.log("[uploadFileForJson] 准备上传，URL:", uploadUrl, "文件:", file.name, "路径:", readablePath);
  
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: uploadUrl,
      filePath: readablePath,
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
        console.log("[uploadFileForJson] 上传成功，响应状态:", response.statusCode);
        
        let data = null;
        try {
          data = response.data ? JSON.parse(response.data) : null;
        } catch (error) {
          console.error("[uploadFileForJson] 解析响应失败:", error);
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
        console.error("[uploadFileForJson] 上传失败:", err);
        
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
        reject(new Error((err && err.errMsg) || "文件下载失败"));
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
        reject(new Error((err && err.errMsg) || "文件下载失败"));
      },
    });
  });
}

async function ensureReadablePath(filePath) {
  if (!filePath) return filePath;

  if (filePath.startsWith("http://tmp/") || filePath.startsWith("wxfile://")) {
    try {
      const saveRes = await new Promise((resolve, reject) => {
        wx.getFileSystemManager().saveFile({
          tempFilePath: filePath,
          success: resolve,
          fail: reject,
        });
      });
      return saveRes.savedFilePath;
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
  console.log("[packLocalFile] 开始打包文件:", file.name);
  const filePath = await ensureReadablePath(file.path);
  console.log("[packLocalFile] 确保路径完成:", filePath);
  const base64 = await readFileBase64(filePath);
  console.log("[packLocalFile] 读取 base64 完成");

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

module.exports = {
  readFileBase64,
  requestJson,
  downloadRemoteFile,
  uploadFileForJson,
  uploadMultipleFilesForJson,
  packLocalFile,
  uploadLocalFile,
  ensureReadablePath,
};
