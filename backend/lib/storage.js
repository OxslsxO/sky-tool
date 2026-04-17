const fs = require("fs");
const path = require("path");
const qiniu = require("qiniu");

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

  function getPublicBaseUrl(req) {
    return config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
  }

  function buildLocalFileUrl(req, fileName) {
    return `${getPublicBaseUrl(req)}/files/${encodeURIComponent(fileName)}`;
  }

  function buildQiniuFileUrl(req, key) {
    if (!qiniuOptions.privateBucket) {
      return qiniuBucketManager.publicDownloadUrl(qiniuOptions.publicBaseUrl, key);
    }

    return `${getPublicBaseUrl(req)}/files/qiniu?key=${encodeURIComponent(key)}`;
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

  function getQiniuDownloadUrl(key) {
    if (!qiniuOptions.privateBucket) {
      return qiniuBucketManager.publicDownloadUrl(qiniuOptions.publicBaseUrl, key);
    }

    const expiresSeconds = Number.isFinite(qiniuOptions.downloadExpiresSeconds)
      ? qiniuOptions.downloadExpiresSeconds
      : 3600;
    const deadline = Math.floor(Date.now() / 1000) + expiresSeconds;
    return qiniuBucketManager.privateDownloadUrl(qiniuOptions.publicBaseUrl, key, deadline);
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
    const response = await fetch(getQiniuDownloadUrl(key));

    if (!response.ok) {
      return null;
    }

    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "",
      contentLength: response.headers.get("content-length") || "",
    };
  }

  async function saveBuffer(req, buffer, options) {
    const folder = options.folder || "outputs";
    const fileName = options.fileName;
    const extension = options.extension || "bin";
    const normalizedFileName = fileName || `${Date.now()}.${extension}`;
    const contentType = options.contentType || "application/octet-stream";

    if (qiniuEnabled) {
      const key = createKey(folder, normalizedFileName);
      await putQiniuObject({
        key,
        body: buffer,
        contentType,
      });

      return {
        provider: "qiniu",
        fileName: normalizedFileName,
        key,
        sizeBytes: buffer.length,
        url: buildQiniuFileUrl(req, key),
      };
    }

    const filePath = path.join(config.outputDir, normalizedFileName);
    fs.writeFileSync(filePath, buffer);

    return {
      provider: "local",
      fileName: normalizedFileName,
      filePath,
      sizeBytes: buffer.length,
      url: buildLocalFileUrl(req, normalizedFileName),
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

  return {
    saveBuffer,
    readRemoteObject,
    cleanupExpiredLocalOutputs,
    getHealth,
  };
}

module.exports = {
  createStorage,
};
