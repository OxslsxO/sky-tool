const fs = require("fs");
const path = require("path");
const qiniu = require("qiniu");
const { resolvePublicBaseUrl } = require("./public-base-url");

function buildQiniuDownloadBaseUrls(publicBaseUrl, bucketDomains) {
  const urls = [];
  const seen = new Set();

  function push(url) {
    const normalized = String(url || "").trim().replace(/\/$/, "");
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    urls.push(normalized);
  }

  const normalizedPublicBaseUrl = String(publicBaseUrl || "").trim().replace(/\/$/, "");
  const usesQiniuS3Endpoint = /(^https?:\/\/)?[^/]+\.qiniucs\.com$/i.test(normalizedPublicBaseUrl);

  if (usesQiniuS3Endpoint) {
    (bucketDomains || []).forEach((item) => {
      const domain = String(item && item.domain ? item.domain : "").trim().replace(/^https?:\/\//i, "");
      if (!domain) {
        return;
      }
      push(`http://${domain}`);
      push(`https://${domain}`);
    });
  }

  push(normalizedPublicBaseUrl);
  return urls;
}

function createStorage(config) {
  const qiniuOptions = config.qiniu || {};
  const qiniuEnabled = Boolean(
    qiniuOptions.accessKey &&
    qiniuOptions.secretKey &&
    qiniuOptions.bucket &&
    qiniuOptions.publicBaseUrl
  );

  const qiniuMac = qiniuEnabled
    ? new qiniu.auth.digest.Mac(qiniuOptions.accessKey, qiniuOptions.secretKey)
    : null;
  const qiniuConfig = qiniuEnabled ? createQiniuConfig(qiniuOptions) : null;
  const qiniuUploader = qiniuEnabled ? new qiniu.form_up.FormUploader(qiniuConfig) : null;
  const qiniuBucketManager = qiniuEnabled ? new qiniu.rs.BucketManager(qiniuMac, qiniuConfig) : null;
  let cachedBucketDomains = null;

  function getPublicBaseUrl(req) {
    const requestBaseUrl = req ? `${req.protocol}://${req.get("host")}` : "";
    return resolvePublicBaseUrl(config.publicBaseUrl, requestBaseUrl);
  }

  function buildLocalFileUrl(req, fileName) {
    return `${getPublicBaseUrl(req)}/output-files/${encodeURIComponent(fileName)}`;
  }

  function buildQiniuFileUrl(req, key, fileName) {
    const query = [
      `key=${encodeURIComponent(key)}`,
      fileName ? `fallback=${encodeURIComponent(fileName)}` : "",
    ].filter(Boolean).join("&");
    return `${getPublicBaseUrl(req)}/output-files/qiniu?${query}`;
  }

  function buildQiniuExternalUrl(key) {
    return qiniuBucketManager.publicDownloadUrl(qiniuOptions.publicBaseUrl, key);
  }

  function createKey(folder, fileName) {
    const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    return [qiniuOptions.prefix, folder, datePrefix, fileName].filter(Boolean).join("/");
  }

  function createQiniuConfig(qiniuOptions) {
    const sdkConfig = new qiniu.conf.Config({
      useHttpsDomain: true,
    });

    if (qiniuOptions.region) {
      sdkConfig.regionsProvider = qiniu.httpc.Region.fromRegionId(qiniuOptions.region);
    }

    return sdkConfig;
  }

  function getQiniuSignedDownloadUrl(baseUrl, key) {
    const expiresSeconds = Number.isFinite(qiniuOptions.downloadExpiresSeconds)
      ? qiniuOptions.downloadExpiresSeconds
      : 3600;
    const deadline = Math.floor(Date.now() / 1000) + expiresSeconds;
    try {
      return qiniuBucketManager.privateDownloadUrl(baseUrl, key, deadline);
    } catch (error) {
      console.warn("[storage] failed to build qiniu download url", error);
      return "";
    }
  }

  async function listQiniuBucketDomains() {
    if (!qiniuEnabled) {
      return [];
    }
    if (cachedBucketDomains) {
      return cachedBucketDomains;
    }

    cachedBucketDomains = await new Promise((resolve) => {
      qiniuBucketManager.listBucketDomains(qiniuOptions.bucket, (error, body) => {
        if (error || !Array.isArray(body)) {
          if (error) {
            console.warn("[storage] failed to list qiniu bucket domains", error);
          }
          resolve([]);
          return;
        }
        resolve(body);
      });
    });

    return cachedBucketDomains;
  }

  async function putQiniuObject({ key, body, contentType }) {
    const putPolicy = new qiniu.rs.PutPolicy({
      scope: `${qiniuOptions.bucket}:${key}`,
    });
    const uploadToken = putPolicy.uploadToken(qiniuMac);
    const putExtra = new qiniu.form_up.PutExtra(null, null, contentType);

    return qiniuUploader.put(uploadToken, key, body, putExtra);
  }

  async function getQiniuObject(key) {
    const bucketDomains = await listQiniuBucketDomains();
    const baseUrls = buildQiniuDownloadBaseUrls(qiniuOptions.publicBaseUrl, bucketDomains);

    for (const baseUrl of baseUrls) {
      const downloadUrl = getQiniuSignedDownloadUrl(baseUrl, key);
      if (!downloadUrl) {
        continue;
      }

      let response;
      try {
        response = await fetch(downloadUrl);
      } catch (error) {
        console.warn("[storage] qiniu download failed, trying next candidate", {
          baseUrl,
          message: error && error.message ? error.message : String(error),
        });
        continue;
      }

      if (!response.ok) {
        continue;
      }

      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "",
        contentLength: response.headers.get("content-length") || "",
      };
    }

    return null;
  }

  async function saveBuffer(req, buffer, options) {
    const folder = options.folder || "outputs";
    const fileName = options.fileName;
    const extension = options.extension || "bin";
    const normalizedFileName = fileName || `${Date.now()}.${extension}`;
    const contentType = options.contentType || "application/octet-stream";

    const filePath = path.join(config.outputDir, normalizedFileName);
    fs.writeFileSync(filePath, buffer);

    if (qiniuEnabled) {
      try {
        const key = createKey(folder, normalizedFileName);
        await putQiniuObject({
          key,
          body: buffer,
          contentType,
        });

        return {
          provider: "qiniu",
          fileName: normalizedFileName,
          filePath,
          key,
          sizeBytes: buffer.length,
          url: buildQiniuFileUrl(req, key, normalizedFileName),
          externalUrl: buildQiniuExternalUrl(key),
          fallbackUrl: buildLocalFileUrl(req, normalizedFileName),
        };
      } catch (error) {
        console.warn("[storage] qiniu upload failed, falling back to local storage", error);
        // 七牛云上传失败，降级到本地存储
      }
    }

    return {
      provider: "local",
      fileName: normalizedFileName,
      filePath,
      sizeBytes: buffer.length,
      url: buildLocalFileUrl(req, normalizedFileName),
      fallbackUrl: buildLocalFileUrl(req, normalizedFileName),
    };
  }

  async function readRemoteObject(key) {
    if (!qiniuEnabled) {
      return null;
    }

    return getQiniuObject(key);
  }

  function cleanupExpiredLocalOutputs() {
    const ttlMs = config.fileTtlHours * 60 * 60 * 1000;
    const now = Date.now();
    let deleted = 0;

    if (!fs.existsSync(config.outputDir)) {
      return deleted;
    }

    fs.readdirSync(config.outputDir).forEach((fileName) => {
      const filePath = path.join(config.outputDir, fileName);
      const stat = fs.statSync(filePath);

      if (!stat.isFile()) {
        return;
      }

      if (now - stat.mtimeMs > ttlMs) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    });

    return deleted;
  }

  function getHealth() {
    return {
      provider: qiniuEnabled ? "qiniu" : "local",
      qiniuEnabled,
      bucket: qiniuEnabled ? qiniuOptions.bucket : "",
      region: qiniuEnabled ? qiniuOptions.region : "",
      privateBucket: qiniuEnabled ? qiniuOptions.privateBucket : false,
    };
  }

  async function cleanupExpiredQiniuObjects(daysOld = 7) {
    if (!qiniuEnabled || !qiniuBucketManager) {
      console.warn('[storage] Qiniu not configured, skipping cleanup');
      return { deleted: 0, skipped: 0, error: 'Qiniu not configured' };
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    console.log(`[storage] Starting Qiniu cleanup for files older than ${daysOld} days (before ${cutoffDate.toISOString()})`);

    let deletedCount = 0;
    let skippedCount = 0;
    let marker = null;
    const prefixToCheck = qiniuOptions.prefix || '';

    try {
      do {
        const listResult = await new Promise((resolve, reject) => {
          const options = {
            prefix: prefixToCheck,
            marker: marker,
            limit: 1000,
          };
          qiniuBucketManager.listPrefix(qiniuOptions.bucket, options, (err, respBody, respInfo) => {
            if (err) {
              reject(err);
              return;
            }
            if (respInfo && respInfo.statusCode !== 200) {
              reject(new Error(`listPrefix returned status ${respInfo.statusCode}: ${JSON.stringify(respBody)}`));
              return;
            }
            resolve({ body: respBody, info: respInfo });
          });
        });

        const items = listResult.body && listResult.body.items ? listResult.body.items : [];
        if (items.length === 0) {
          break;
        }

        const keysToDelete = [];
        for (const item of items) {
          const putTime = item.putTime ? new Date(item.putTime / 10000) : null;
          if (putTime && putTime < cutoffDate) {
            keysToDelete.push(item.key);
          } else {
            skippedCount++;
          }
        }

        if (keysToDelete.length > 0) {
          const deleteOps = keysToDelete.map(key => qiniu.rs.deleteOp(qiniuOptions.bucket, key));
          const batchSize = 50;
          for (let i = 0; i < deleteOps.length; i += batchSize) {
            const batch = deleteOps.slice(i, i + batchSize);
            try {
              await new Promise((resolve, reject) => {
                qiniuBucketManager.batch(batch, (err, respBody, respInfo) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  let batchDeleted = 0;
                  if (Array.isArray(respBody)) {
                    for (const item of respBody) {
                      if (item.code === 200 || item.code === 612) {
                        batchDeleted++;
                      }
                    }
                  }
                  deletedCount += batchDeleted;
                  resolve();
                });
              });
            } catch (batchErr) {
              console.warn(`[storage] Batch delete failed, falling back to single delete:`, batchErr.message);
              for (const key of keysToDelete.slice(i, i + batchSize)) {
                try {
                  await new Promise((resolve, reject) => {
                    qiniuBucketManager.delete(qiniuOptions.bucket, key, (err, respBody, respInfo) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve();
                      }
                    });
                  });
                  deletedCount++;
                } catch (singleErr) {
                  console.error(`[storage] Failed to delete ${key}:`, singleErr.message);
                }
              }
            }
          }
        }

        marker = listResult.body.marker;
      } while (marker);

      console.log(`[storage] Qiniu cleanup completed. Deleted ${deletedCount} files, skipped ${skippedCount} recent files.`);
      return { deleted: deletedCount, skipped: skippedCount, success: true };
    } catch (error) {
      console.error('[storage] Qiniu cleanup failed:', error.message);
      return { deleted: deletedCount, skipped: skippedCount, error: error.message };
    }
  }

  return {
    saveBuffer,
    readRemoteObject,
    cleanupExpiredLocalOutputs,
    cleanupExpiredQiniuObjects,
    getHealth,
  };
}

module.exports = {
  createStorage,
  buildQiniuDownloadBaseUrls,
};
