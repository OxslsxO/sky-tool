require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

console.log("🚀 sky-toolbox-backend 正在启动...");

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

const http = require("http");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");
const { shouldInlineCompressedFile } = require("./lib/file-compress-response");
const { resolvePublicBaseUrl } = require("./lib/public-base-url");
const { parseMultipartRequest } = require("./lib/multipart");

let Pay = null;
try {
  Pay = require("wechatpay-node-v3");
} catch (e) {
  console.warn("⚠️ wechatpay-node-v3 加载失败:", e.message);
}

let adobePdfServices = null;
try {
  adobePdfServices = require("@adobe/pdfservices-node-sdk");
} catch (e) {
  console.warn("⚠️ @adobe/pdfservices-node-sdk 加载失败:", e.message);
}

let tesseractWorker = null;
try {
  tesseractWorker = require("tesseract.js");
} catch (e) {
  console.warn("⚠️ tesseract.js 加载失败:", e.message);
}

let photoIdModule = null;
try {
  photoIdModule = require("./lib/photo-id");
} catch (e) {
  console.warn("⚠️ photo-id 模块加载失败:", e.message);
}

let ncmDecrypt = null;
try {
  ncmDecrypt = require("./lib/ncm-decrypt");
} catch (e) {
  console.warn("⚠️ NCM 解密模块加载失败:", e.message);
}

// ==================== 工具函数 ====================
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== 微信支付初始化 ====================
let wechatPay = null;

function resolveWechatPemSource(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const looksLikePath = /^[A-Za-z]:[\\/]|^\.\.?[\\/]|^\//.test(raw);
  if (looksLikePath && fs.existsSync(raw)) {
    return fs.readFileSync(raw, "utf8").trim();
  }

  return raw;
}

function normalizeWechatPem(value, fallbackLabel) {
  const source = resolveWechatPemSource(value).replace(/\r/g, "").replace(/\\n/g, "\n").trim();
  if (!source) {
    return "";
  }

  const headerMatch = source.match(/-----BEGIN ([^-]+)-----/);
  const label = headerMatch ? headerMatch[1].trim() : fallbackLabel;
  const beginMarker = `-----BEGIN ${label}-----`;
  const endMarker = `-----END ${label}-----`;

  const body = source
    .replace(beginMarker, "")
    .replace(endMarker, "")
    .replace(/\s+/g, "");

  const lines = body.match(/.{1,64}/g);
  if (!lines || !lines.length) {
    return source;
  }

  return `${beginMarker}\n${lines.join("\n")}\n${endMarker}`;
}

function initWechatPay() {
  try {
    const appId = process.env.WECHAT_APPID;
    const mchId = process.env.WECHAT_MCH_ID;
    const apiV3Key = process.env.WECHAT_API_V3_KEY;
    const serialNo = process.env.WECHAT_SERIAL_NO;
    const privateKeyPath = String(
      process.env.WECHAT_PRIVATE_KEY_PATH || process.env.WECHAT_KEY_PATH || ""
    ).trim();
    const publicKeyPath = String(
      process.env.WECHAT_PUBLIC_KEY_PATH || process.env.WECHAT_CERT_PATH || ""
    ).trim();
    const privateKey = privateKeyPath && fs.existsSync(privateKeyPath)
      ? privateKeyPath
      : process.env.WECHAT_PRIVATE_KEY;
    const publicKey = publicKeyPath && fs.existsSync(publicKeyPath)
      ? publicKeyPath
      : process.env.WECHAT_PUBLIC_KEY;

    if (!appId || !mchId || !apiV3Key || !serialNo || !privateKey || !publicKey) {
      console.error("WeChat Pay config is incomplete; real payment is unavailable");
      console.warn("   缺少的配置项:", {
        appId: !!appId,
        mchId: !!mchId,
        apiV3Key: !!apiV3Key,
        serialNo: !!serialNo,
        privateKey: !!privateKey,
        publicKey: !!publicKey,
      });
      return null;
    }

    try {
      const cleanedPrivateKey = normalizeWechatPem(privateKey, "PRIVATE KEY");
      const cleanedPublicKey = normalizeWechatPem(publicKey, "CERTIFICATE");

      crypto.createPrivateKey(cleanedPrivateKey);
      new crypto.X509Certificate(cleanedPublicKey);

      console.log("✅ 微信支付 PEM 格式校验通过");

      if (!Pay) {
        console.warn("⚠️ wechatpay-node-v3 模块未加载，跳过微信支付初始化");
        return null;
      }

      const wp = new Pay({
        appid: appId,
        mchid: mchId,
        serial_no: serialNo,
        publicKey: cleanedPublicKey,
        privateKey: cleanedPrivateKey,
        key: apiV3Key,
      });

      console.log("✅ 微信支付已初始化");
      return wp;
    } catch (e) {
      console.error("❌ 微信支付证书/密钥解析失败:", e && e.message ? e.message : e);
      console.error("   建议检查 .env 中的 WECHAT_PRIVATE_KEY / WECHAT_PUBLIC_KEY 是否为完整 PEM 或有效文件路径");
      return null;
    }
  } catch (error) {
    console.error("❌ 微信支付初始化失败:", error && error.message ? error.message : error);
    console.error("   错误详情:", error);
    return null;
  }
}

wechatPay = initWechatPay();

// ==================== 微信登录/手机号获取工具 ====================
let wechatAccessToken = null;
let wechatAccessTokenExpiresAt = 0;

async function getWechatAccessToken() {
  const appId = process.env.WECHAT_APPID;
  const appSecret = process.env.WECHAT_APPSECRET;

  if (!appId || !appSecret) {
    return null;
  }

  const now = Date.now();
  if (wechatAccessToken && now < wechatAccessTokenExpiresAt - 60000) {
    return wechatAccessToken;
  }

  try {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.access_token) {
      wechatAccessToken = data.access_token;
      wechatAccessTokenExpiresAt = now + data.expires_in * 1000;
      console.log("[WeChat] Access token 刷新成功");
      return wechatAccessToken;
    } else {
      console.error("[WeChat] 获取 access_token 失败:", data);
      return null;
    }
  } catch (e) {
    console.error("[WeChat] 获取 access_token 异常:", e);
    return null;
  }
}

async function wechatCode2Session(code) {
  const appId = process.env.WECHAT_APPID;
  const appSecret = process.env.WECHAT_APPSECRET;

  if (!appId || !appSecret) {
    console.warn("[WeChat] WECHAT_APPID 或 WECHAT_APPSECRET 未配置，使用模拟模式");
    return { openid: `mock_${crypto.randomBytes(8).toString('hex')}`, session_key: null };
  }

  try {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.openid) {
      console.log(`[WeChat] jscode2session 成功: openid=${data.openid}`);
      return data;
    } else {
      console.error("[WeChat] jscode2session 失败:", data);
      throw new Error(data.errmsg || 'jscode2session failed');
    }
  } catch (e) {
    console.error("[WeChat] jscode2session 异常:", e);
    throw e;
  }
}

async function wechatGetPhoneNumber(code) {
  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    console.warn("[WeChat] 获取手机号失败：access_token 未获取，使用模拟模式");
    return `138${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  }

  try {
    const url = `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${accessToken}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await resp.json();

    if (data.errcode === 0 && data.phone_info && data.phone_info.phoneNumber) {
      const phone = data.phone_info.phoneNumber;
      console.log("[WeChat] 获取手机号成功");
      return phone;
    } else {
      console.error("[WeChat] 获取手机号失败:", data);
      throw new Error(data.errmsg || 'getPhoneNumber failed');
    }
  } catch (e) {
    console.error("[WeChat] 获取手机号异常:", e);
    throw e;
  }
}

const { ensureLocalDirs, buildConfig } = require("./lib/config");
const { createStorage } = require("./lib/storage");
const { createOperationRepository } = require("./lib/repository");
const { createClientStateRepository } = require("./lib/client-state-repository");

ensureLocalDirs();

const config = buildConfig();
const storage = createStorage(config);
const repository = createOperationRepository(config);
const clientStateRepository = createClientStateRepository(config);

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use((req, res, next) => {
  req.requestId = makeId();
  req.startedAt = Date.now();
  res.setHeader("x-request-id", req.requestId);
  next();
});
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "sky-toolbox-backend",
    requestId: req.requestId,
  });
});

if (photoIdModule && process.env.PHOTO_ID_DISABLE_MODEL !== 'true') {
  const warmDelay = parseInt(process.env.PHOTO_ID_WARM_DELAY || '30', 10) * 1000;
  console.log(`⏳ 证件照模型将在 ${warmDelay / 1000}s 后延迟加载...`);
  setTimeout(() => {
    photoIdModule.warmPhotoIdModel(config)
      .then(() => {
        console.log("✅ 证件照模型预热完成");
      })
      .catch((error) => {
        console.warn("⚠️ 证件照模型预热失败（首次使用时会自动加载）:", error && error.message ? error.message : error);
      });
  }, warmDelay);
}

function makeId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getPublicBaseUrl(req) {
  const requestBaseUrl = req ? `${req.protocol}://${req.get("host")}` : "";
  return resolvePublicBaseUrl(config.publicBaseUrl, requestBaseUrl);
}

function normalizeExtension(extension) {
  return String(extension || "bin").replace(/^\./, "").toLowerCase() || "bin";
}

function sanitizeBaseName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createOutputFileName(extension, baseName, addRandomSuffix = true) {
  const normalizedExtension = normalizeExtension(extension);
  const safeBaseName = sanitizeBaseName(baseName);
  if (addRandomSuffix) {
    const suffix = makeId();
    return safeBaseName
      ? `${safeBaseName}-${suffix}.${normalizedExtension}`
      : `${suffix}.${normalizedExtension}`;
  } else {
    return safeBaseName
      ? `${safeBaseName}.${normalizedExtension}`
      : `${makeId()}.${normalizedExtension}`;
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress || "";
}

function getRequestSummary(req) {
  return {
    requestId: req.requestId,
    method: req.method,
    route: req.path,
    clientIp: getClientIp(req),
    durationMs: Date.now() - (req.startedAt || Date.now()),
  };
}

async function recordOperation(req, details) {
  try {
    await repository.record({
      ...getRequestSummary(req),
      ...details,
    });
  } catch (error) {
    console.error("failed to record operation", error);
  }
}

function sendError(res, status, code, message, extra) {
  res.status(status).json({
    ok: false,
    code,
    message,
    ...(extra || {}),
  });
}

function decodeBase64File(file) {
  if (!file || !file.base64) {
    const error = new Error("缺少文件内容");
    error.code = "MISSING_FILE_CONTENT";
    throw error;
  }

  const buffer = Buffer.from(file.base64, "base64");
  if (!buffer.length) {
    const error = new Error("文件内容为空或编码不正确");
    error.code = "INVALID_FILE_CONTENT";
    throw error;
  }

  return buffer;
}

function requireApiToken(req, res, next) {
  if (!config.apiToken) {
    next();
    return;
  }

  const authorization = req.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (token !== config.apiToken) {
    sendError(res, 401, "UNAUTHORIZED", "缺少有效的服务访问令牌");
    return;
  }

  next();
}

async function saveOutputFile(req, buffer, options) {
  const addRandomSuffix = options.addRandomSuffix !== false; // 默认添加随机后缀
  const stored = await storage.saveBuffer(req, buffer, {
    folder: options.folder || "outputs",
    fileName: createOutputFileName(options.extension, options.baseName, addRandomSuffix),
    extension: options.extension,
    contentType: options.contentType,
  });

  return stored;
}

function assertPdfFile(file) {
  const lowerName = String(file && file.name ? file.name : "").toLowerCase();
  if (!lowerName.endsWith(".pdf")) {
    const error = new Error("只支持 PDF 文件");
    error.code = "INVALID_PDF_FILE";
    throw error;
  }
}

function buildFileResponse(storedFile, mimeType, label, req) {
  const baseUrl = getPublicBaseUrl(req);
  let downloadUrl = "";
  if (baseUrl) {
    const params = new URLSearchParams({
      fileName: storedFile.fileName,
      provider: storedFile.provider,
    });
    if (storedFile.key) {
      params.append("key", storedFile.key);
    }
    downloadUrl = `${baseUrl}/api/tools/download?${params.toString()}`;
  }

  return {
    name: storedFile.fileName,
    url: downloadUrl || storedFile.url,
    sizeBytes: storedFile.sizeBytes,
    mimeType,
    label: label || storedFile.fileName,
    provider: storedFile.provider,
    key: storedFile.key || "",
    externalUrl: storedFile.externalUrl || "",
    fallbackUrl: storedFile.fallbackUrl || "",
    downloadUrl: downloadUrl,
  };
}

function getFallbackContentType(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return map[ext] || "application/octet-stream";
}

function sendLocalFallbackFile(req, res) {
  const fallbackName = String(req.query.fallback || "").trim();
  if (!fallbackName || path.basename(fallbackName) !== fallbackName) {
    return false;
  }

  const fallbackPath = path.join(config.outputDir, fallbackName);
  if (!fs.existsSync(fallbackPath) || !fs.statSync(fallbackPath).isFile()) {
    return false;
  }

  const body = fs.readFileSync(fallbackPath);
  res.setHeader("content-type", getFallbackContentType(fallbackName));
  res.setHeader("content-length", body.length);
  res.send(body);
  return true;
}

function parsePageRanges(rangeText, totalPages) {
  const ranges = String(rangeText || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!ranges.length) {
    const error = new Error("页码范围不能为空");
    error.code = "INVALID_PAGE_RANGE";
    throw error;
  }

  const pageIndexes = [];
  ranges.forEach((part) => {
    if (part.includes("-")) {
      const [startText, endText] = part.split("-");
      const start = Number(startText);
      const end = Number(endText);

      if (!start || !end || start > end) {
        const error = new Error(`无效的页码范围：${part}`);
        error.code = "INVALID_PAGE_RANGE";
        throw error;
      }

      for (let page = start; page <= end; page += 1) {
        pageIndexes.push(page - 1);
      }
      return;
    }
    const page = Number(part);
    if (!page) {
      const error = new Error(`无效的页码：${part}`);
      error.code = "INVALID_PAGE_RANGE";
      throw error;
    }

    pageIndexes.push(page - 1);
  });

  const unique = Array.from(new Set(pageIndexes)).filter(
    (pageIndex) => pageIndex >= 0 && pageIndex < totalPages
  );

  if (!unique.length) {
    const error = new Error("页码超出文档范围");
    error.code = "INVALID_PAGE_RANGE";
    throw error;
  }

  return unique.sort((left, right) => left - right);
}

function splitPagesByChunk(totalPages, chunkSize) {
  const groups = [];
  for (let start = 0; start < totalPages; start += chunkSize) {
    const pages = [];
    for (let page = start; page < Math.min(start + chunkSize, totalPages); page += 1) {
      pages.push(page);
    }
    groups.push(pages);
  }
  return groups;
}

function normalizeSplitMode(splitMode) {
  const label = String(splitMode || "");

  if (label.includes("2")) {
    return "every-2-pages";
  }

  if (label.includes("5")) {
    return "every-5-pages";
  }

  if (
    label.includes("范围") ||
    label.includes("page") ||
    label.includes("range") ||
    label.includes("按页码")
  ) {
    return "page-range";
  }

  return "all-pages";
}

function normalizeOcrLanguage(languageLabel) {
  const label = String(languageLabel || "").trim().toLowerCase();

  if (label === "eng" || label === "english" || label.includes("英文")) {
    return "eng";
  }

  if (label === "chi_sim" || label === "chinese" || label.includes("中文")) {
    return "chi_sim";
  }

  return "chi_sim+eng";
}

function getOcrPageSegMode(layoutLabel) {
  const label = String(layoutLabel || "").trim().toLowerCase();

  if (label.includes("表格") || label.includes("table")) {
    return "6";
  }

  if (label.includes("手写") || label.includes("sparse")) {
    return "11";
  }

  return "4";
}
function normalizeOcrLines(lines, fallbackText) {
  const normalized = (lines || [])
    .map((line) => {
      if (typeof line === "string") {
        return line.trim();
      }

      return String(line && line.text ? line.text : "").trim();
    })
    .filter(Boolean);

  if (normalized.length) {
    return normalized;
  }

  return String(fallbackText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function prepareOcrImageVariants(fileBuffer, layoutLabel) {
  const metadata = await sharp(fileBuffer).metadata();
  const sourceWidth = metadata.width || 0;
  const shouldUpscale = sourceWidth > 0 && sourceWidth < 1800;
  const targetWidth = shouldUpscale ? 1800 : Math.min(sourceWidth || 2400, 2600);

  const base = sharp(fileBuffer)
    .rotate()
    .resize({
      width: targetWidth,
      withoutEnlargement: !shouldUpscale,
    })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 0.8, m1: 0.7, m2: 1.6 });

  const variants = [
    {
      name: "clean",
      buffer: await base.clone().png().toBuffer(),
    },
  ];

  if (!String(layoutLabel || "").includes("手写")) {
    variants.push({
      name: "threshold",
      buffer: await base.clone().threshold(178).png().toBuffer(),
    });
  }

  variants.push({
    name: "original",
    buffer: fileBuffer,
  });

  return variants;
}

function scoreOcrResult(result) {
  const text = result && result.data && result.data.text ? result.data.text : "";
  const confidence = Number(result && result.data ? result.data.confidence : 0) || 0;
  const visibleLength = text.replace(/\s+/g, "").length;
  const cjkLength = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return confidence * 3 + visibleLength + cjkLength * 0.6;
}

let baiduOcrTokenCache = {
  token: "",
  expiresAt: 0,
};

function getBaiduOcrConfig() {
  return {
    apiKey: process.env.BAIDU_OCR_API_KEY || process.env.BAIDU_API_KEY || "",
    secretKey: process.env.BAIDU_OCR_SECRET_KEY || process.env.BAIDU_SECRET_KEY || "",
    endpoint: process.env.BAIDU_OCR_ENDPOINT || "https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic",
  };
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function isBaiduOcrConfigured() {
  const config = getBaiduOcrConfig();
  return Boolean(config.apiKey && config.secretKey);
}

async function getBaiduOcrAccessToken() {
  if (baiduOcrTokenCache.token && Date.now() < baiduOcrTokenCache.expiresAt) {
    return baiduOcrTokenCache.token;
  }

  const config = getBaiduOcrConfig();
  if (!config.apiKey || !config.secretKey) {
    return "";
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.apiKey,
    client_secret: config.secretKey,
  });

  const response = await fetch("https://aip.baidubce.com/oauth/2.0/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "百度 OCR access_token 获取失败");
  }

  const expiresIn = Number(data.expires_in || 2592000);
  baiduOcrTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
  };

  return baiduOcrTokenCache.token;
}

async function prepareBaiduOcrImage(fileBuffer) {
  let width = 2200;
  let quality = 92;
  let output = await sharp(fileBuffer)
    .rotate()
    .resize({
      width,
      withoutEnlargement: true,
    })
    .jpeg({
      quality,
      mozjpeg: true,
    })
    .toBuffer();

  while (output.length > 3.6 * 1024 * 1024 && width > 1000) {
    width = Math.round(width * 0.82);
    quality = Math.max(76, quality - 6);
    output = await sharp(fileBuffer)
      .rotate()
      .resize({
        width,
        withoutEnlargement: true,
      })
      .jpeg({
        quality,
        mozjpeg: true,
      })
      .toBuffer();
  }

  return output;
}

function normalizeBaiduOcrLines(data) {
  const words = Array.isArray(data && data.words_result) ? data.words_result : [];
  const lines = words
    .map((item) => String(item && item.words ? item.words : "").trim())
    .filter(Boolean);

  const paragraphs = Array.isArray(data && data.paragraphs_result) ? data.paragraphs_result : [];
  if (paragraphs.length) {
    const paragraphLines = paragraphs
      .map((paragraph) => {
        const indexes = paragraph && Array.isArray(paragraph.words_result_idx)
          ? paragraph.words_result_idx
          : [];
        return indexes
          .map((index) => lines[index])
          .filter(Boolean)
          .join("\n");
      })
      .filter(Boolean);

    if (paragraphLines.length) {
      return paragraphLines;
    }
  }

  return lines;
}

async function recognizeTextFromImageWithBaidu(file, languageLabel, layoutLabel) {
  const token = await getBaiduOcrAccessToken();
  const config = getBaiduOcrConfig();
  const fileBuffer = file?.buffer ? file.buffer : decodeBase64File(file);
  const imageBuffer = await prepareBaiduOcrImage(fileBuffer);
  const requestUrl = `${config.endpoint}?access_token=${encodeURIComponent(token)}`;
  const body = new URLSearchParams({
    image: imageBuffer.toString("base64"),
    paragraph: "true",
    probability: "true",
    detect_direction: "true",
  });

  const language = normalizeOcrLanguage(languageLabel);
  if (language === "eng") {
    body.set("language_type", "ENG");
  } else if (language === "chi_sim") {
    body.set("language_type", "CHN_ENG");
  } else {
    body.set("language_type", "CHN_ENG");
  }

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || data.error_code) {
    throw new Error(data.error_msg || data.error_description || `百度 OCR 调用失败 ${data.error_code || response.status}`);
  }

  const lines = normalizeBaiduOcrLines(data);
  const text = lines.join("\n");
  const words = Array.isArray(data.words_result) ? data.words_result : [];
  const probabilities = words
    .map((item) => item && item.probability && Number(item.probability.average))
    .filter((item) => Number.isFinite(item));
  const confidence = probabilities.length
    ? Math.round((probabilities.reduce((sum, item) => sum + item, 0) / probabilities.length) * 100)
    : 0;

  return {
    text,
    lines,
    confidence,
    variant: "baidu",
    provider: "baidu",
  };
}

function resolveSofficePath() {
  if (process.env.SOFFICE_PATH && fs.existsSync(process.env.SOFFICE_PATH)) {
    return process.env.SOFFICE_PATH;
  }

  if (process.platform === "win32") {
    const commonPaths = [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }

  try {
    const command = process.platform === "win32" ? "where soffice" : "which soffice";
    const result = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);

    return result || "";
  } catch (error) {
    return "";
  }
}

async function recognizeTextFromImage(file, languageLabel, layoutLabel) {
  if (isBaiduOcrConfigured()) {
    try {
      console.log("[OCR] using Baidu OCR", {
        endpoint: getBaiduOcrConfig().endpoint,
        apiKey: maskSecret(getBaiduOcrConfig().apiKey),
      });
      return await recognizeTextFromImageWithBaidu(file, languageLabel, layoutLabel);
    } catch (error) {
      console.warn("[OCR] 百度 OCR 调用失败，回退到 Tesseract:", error && error.message ? error.message : error);
    }
  }

  if (!tesseractWorker) {
    throw new Error("OCR 功能不可用：tesseract.js 未加载");
  }

  const fileBuffer = file?.buffer ? file.buffer : decodeBase64File(file);
  const variants = await prepareOcrImageVariants(fileBuffer, layoutLabel);
  const worker = await tesseractWorker.createWorker(normalizeOcrLanguage(languageLabel));

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: getOcrPageSegMode(layoutLabel),
      preserve_interword_spaces: "1",
    });

    let best = null;
    let bestVariant = "";

    for (const variant of variants) {
      const result = await worker.recognize(variant.buffer);
      if (!best || scoreOcrResult(result) > scoreOcrResult(best)) {
        best = result;
        bestVariant = variant.name;
      }
    }

    const text = best && best.data && best.data.text ? best.data.text : "";
    const lines = normalizeOcrLines(best && best.data ? best.data.lines : [], text);

    return {
      text,
      lines,
      confidence: best && best.data ? Math.round(Number(best.data.confidence || 0)) : 0,
      variant: bestVariant,
      provider: "tesseract",
    };
  } finally {
    await worker.terminate();
  }
}

function runSofficeConvert(sofficePath, inputFilePath, outputDir, outputFormat = "pdf", infilter = "") {
  return new Promise((resolve, reject) => {
    const args = ["--headless"];
    if (infilter) {
      args.push(`--infilter=${infilter}`);
    }
    args.push("--convert-to", outputFormat, "--outdir", outputDir, inputFilePath);
    console.log("[LibreOffice] 开始转换，命令:", sofficePath, args.join(" "));

    const env = { ...process.env };

    if (process.platform === "win32") {
      const sofficeDir = path.dirname(sofficePath);
      const libreOfficeRoot = path.dirname(sofficeDir);
      const shareDir = path.join(libreOfficeRoot, "share");
      const userProfileDir = path.join(libreOfficeRoot, "user");

      env.URE_BOOTSTRAP_PATH = path.join(sofficeDir, "fundamental.ini");
      env.PATH = `${sofficeDir};${env.PATH || ""}`;
      env.SOFFICE_USER_PROFILE = userProfileDir;
      env.SOFFICE_INSTALL_ROOT = libreOfficeRoot;
      console.log("[LibreOffice] 设置环境变量, sofficeDir:", sofficeDir, "libreOfficeRoot:", libreOfficeRoot);
    }

    let stderrOutput = "";
    let stdoutOutput = "";
    const child = spawn(sofficePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env
    });

    let timeoutId = setTimeout(() => {
      console.error("[LibreOffice] 转换超时，正在杀死进程...");
      child.kill("SIGKILL");
      reject(new Error("LibreOffice 转换超时 (超过 60 秒)"));
    }, 60000);

    child.stdout.on("data", (data) => {
      stdoutOutput += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      console.error("[LibreOffice] 启动错误:", err);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      console.log("[LibreOffice] 进程退出 code:", code);
      if (code !== 0) {
        console.error("[LibreOffice] stdout:", stdoutOutput);
        console.error("[LibreOffice] stderr:", stderrOutput);
        reject(new Error(`LibreOffice 转换失败 (code: ${code}): ${stderrOutput}`));
        return;
      }

      resolve();
    });
  });
}

function normalizeResponseBody(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  return Buffer.from([]);
}

function cleanupTempDir(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getUniversalCompressImageQuality(mode) {
  if (mode === "体积优先") {
    return 58;
  }

  if (mode === "质量优先") {
    return 84;
  }

  return 72;
}

function selectSmallerOutput(originalBytes, candidateBytes) {
  if (candidateBytes && candidateBytes.length > 0 && candidateBytes.length < originalBytes.length) {
    return {
      bytes: candidateBytes,
      compressed: true,
    };
  }

  return {
    bytes: originalBytes,
    compressed: false,
  };
}

app.get("/health", async (req, res) => {
  const sofficePath = resolveSofficePath();
  const ffmpegPath = resolveFfmpegPath();

  // 检查 photo-id 模型状态
  let photoIdModelStatus = 'disabled';
  if (process.env.PHOTO_ID_DISABLE_MODEL !== 'true') {
    try {
      const ort = require("onnxruntime-node");
      photoIdModelStatus = 'available';
    } catch (error) {
      photoIdModelStatus = 'unavailable';
    }
  }

  // 检查微信支付配置
  const wechatPayAvailable = wechatPay !== null;

  res.json({
    ok: true,
    service: "sky-toolbox-backend",
    date: new Date().toISOString(),
    requestId: req.requestId,
    publicBaseUrl: getPublicBaseUrl(req),
    authRequired: Boolean(config.apiToken),
    fileTtlHours: config.fileTtlHours,
    capabilities: {
      photoId: true,
      photoIdModel: photoIdModelStatus,
      pdfMerge: true,
      pdfSplit: true,
      pdfCompress: true,
      ocrImage: true,
      baiduOcr: isBaiduOcrConfigured(),
      officeToPdf: Boolean(sofficePath),
      pdfToWord: Boolean(sofficePath),
      audioConvert: Boolean(ffmpegPath),
    },
    storage: storage.getHealth(),
    repository: repository.getHealth(),
    clientState: clientStateRepository.getHealth(),
    office: {
      available: Boolean(sofficePath),
      path: sofficePath || "",
    },
    audio: {
      available: Boolean(ffmpegPath),
      path: ffmpegPath || "",
    },
    photoId: {
      modelStatus: photoIdModelStatus,
      modelDisabled: process.env.PHOTO_ID_DISABLE_MODEL === 'true',
      warmModelEnabled: isTruthyEnv(process.env.PHOTO_ID_WARM_MODEL),
    },
    wechatPay: {
      available: wechatPayAvailable,
      mchId: process.env.WECHAT_MCH_ID || "",
    },
  });
});

app.get("/output-files/qiniu", async (req, res, next) => {
  try {
    const { provider } = storage.getHealth();
    if (provider !== "qiniu") {
      sendError(res, 404, "QINIU_NOT_ENABLED", "当前服务未启用七牛云存储");
      return;
    }

    const key = String(req.query.key || "").trim();
    if (!key) {
      sendError(res, 400, "MISSING_QINIU_KEY", "缺少七牛云文件标识");
      return;
    }

    if (config.qiniu.prefix && !key.startsWith(`${config.qiniu.prefix}/`)) {
      sendError(res, 403, "INVALID_QINIU_KEY", "不允许访问当前文件");
      return;
    }

    if (sendLocalFallbackFile(req, res)) {
      return;
    }

    const object = await storage.readRemoteObject(key);
    if (!object) {
      sendError(res, 404, "FILE_NOT_FOUND", "文件不存在或已过期");
      return;
    }

    if (object.contentType) {
      res.setHeader("content-type", object.contentType);
    }

    if (object.contentLength) {
      res.setHeader("content-length", object.contentLength);
    }

    res.send(normalizeResponseBody(object.body));
  } catch (error) {
    if (sendLocalFallbackFile(req, res)) {
      return;
    }

    next(error);
  }
});

app.use("/output-files", express.static(config.outputDir));

app.use("/api", requireApiToken);

app.get("/api/tools/usage", async (req, res, next) => {
  try {
    const usage = await clientStateRepository.getToolUsageStats();
    const stats = usage.stats || [];
    res.json({
      ok: true,
      provider: usage.provider,
      totalUsageCount: stats.reduce((sum, item) => sum + item.count, 0),
      stats,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/tools/download", async (req, res, next) => {
  try {
    const { fileName, provider, key } = req.query;

    if (!fileName) {
      sendError(res, 400, "MISSING_FILE_NAME", "缺少文件名参数");
      return;
    }

    let fileBuffer = null;
    let contentType = "application/octet-stream";

    if (provider === "qiniu" && key) {
      try {
        const remoteObj = await storage.readRemoteObject(key);
        if (remoteObj) {
          fileBuffer = remoteObj.body;
          contentType = remoteObj.contentType || contentType;
        }
      } catch (error) {
        console.warn("[download] 七牛云读取失败，尝试本地 fallback:", error);
      }
    }

    if (!fileBuffer) {
      const localPath = path.join(config.outputDir, fileName);
      if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
        fileBuffer = fs.readFileSync(localPath);
        contentType = getFallbackContentType(fileName);
      }
    }

    if (!fileBuffer) {
      sendError(res, 404, "FILE_NOT_FOUND", "输出文件已不存在或已过期，请重新执行操作");
      return;
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader("Content-Length", fileBuffer.length);
    res.end(fileBuffer);
  } catch (error) {
    next(error);
  }
});

app.post("/api/photo-id", async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let file;
  let size;
  let background;
  let retouch;
  let inputBuffer;

  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 100 * 1024 * 1024);
      const uploadFile = uploadFiles.file;
      size = fields.size;
      background = fields.background;
      retouch = fields.retouch;

      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }

      inputBuffer = uploadFile.buffer;
      // 优先使用前端传递的fileName
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[照片转证件照] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("照片转证件照 multipart上传解析失败:", error);
      sendError(res, 400, "PHOTO_ID_FAILED", "文件上传失败");
      return;
    }
  } else {
    // 原有base64模式
    const data = req.body || {};
    file = data.file;
    size = data.size;
    background = data.background;
    retouch = data.retouch;
    inputBuffer = decodeBase64File(file);
  }

  try {
    if (!photoIdModule) {
      throw new Error("证件照功能不可用：photo-id 模块未加载");
    }

    const result = await photoIdModule.buildPhotoIdImage(config, inputBuffer, {
      size,
      background,
      retouch,
    });
    const originalFileName = file?.name || "photo-id";
    const baseNameWithoutExt = originalFileName.replace(/\.[^/.]+$/, "");
    const outputBaseName = baseNameWithoutExt ? `${baseNameWithoutExt}_证件照` : "photo-id";
    const output = await saveOutputFile(req, result.buffer, {
      extension: "png",
      contentType: "image/png",
      baseName: outputBaseName,
      addRandomSuffix: false,
    });

    await recordOperation(req, {
      toolId: "photo-id",
      status: "success",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      outputFiles: [
        {
          name: output.fileName,
          provider: output.provider,
          sizeBytes: output.sizeBytes,
        },
      ],
      meta: {
        size,
        background,
        retouch,
        width: result.width,
        height: result.height,
      },
    });

    const processingMs = Date.now() - (req.startedAt || Date.now());

    res.json({
      ok: true,
      resultType: "image",
      diagnostics: {
        requestId: req.requestId,
        processingMs,
      },
      headline: "证件照已生成",
      detail: `已按 ${size || "考试报名"} 输出新底色证件照。`,
      file: {
        ...buildFileResponse(output, "image/png", "证件照.png", req),
        inlineBase64: result.buffer.toString("base64"),
      },
      metaLines: [
        `规格 ${size || "考试报名"}`,
        `背景 ${background || "白底"}`,
        `修饰 ${retouch || "自然"}`,
        `尺寸 ${result.width} x ${result.height}`,
      ],
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "photo-id",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "PHOTO_ID_FAILED",
      errorMessage: error.message || "证件照生成失败",
      meta: {
        size,
        background,
        retouch,
      },
    });

    sendError(
      res,
      500,
      error.code || "PHOTO_ID_FAILED",
      error.message || "证件照生成失败"
    );
  }
});

app.post("/api/files/upload", async (req, res) => {
  const { file, folder, contentType, baseName } = req.body || {};

  try {
    const buffer = decodeBase64File(file);
    const lowerName = String(file && file.name ? file.name : "").toLowerCase();
    const extension = lowerName.includes(".")
      ? lowerName.split(".").pop()
      : String(file && file.extension ? file.extension : "bin").replace(/^\./, "");
    const mimeType = contentType || file && file.contentType || "application/octet-stream";
    const output = await saveOutputFile(req, buffer, {
      extension,
      contentType: mimeType,
      baseName: baseName || path.parse(file && file.name ? file.name : "upload").name,
      folder: folder || "client-outputs",
    });

    await recordOperation(req, {
      toolId: "client-file-upload",
      status: "success",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || buffer.length,
          },
        ]
        : [],
      outputFiles: [
        {
          name: output.fileName,
          provider: output.provider,
          sizeBytes: output.sizeBytes,
        },
      ],
      meta: {
        folder: folder || "client-outputs",
      },
    });

    res.json({
      ok: true,
      file: buildFileResponse(output, mimeType, undefined, req),
      metaLines: [`存储位置 ${output.provider === "qiniu" ? "七牛云" : "本地磁盘"}`],
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "client-file-upload",
      status: "failed",
      errorCode: error.code || "CLIENT_FILE_UPLOAD_FAILED",
      errorMessage: error.message || "客户端文件上传失败",
    });

    sendError(
      res,
      500,
      error.code || "CLIENT_FILE_UPLOAD_FAILED",
      error.message || "client file upload failed"
    );
  }
});

const PENDING_ORDERS_PATH = path.join(path.dirname(config.clientStatePath), "pending-orders.json");
const PENDING_ORDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizePendingOrderEntries(entries) {
  const now = Date.now();
  return (entries || []).filter((entry) => {
    if (!entry || !entry.orderId) {
      return false;
    }

    const updatedAt = Number(entry.updatedAt || entry.paidAt || entry.createdAt || 0);
    if (!updatedAt) {
      return false;
    }

    return now - updatedAt <= PENDING_ORDER_TTL_MS;
  });
}

function loadPendingOrdersFromDisk() {
  if (!fs.existsSync(PENDING_ORDERS_PATH)) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_ORDERS_PATH, "utf8"));
    const map = new Map();
    normalizePendingOrderEntries(parsed.orders).forEach((entry) => {
      const { orderId, ...order } = entry;
      map.set(orderId, order);
    });
    return map;
  } catch (error) {
    console.error("[payment] failed to load pending orders:", error && error.message ? error.message : error);
    return new Map();
  }
}

function savePendingOrdersToDisk(orderMap) {
  try {
    const orders = normalizePendingOrderEntries(
      Array.from(orderMap.entries()).map(([orderId, order]) => ({
        orderId,
        ...order,
      }))
    );
    fs.writeFileSync(
      PENDING_ORDERS_PATH,
      JSON.stringify({ orders }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[payment] failed to persist pending orders:", error && error.message ? error.message : error);
  }
}

async function persistPaidOrderToDatabase(orderId, order) {
  try {
    const collections = await clientStateRepository.getCollections();
    if (!collections) {
      console.warn("[payment] MongoDB not available, skipping database persistence for order:", orderId);
      return;
    }

    const userId = order.userId;
    if (!userId) {
      console.error("[payment] order has no userId, cannot persist:", orderId);
      return;
    }

    // 重要：先检查这个订单是否已经处理过，防止重复增加积分
    const existingOrder = await collections.orders.findOne({ userId, id: orderId });
    if (existingOrder && existingOrder.status === "paid") {
      console.log(`⚠️ 订单 ${orderId} 已经处理过了，跳过防止重复充值`);
      return;
    }

    const now = new Date().toISOString();

    const orderRecord = {
      id: orderId,
      type: order.type,
      itemId: order.itemId,
      provider: "wechat",
      status: "paid",
      amount: order.amount,
      productName: order.productName,
      transactionId: order.transactionId || "",
      paidAt: order.paidAt || Date.now(),
      createdAt: order.createdAt || Date.now(),
      updatedAt: now,
    };

    await collections.orders.updateOne(
      { userId, id: orderId },
      { $set: { ...orderRecord, userId } },
      { upsert: true }
    );
    console.log(`✅ 订单 ${orderId} 已写入 orders 集合`);

    const product = PRODUCTS[order.type]?.[order.itemId];
    if (product) {
      const pointsToAdd = (product.points || 0) + (product.bonusPoints || 0);

      if (order.type === "points" && pointsToAdd > 0) {
        const pointsRecord = {
          id: `pr_pay_${orderId}`,
          type: "recharge",
          title: `充值${product.points}积分`,
          change: pointsToAdd,
          packageId: order.itemId,
          price: order.amount,
          createdAt: Date.now(),
          updatedAt: now,
        };

        await collections.pointsRecords.updateOne(
          { userId, id: pointsRecord.id },
          { $set: { ...pointsRecord, userId } },
          { upsert: true }
        );
        console.log(`✅ 积分记录已写入 pointsRecords 集合, +${pointsToAdd}积分`);

        const updateResult = await collections.users.updateOne(
          { userId },
          { $inc: { points: pointsToAdd }, $set: { updatedAt: now } }
        );
        console.log(`✅ 用户 ${userId} 积分已增加 ${pointsToAdd}, matched: ${updateResult.matchedCount}, modified: ${updateResult.modifiedCount}`);
      }

      if (order.type === "tool") {
        const pointsRecord = {
          id: `pr_pay_${orderId}`,
          type: "purchase",
          title: `购买工具: ${product.name}`,
          change: 0,
          packageId: order.itemId,
          price: order.amount,
          createdAt: Date.now(),
          updatedAt: now,
        };

        await collections.pointsRecords.updateOne(
          { userId, id: pointsRecord.id },
          { $set: { ...pointsRecord, userId } },
          { upsert: true }
        );
        console.log(`✅ 工具购买记录已写入 pointsRecords 集合`);
      }
    }
  } catch (error) {
    console.error("[payment] failed to persist paid order to database:", error && error.message ? error.message : error);
  }
}

const pendingOrders = loadPendingOrdersFromDisk();

// 积分套餐配置和单次工具使用配置
const PRODUCTS = {
  points: {
    "p-10": { name: "10积分", price: 100, points: 10, bonusPoints: 1 },
    "p-20": { name: "20积分", price: 200, points: 20, bonusPoints: 3 },
    "p-30": { name: "30积分", price: 300, points: 30, bonusPoints: 5 },
    "p-50": { name: "50积分", price: 500, points: 50, bonusPoints: 10 },
    "p-200": { name: "200积分", price: 1800, points: 200, bonusPoints: 50 },
    "p-500": { name: "500积分", price: 4000, points: 500, bonusPoints: 150 },
  },
  tool: {
    "photo-id": { name: "证件照制作", price: 80, points: 8 },
    "image-compress": { name: "图片压缩", price: 40, points: 4 },
    "image-convert": { name: "图片格式转换", price: 30, points: 3 },
    "resize-crop": { name: "图片改尺寸", price: 40, points: 4 },
    "image-to-pdf": { name: "图片转PDF", price: 50, points: 5 },
    "universal-compress": { name: "万能压缩", price: 50, points: 5 },
    "pdf-compress": { name: "PDF压缩", price: 60, points: 6 },
    "pdf-merge": { name: "PDF合并", price: 50, points: 5 },
    "pdf-split": { name: "PDF拆分", price: 50, points: 5 },
    "office-to-pdf": { name: "Office转PDF", price: 90, points: 9 },
    "pdf-to-word": { name: "PDF转Word", price: 80, points: 8 },
    "ocr-text": { name: "OCR文字识别", price: 60, points: 6 },
    "qr-maker": { name: "二维码生成", price: 20, points: 2 },
    "unit-convert": { name: "单位换算", price: 10, points: 1 },
    "audio-convert": { name: "音视频格式转换", price: 40, points: 4 },
  },
};

// ==================== 异步任务管理器 ====================
const tasks = new Map();
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30分钟超时

function generateTaskId() {
  return `TASK-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function createTask(taskType, data = {}) {
  const taskId = generateTaskId();
  const task = {
    id: taskId,
    type: taskType,
    status: "pending", // pending, processing, completed, failed
    progress: 0, // 0-100
    statusText: "准备中...",
    result: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    data,
  };
  tasks.set(taskId, task);
  
  // 定期清理超时任务
  setTimeout(() => {
    if (tasks.has(taskId)) {
      const t = tasks.get(taskId);
      if (t.status === "pending" || t.status === "processing") {
        console.log(`[任务管理器] 清理超时任务: ${taskId}`);
        tasks.delete(taskId);
      }
    }
  }, TASK_TIMEOUT_MS);
  
  return task;
}

function updateTaskProgress(taskId, progress, statusText) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.progress = Math.max(0, Math.min(100, progress));
  if (statusText) task.statusText = statusText;
}

function updateTaskStatus(taskId, status, statusText) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.status = status;
  if (statusText) task.statusText = statusText;
  if (status === "processing" && !task.startedAt) {
    task.startedAt = Date.now();
  }
  if (status === "completed" || status === "failed") {
    task.completedAt = Date.now();
  }
}

function setTaskResult(taskId, result) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.result = result;
}

function setTaskError(taskId, error) {
  const task = tasks.get(taskId);
  if (!task) return;
  task.error = error;
}

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

// 任务状态查询 API
app.get("/api/tasks/:taskId", async (req, res) => {
  const taskId = req.params.taskId;
  const task = getTask(taskId);
  if (!task) {
    return res.status(404).json({ ok: false, error: "TASK_NOT_FOUND", message: "任务不存在" });
  }
  res.json({
    ok: true,
    task: {
      id: task.id,
      status: task.status,
      progress: task.progress,
      statusText: task.statusText,
      result: task.result,
      error: task.error,
    },
  });
});

/**
 * 通用的异步任务处理包装器
 * @param {Object} req 请求对象
 * @param {Object} res 响应对象
 * @param {string} taskType 任务类型
 * @param {Object} taskData 任务数据
 * @param {Function} processor 处理函数，接收 (taskId, taskData, updateFn)
 * @param {Object} options 选项
 */
async function createAsyncTask(req, res, taskType, taskData, processor, options = {}) {
  const task = createTask(taskType, taskData);
  
  // 立即返回 taskId
  res.json({
    ok: true,
    taskId: task.id,
    status: "pending",
  });
  
  // 后台执行任务
  process.nextTick(async () => {
    try {
      updateTaskStatus(task.id, "processing", options.initialStatusText || "准备处理...");
      updateTaskProgress(task.id, options.initialProgress || 5, options.initialStatusText || "初始化中...");
      
      // 提供进度更新函数给处理器
      const updateFn = (progress, statusText) => {
        updateTaskProgress(task.id, progress, statusText);
      };
      
      const result = await processor(task.id, taskData, updateFn);
      
      updateTaskStatus(task.id, "completed", options.completeStatusText || "处理完成");
      updateTaskProgress(task.id, 100, options.completeStatusText || "完成");
      setTaskResult(task.id, result);
      
    } catch (error) {
      console.error(`[AsyncTask] ${taskType} 处理失败:`, error);
      updateTaskStatus(task.id, "failed", error.message || "处理失败");
      setTaskError(task.id, error.message || "处理失败");
    }
  });
}

app.post("/api/pay/create", async (req, res) => {
  console.log(`[支付] 收到创建订单请求:`, req.body);
  
  const { type, itemId, userId, openid, deviceId } = req.body || {};

  if (!type || !itemId) {
    console.warn(`[支付] 缺少参数: type=${type}, itemId=${itemId}`);
    return res.status(400).json({ error: "MISSING_PARAMS", message: "缺少 type 或 itemId" });
  }

  if (!userId || !openid) {
    console.warn(`[支付] 缺少 userId 或 openid: userId=${userId}, openid=${openid}`);
    return res.status(400).json({ error: "MISSING_USER_ID", message: "缺少 userId 或 openid" });
  }

  const orderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const product = PRODUCTS[type]?.[itemId];

  if (!product) {
    console.warn(`[支付] 无效商品: type=${type}, itemId=${itemId}`);
    return res.status(400).json({ error: "INVALID_PRODUCT", message: "无效的商品" });
  }

  console.log(`[支付] 准备创建订单: orderId=${orderId}, product=${product.name}, price=${product.price}`);

  let payment = null;

  if (wechatPay) {
    try {
      console.log(`[支付] 尝试使用微信支付创建订单 ${orderId}`);
      
      const notifyUrl = `${process.env.PUBLIC_BASE_URL || "https://oxslsxo-sky-tool.hf.space"}/api/pay/notify`;
      
      const params = {
        appid: process.env.WECHAT_APPID,
        mchid: process.env.WECHAT_MCH_ID,
        description: product.name,
        out_trade_no: orderId,
        notify_url: notifyUrl,
        amount: {
          total: product.price,
          currency: "CNY",
        },
        payer: {
          openid,
        },
      };

      console.log(`[支付] 微信支付请求参数:`, { ...params, privateKey: '***' });
      
      const result = await wechatPay.transactions_jsapi(params);

      console.log(`[支付] 微信支付响应:`, result);

      if (result.status !== 200) {
        console.error("[支付] 预下单失败，状态码:", result.status);
        throw new Error(`创建订单失败: ${result.status}`);
      }

      console.log(`[支付] 预下单成功:`, result.data);
      
      // wechatpay-node-v3 已经在 data 里返回了签好名的小程序支付参数
      payment = result.data;

      console.log(`[支付] 返回小程序支付参数:`, payment);
    } catch (error) {
      console.error("❌ 微信支付创建订单失败:", error && error.message ? error.message : error);
      console.error("   完整错误:", error);
    }
  } else {
    console.error("[payment] wechatPay is not initialized; cannot create a real order");
  }

  if (!payment) {
    console.error("[payment] failed to create a real order; no usable payment payload returned");
    return res.status(503).json({
      error: "WECHAT_PAY_UNAVAILABLE",
      message: "WeChat Pay is unavailable. Check merchant config and backend logs.",
    });
  }

  pendingOrders.set(orderId, {
    type,
    itemId,
    userId,
    openid,
    deviceId,
    amount: product.price,
    productName: product.name,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  savePendingOrdersToDisk(pendingOrders);

  console.log(`[支付] 返回订单: orderId=${orderId}`);
  res.json({ orderId, payment });
});

app.post("/api/pay/verify", async (req, res) => {
  const { orderId } = req.body || {};

  if (!orderId) {
    return res.status(400).json({ error: "MISSING_ORDER_ID", message: "缺少 orderId" });
  }

  const order = pendingOrders.get(orderId);
  if (!order) {
    return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "订单不存在" });
  }

  let latestUser = null;
  
  if (wechatPay) {
    try {
      console.log(`[支付] 查询订单 ${orderId}`);
      const result = await wechatPay.query({ out_trade_no: orderId });

      if (result.status === 200 && (result.data.trade_state === "SUCCESS" || result.data.trade_state === "TRADE_SUCCESS")) {
        order.status = "paid";
        order.paidAt = Date.now();
        order.transactionId = result.data.transaction_id;
        order.updatedAt = Date.now();
        pendingOrders.set(orderId, order);
        savePendingOrdersToDisk(pendingOrders);
        console.log(`✅ 订单 ${orderId} 支付成功`);
        await persistPaidOrderToDatabase(orderId, order);
      } else {
        order.updatedAt = Date.now();
        pendingOrders.set(orderId, order);
        savePendingOrdersToDisk(pendingOrders);
        console.log(`[支付] 订单 ${orderId} 未支付:`, result.data);
      }
    } catch (error) {
      console.error("[支付] 查询订单失败:", error);
    }
  }

  // 获取最新的用户状态信息
  try {
    const collections = await clientStateRepository.getCollections();
    if (collections && order.userId) {
      latestUser = await collections.users.findOne({ userId: order.userId });
    }
  } catch (e) {
    console.warn("[支付] 获取用户状态失败", e);
  }

  res.json({
    success: true,
    orderId,
    status: order.status,
    paid: order.status === "paid",
    type: order.type,
    itemId: order.itemId,
    // 返回最新的用户状态给前端
    user: latestUser ? {
      userId: latestUser.userId,
      openid: latestUser.openid,
      nickname: latestUser.nickname,
      avatarUrl: latestUser.avatarUrl,
      avatar: latestUser.avatar,
      points: latestUser.points || 0,
      phoneNumber: latestUser.phoneNumber,
      updatedAt: latestUser.updatedAt
    } : null
  });
});

app.post("/api/pay/notify", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    if (!wechatPay) {
      console.error("[payment] pay notify received but wechatPay is not initialized");
      return res.status(503).json({ code: "FAIL", message: "wechat pay unavailable" });
    }

    console.log("[支付] 收到微信支付通知");

    const result = wechatPay.decipher_gcm(req.body);
    console.log("[支付] 解密通知结果:", result);

    if (result.trade_state === "SUCCESS" || result.trade_state === "TRADE_SUCCESS") {
      const orderId = result.out_trade_no;
      const order = pendingOrders.get(orderId);

      if (order) {
        order.status = "paid";
        order.paidAt = Date.now();
        order.transactionId = result.transaction_id;
        order.updatedAt = Date.now();
        pendingOrders.set(orderId, order);
        savePendingOrdersToDisk(pendingOrders);
        console.log(`✅ 订单 ${orderId} 支付成功 (transaction_id: ${result.transaction_id})`);
        await persistPaidOrderToDatabase(orderId, order);
      } else {
        console.warn(`[支付] 收到通知但未找到订单: ${orderId}`);
      }
    }

    res.json({ code: "SUCCESS", message: "" });
  } catch (error) {
    console.error("❌ 支付通知处理失败:", error && error.message ? error.message : error);
    res.status(500).json({ code: "FAIL", message: "失败" });
  }
});

// ==================== 登录 API ====================
app.post("/api/auth/login", async (req, res) => {
  const { code, userInfo } = req.body;

  if (!code) {
    sendError(res, 400, "MISSING_CODE", "Missing login code");
    return;
  }

  try {
    const wxResult = await wechatCode2Session(code);
    const openid = wxResult.openid;
    const collections = await clientStateRepository.getCollections();
    let user = null;
    let isNewUser = false;

    if (collections) {
      user = await collections.users.findOne({ openid });

      if (!user) {
        isNewUser = true;
        const now = new Date().toISOString();
        const avatarUrl = userInfo?.avatarUrl || "";
        const newUser = {
          userId: openid,
          openid,
          nickname: userInfo?.nickName || "微信用户",
          avatarUrl,
          avatar: avatarUrl,
          gender: userInfo?.gender || 0,
          points: 0,
          phoneNumber: "",
          authMode: "wechat",
          createdAt: now,
          updatedAt: now,
        };

        await collections.users.insertOne(newUser);
        user = newUser;
      }

      if (user) {
        const now = new Date().toISOString();
        const avatarUrl = userInfo?.avatarUrl || user.avatarUrl || user.avatar || "";

        await collections.users.updateOne(
          { openid },
          {
            $set: {
              updatedAt: now,
              nickname: userInfo?.nickName || user.nickname || "微信用户",
              avatarUrl,
              avatar: avatarUrl,
              authMode: "wechat",
            },
          }
        );

        user = await collections.users.findOne({ openid });
      }
    } else {
      const avatarUrl = userInfo?.avatarUrl || "";
      user = {
        userId: openid,
        openid,
        nickname: userInfo?.nickName || "微信用户",
        avatarUrl,
        avatar: avatarUrl,
        points: 0,
        phoneNumber: "",
        authMode: "wechat",
      };
    }

    await recordOperation(req, {
      toolId: "auth-login",
      status: "success",
      meta: { openid },
    });

    res.json({
      ok: true,
      isNewUser,
      user: {
        userId: user.userId,
        openid: user.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl || user.avatar || "",
        avatar: user.avatar || user.avatarUrl || "",
        points: user.points || 0,
        phoneNumber: user.phoneNumber || "",
        authMode: "wechat",
      },
    });
  } catch (error) {
    console.error("[Auth] 登录失败:", error);
    await recordOperation(req, {
      toolId: "auth-login",
      status: "failed",
      errorCode: error.code || "LOGIN_FAILED",
      errorMessage: error.message,
    });

    sendError(res, 500, "LOGIN_FAILED", "Login failed");
  }
});

app.get("/api/auth/me", async (req, res) => {
  const { userId } = req.query;

  try {
    const state = await clientStateRepository.getState({ userId });
    if (!state || !state.user) {
      sendError(res, 404, "USER_NOT_FOUND", "User not found");
      return;
    }

    res.json({
      ok: true,
      user: {
        userId: state.user.userId,
        openid: state.user.openid,
        nickname: state.user.nickname,
        avatar: state.user.avatar,
        points: state.user.points,
        phoneNumber: state.user.phoneNumber,
      },
    });
  } catch (error) {
    sendError(res, 500, "FETCH_FAILED", "Failed to fetch user");
  }
});

// ==================== 登录 API 结束 ====================

app.get("/api/client/state", async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  const deviceId = String(req.query.deviceId || "").trim();

  try {
    const state = await clientStateRepository.getState({
      userId,
      deviceId,
    });

    if (!state) {
      sendError(res, 404, "CLIENT_STATE_NOT_FOUND", "Client state was not found");
      return;
    }

    await recordOperation(req, {
      toolId: "client-state-fetch",
      status: "success",
      meta: {
        userId: state.user && state.user.userId ? state.user.userId : userId,
        deviceId: state.user && state.user.deviceId ? state.user.deviceId : deviceId,
        taskCount: (state.tasks || []).length,
      },
    });

    res.json({
      ok: true,
      state,
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "client-state-fetch",
      status: "failed",
      errorCode: error.code || "CLIENT_STATE_FETCH_FAILED",
      errorMessage: error.message || "Failed to fetch client state",
      meta: {
        userId,
        deviceId,
      },
    });

    sendError(
      res,
      500,
      error.code || "CLIENT_STATE_FETCH_FAILED",
      error.message || "Failed to fetch client state"
    );
  }
});

app.post("/api/client/state/sync", async (req, res) => {
  const payload = req.body || {};

  try {
    const state = await clientStateRepository.syncState({
      userId: payload.userId || payload.user && payload.user.userId || "",
      deviceId: payload.deviceId || payload.user && payload.user.deviceId || "",
      user: payload.user || {},
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      favorites: Array.isArray(payload.favorites) ? payload.favorites : [],
      recentToolIds: Array.isArray(payload.recentToolIds) ? payload.recentToolIds : [],
      pointsRecords: Array.isArray(payload.pointsRecords) ? payload.pointsRecords : [],
      orders: Array.isArray(payload.orders) ? payload.orders : [],
      preferRemote: parseBooleanFlag(payload.preferRemote),
    });

    await recordOperation(req, {
      toolId: "client-state-sync",
      status: "success",
      meta: {
        userId: state.user && state.user.userId ? state.user.userId : "",
        deviceId: state.user && state.user.deviceId ? state.user.deviceId : "",
        taskCount: (state.tasks || []).length,
        favoriteCount: (state.favorites || []).length,
        recentCount: (state.recentToolIds || []).length,
        pointsRecordCount: (state.pointsRecords || []).length,
        orderCount: (state.orders || []).length,
      },
    });

    res.json({
      ok: true,
      state,
      sync: {
        syncedAt: state.syncedAt,
        taskCount: (state.tasks || []).length,
        favoriteCount: (state.favorites || []).length,
        recentCount: (state.recentToolIds || []).length,
        pointsRecordCount: (state.pointsRecords || []).length,
        orderCount: (state.orders || []).length,
      },
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "client-state-sync",
      status: "failed",
      errorCode: error.code || "CLIENT_STATE_SYNC_FAILED",
      errorMessage: error.message || "Failed to sync client state",
      meta: {
        userId: payload.userId || payload.user && payload.user.userId || "",
        deviceId: payload.deviceId || payload.user && payload.user.deviceId || "",
      },
    });

    sendError(
      res,
      500,
      error.code || "CLIENT_STATE_SYNC_FAILED",
      error.message || "Failed to sync client state"
    );
  }
});



// 获取PDF信息（页数、基本信息）
app.post("/api/pdf/preview", async (req, res) => {
  // 检查是否是 multipart 上传
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const results = [];
      
      // 处理多个文件
      const uploadFiles = Array.isArray(files.file) ? files.file : [files.file];
      // 获取前端传递的文件名（可能有多个）
      const customFileNames = Array.isArray(fields.fileName) ? fields.fileName : [fields.fileName || ""];
      
      for (let i = 0; i < uploadFiles.length; i++) {
        const uploadFile = uploadFiles[i];
        const customFileName = customFileNames[i] || customFileNames[0] || "";
        try {
          if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
            results.push({
              name: customFileName || uploadFile?.fileName || "",
              sizeBytes: uploadFile?.sizeBytes || 0,
              pageCount: 0,
            });
            continue;
          }
          
          const pdfDoc = await PDFDocument.load(uploadFile.buffer);
          const pageCount = pdfDoc.getPageCount();
          const finalFileName = customFileName || uploadFile.fileName || "";
          console.log("[PDF预览] 接收到的文件名:", finalFileName);
          results.push({
            name: finalFileName,
            sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
            pageCount,
          });
        } catch (fileError) {
          console.error("Error processing PDF file:", fileError);
          results.push({
            name: customFileName || uploadFile?.fileName || "",
            sizeBytes: uploadFile?.sizeBytes || 0,
            pageCount: 0,
          });
        }
      }
      
      res.json({
        ok: true,
        files: results,
      });
    } catch (error) {
      console.error("PDF preview multipart error:", error);
      sendError(res, 400, "PDF_PREVIEW_FAILED", error.message || "PDF预览失败");
    }
    return;
  }
  
  // 原有 base64 模式
  const files = req.body.files || [];
  try {
    const results = [];
    for (const file of files) {
      try {
        // 检查文件是否有效
        if (!file || !file.base64) {
          results.push({
            name: file?.name || "",
            sizeBytes: file?.sizeBytes || 0,
            pageCount: 0,
          });
          continue;
        }
        
        assertPdfFile(file);
        const pdfBuffer = decodeBase64File(file);
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pageCount = pdfDoc.getPageCount();
        results.push({
          name: file.name || "",
          sizeBytes: file.sizeBytes || 0,
          pageCount,
        });
      } catch (fileError) {
        // 单个文件处理失败，不影响其他文件
        console.error("Error processing PDF file:", fileError);
        results.push({
          name: file?.name || "",
          sizeBytes: file?.sizeBytes || 0,
          pageCount: 0,
        });
      }
    }
    res.json({
      ok: true,
      files: results,
    });
  } catch (error) {
    console.error("PDF preview error:", error);
    sendError(res, 400, "PDF_PREVIEW_FAILED", error.message || "PDF预览失败");
  }
});

app.post("/api/pdf/merge", async (req, res) => {
  let files = [];
  const contentType = req.headers['content-type'] || '';
  let customFileNames = [];
  const { urls, names } = req.body || {};
  
  if (urls && Array.isArray(urls) && urls.length >= 2) {
    // URL 模式：后端去下载这些 URL 然后合并
    console.log("[PDF合并] URL 模式，需要下载的文件数量:", urls.length);
    const axios = require('axios');
    const pdfBuffers = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        pdfBuffers.push({
          buffer: Buffer.from(response.data),
          name: (names && names[i]) || `file${i + 1}.pdf`,
          sizeBytes: response.data.length || 0
        });
        console.log(`[PDF合并] 成功下载第 ${i + 1} 个文件`);
      } catch (downloadErr) {
        console.error(`[PDF合并] 下载 URL 失败: ${url}`, downloadErr);
      }
    }
    
    if (pdfBuffers.length < 2) {
      sendError(res, 400, "DOWNLOAD_FAILED", "下载文件失败，至少需要 2 份成功下载的 PDF");
      return;
    }
    
    files = pdfBuffers;
    // 标记这是 URL 模式
    res.locals.isUrlMode = true;
  } else if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const fileArray = Array.isArray(uploadFiles.file) ? uploadFiles.file : [uploadFiles.file];
      customFileNames = Array.isArray(fields.fileName) ? fields.fileName : [fields.fileName || ""];
      
      if (fileArray.length < 2) {
        sendError(res, 400, "INVALID_FILE_COUNT", "至少需要 2 份 PDF 文件");
        return;
      }
      
      files = fileArray.map((file, index) => ({
        name: customFileNames[index] || customFileNames[0] || file.fileName || "",
        sizeBytes: file.sizeBytes || file.buffer?.length || 0,
        buffer: file.buffer
      }));
    } catch (error) {
      console.error("PDF merge multipart error:", error);
      sendError(res, 400, "PDF_MERGE_FAILED", "文件处理失败");
      return;
    }
  } else {
    // 原有 base64 模式
    files = req.body.files || [];
    
    if (files.length < 2) {
      sendError(res, 400, "INVALID_FILE_COUNT", "至少需要 2 份 PDF 文件");
      return;
    }
  }

  try {
    const mergedPdf = await PDFDocument.create();
    let totalPages = 0;
    const inputFilesInfo = [];

    for (const file of files) {
      try {
        let pdfBuffer;
        if (res.locals.isUrlMode || contentType.includes('multipart/form-data')) {
          // URL 模式或者 multipart 模式
          pdfBuffer = file.buffer;
          inputFilesInfo.push({
            name: file.name,
            sizeBytes: file.sizeBytes
          });
        } else {
          // 原有 base64 模式
          assertPdfFile(file);
          pdfBuffer = decodeBase64File(file);
          inputFilesInfo.push({
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0
          });
        }
        
        const sourcePdf = await PDFDocument.load(pdfBuffer);
        const pageCount = sourcePdf.getPageCount();
        totalPages += pageCount;
        const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      } catch (fileError) {
        console.error("Error processing PDF file for merge:", fileError);
      }
    }

    if (totalPages === 0) {
      sendError(res, 400, "PDF_MERGE_FAILED", "未能成功处理任何 PDF 文件");
      return;
    }

    // 基于第一个文件的名称生成合并后的文件名
    const firstFileName = files[0]?.name || "";
    const baseNameWithoutExt = firstFileName.replace(/\.[^/.]+$/, "");
    const outputBaseName = baseNameWithoutExt ? `${baseNameWithoutExt}_merged` : "merged";
    console.log("[PDF合并] 接收到的第一个文件名:", firstFileName, "生成输出文件名:", outputBaseName);

    const bytes = await mergedPdf.save({ useObjectStreams: true });
    const output = await saveOutputFile(req, Buffer.from(bytes), {
      extension: "pdf",
      contentType: "application/pdf",
      baseName: outputBaseName,
      addRandomSuffix: false,
    });

    await recordOperation(req, {
      toolId: "pdf-merge",
      status: "success",
      inputFiles: inputFilesInfo,
      outputFiles: [
        {
          name: output.fileName,
          provider: output.provider,
          sizeBytes: output.sizeBytes,
        },
      ],
      meta: {
        inputCount: files.length,
        totalPages,
      },
    });

    res.json({
      ok: true,
      resultType: "document",
      headline: "PDF 合并已完成",
      detail: `已合并 ${files.length} 份 PDF 文档，可直接下载或继续处理。`,
      file: buildFileResponse(output, "application/pdf", undefined, req),
      metaLines: [
        `输入文件 ${files.length} 份`,
        `合并后 ${totalPages} 页`,
        `存储位置 ${output.provider === "qiniu" ? "七牛云" : "本地磁盘"}`,
      ],
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "pdf-merge",
      status: "failed",
      inputFiles: files.map((file) => ({
        name: file.name || "",
        sizeBytes: file.sizeBytes || 0,
      })),
      errorCode: error.code || "PDF_MERGE_FAILED",
      errorMessage: error.message || "PDF 合并失败",
    });

    sendError(res, 500, error.code || "PDF_MERGE_FAILED", error.message || "PDF 合并失败");
  }
});

app.post("/api/pdf/split", async (req, res) => {
  // 检查是否是 multipart 上传
  const contentType = req.headers['content-type'] || '';
  let file;
  let splitMode;
  let pageRange;
  let pdfBuffer;
  
  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const uploadFile = files.file;
      splitMode = fields.splitMode || "";
      pageRange = fields.pageRange || "1";
      
      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }
      
      pdfBuffer = uploadFile.buffer;
      // 优先使用前端传递的 fileName 字段，如果没有才用 uploadFile.fileName
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[PDF拆分] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("PDF拆分 multipart 上传解析失败:", error);
      sendError(res, 400, "PDF_SPLIT_FAILED", "文件上传失败");
      return;
    }
  } else {
    // 原有 base64 模式
    file = req.body.file;
    splitMode = req.body.splitMode || "";
    pageRange = req.body.pageRange || "1";
    assertPdfFile(file);
    pdfBuffer = decodeBase64File(file);
  }

  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = pdfDoc.getPageCount();
    const normalizedSplitMode = normalizeSplitMode(splitMode);
    
    // 从原文件名提取基础名称（不带扩展名）
    const originalFileName = file?.name || "document";
    const baseNameWithoutExt = originalFileName.replace(/\.[^/.]+$/, "");

    let groups = [];
    if (normalizedSplitMode === "page-range") {
      groups = [parsePageRanges(pageRange, totalPages)];
    } else if (normalizedSplitMode === "every-2-pages") {
      groups = splitPagesByChunk(totalPages, 2);
    } else if (normalizedSplitMode === "every-5-pages") {
      groups = splitPagesByChunk(totalPages, 5);
    } else {
      groups = [Array.from({ length: totalPages }, (_, index) => index)];
    }

    const outputs = [];
    for (let index = 0; index < groups.length; index += 1) {
      const pages = groups[index];
      const nextPdf = await PDFDocument.create();
      const copiedPages = await nextPdf.copyPages(pdfDoc, pages);
      copiedPages.forEach((page) => nextPdf.addPage(page));

      const bytes = await nextPdf.save({ useObjectStreams: true });
      
      // 生成有意义的文件名
      const pageLabel = pages.map(p => p + 1).join("-");
      const outputBaseName = groups.length > 1 
        ? `${baseNameWithoutExt}_part${index + 1}_pages${pageLabel}` 
        : `${baseNameWithoutExt}_pages${pageLabel}`;
        
      const output = await saveOutputFile(req, Buffer.from(bytes), {
        extension: "pdf",
        contentType: "application/pdf",
        baseName: outputBaseName,
        addRandomSuffix: false,
      });

      outputs.push(
        buildFileResponse(
          output,
          "application/pdf",
          `${baseNameWithoutExt} - 第 ${pages.map((page) => page + 1).join(", ")} 页`,
          req
        )
      );
    }

    await recordOperation(req, {
      toolId: "pdf-split",
      status: "success",
      inputFiles: [
        {
          name: file?.name || "",
          sizeBytes: file?.sizeBytes || 0,
        },
      ],
      outputFiles: outputs.map((item) => ({
        name: item.name,
        provider: item.provider,
        sizeBytes: item.sizeBytes,
      })),
      meta: {
        totalPages,
        splitMode: normalizedSplitMode,
        pageRange: normalizedSplitMode === "page-range" ? pageRange : "",
      },
    });

    res.json({
      ok: true,
      resultType: outputs.length === 1 ? "document" : "documents",
      headline: "PDF 拆分已完成",
      detail: `已拆分为 ${outputs.length} 份文档，可分别打开或下载。`,
      file: outputs[0],
      files: outputs,
      metaLines: [
        `总页数 ${totalPages}`,
        `拆分方式 ${splitMode || normalizedSplitMode}`,
      ],
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "pdf-split",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file?.name || "",
            sizeBytes: file?.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "PDF_SPLIT_FAILED",
      errorMessage: error.message || "PDF 拆分失败",
      meta: {
        splitMode,
        pageRange,
      },
    });

    sendError(res, 500, error.code || "PDF_SPLIT_FAILED", error.message || "PDF 拆分失败");
  }
});

app.post("/api/pdf/compress", async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let file;
  let mode;
  let pdfBuffer;
  
  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const uploadFile = uploadFiles.file;
      mode = fields.mode || "";
      
      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }
      
      pdfBuffer = uploadFile.buffer;
      // 优先使用前端传递的 fileName 字段
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[PDF压缩] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("PDF compress multipart error:", error);
      sendError(res, 400, "PDF_COMPRESS_FAILED", "文件处理失败");
      return;
    }
  } else {
    // 原有 base64 模式
    file = req.body.file;
    mode = req.body.mode || "";
    assertPdfFile(file);
    pdfBuffer = decodeBase64File(file);
  }

  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const bytes = await pdfDoc.save({ useObjectStreams: true });
    
    // 生成与原文件名关联的压缩文件名
    const originalFileName = file?.name || "document";
    const baseNameWithoutExt = originalFileName.replace(/\.[^/.]+$/, "");
    const output = await saveOutputFile(req, Buffer.from(bytes), {
      extension: "pdf",
      contentType: "application/pdf",
      baseName: `${baseNameWithoutExt}_compressed`,
      addRandomSuffix: false,
    });

    await recordOperation(req, {
      toolId: "pdf-compress",
      status: "success",
      inputFiles: [
        {
          name: file?.name || "",
          sizeBytes: file?.sizeBytes || 0,
        },
      ],
      outputFiles: [
        {
          name: output.fileName,
          provider: output.provider,
          sizeBytes: output.sizeBytes,
        },
      ],
      meta: {
        mode,
      },
    });

    res.json({
      ok: true,
      resultType: "document",
      headline: "PDF 基础优化已完成",
      detail: "已完成基础压缩优化，实际体积变化会受原文档结构影响。",
      file: buildFileResponse(output, "application/pdf", undefined, req),
      metaLines: [
        `压缩模式 ${mode || "默认"}`,
        "当前为基础优化版压缩",
      ],
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "pdf-compress",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "PDF_COMPRESS_FAILED",
      errorMessage: error.message || "PDF 压缩失败",
      meta: {
        mode,
      },
    });

    sendError(
      res,
      500,
      error.code || "PDF_COMPRESS_FAILED",
      error.message || "PDF 压缩失败"
    );
  }
});

async function buildFileCompressResponse(req, { fileName, sizeBytes, fileBytes, mode }) {
    let ext = normalizeExtension(fileName ? fileName.split('.').pop() : "bin");

    let outputBytes = fileBytes;
    let outputExt = ext;
    let compressed = false;
    let compressionNote = "当前文件未发现可进一步压缩的空间";
    
    // 添加文件大小检查
    const MAX_COMPRESS_SIZE = 20 * 1024 * 1024; // 20MB
    if (fileBytes.length > MAX_COMPRESS_SIZE) {
      console.log(`[compress] 文件过大 (${formatFileSize(fileBytes.length)})，直接返回原文件`);
      compressionNote = "文件过大，为避免处理超时已保留原文件";
      
      const output = await saveOutputFile(req, outputBytes, {
        extension: outputExt,
        baseName: fileName.includes('.') ? fileName.substring(0, fileName.lastIndexOf('.')) : "compressed",
      });

      const responseFile = buildFileResponse(output, "application/octet-stream", undefined, req);
      // 大文件绝对不内联
      responseFile.inlineBase64 = undefined;
      
      return {
        ok: true,
        resultType: "document",
        headline: "文件处理完成",
        detail: compressionNote,
        file: responseFile,
        compressed: false,
        beforeBytes: fileBytes.length,
        afterBytes: fileBytes.length,
        savedBytes: 0,
        savedPercent: 0,
        note: compressionNote,
        metaLines: [
          `文件类型 ${ext}`,
          `文件过大未压缩`,
        ],
      };
    }

    // 检测并处理 NCM 格式
    const isNcmMagic = fileBytes.slice(0, 8).toString("hex") === "4354454e";
    let isNcm = ext === "ncm" || isNcmMagic;

    if (isNcm && ncmDecrypt) {
      console.log("万能压缩：检测到 NCM 格式，先进行解密");
      const decryptResult = ncmDecrypt.decryptNcm(fileBytes);
      fileBytes = decryptResult.musicData;
      const detectedFormat = decryptResult.format || "mp3";
      outputExt = detectedFormat;
      ext = detectedFormat;
      compressionNote = "已将网易云音乐加密格式解密为 " + detectedFormat.toUpperCase();
      compressed = true;
    }

    // 根据文件类型进行不同的压缩处理
    if (ext === "pdf") {
      // PDF压缩 - 多种优化策略，包括图片压缩和元数据移除
      console.log("[compress] 开始处理PDF文件...");
      
      let bestOutput = fileBytes;
      let bestSize = fileBytes.length;
      let bestNote = "这个 PDF 已经比较紧凑，优化后体积没有明显下降";
      
      try {
        const pdfDoc = await PDFDocument.load(fileBytes);
        
        // 移除元数据（Producer、Creator、CreationDate等）
        pdfDoc.setProducer('');
        pdfDoc.setCreator('');
        pdfDoc.setTitle('');
        pdfDoc.setAuthor('');
        pdfDoc.setSubject('');
        pdfDoc.setKeywords([]);
        
        // 尝试1: 基础优化 + 对象流
        const optimized1 = Buffer.from(await pdfDoc.save({ 
          useObjectStreams: true 
        }));
        if (optimized1.length < bestSize) {
          bestOutput = optimized1;
          bestSize = optimized1.length;
          bestNote = "已完成 PDF 基础优化";
          console.log(`[compress] 基础优化: ${formatFileSize(fileBytes.length)} -> ${formatFileSize(optimized1.length)}`);
        }
        
        // 尝试2: 激进优化（根据压缩模式）
        let quality = 0.7; // 默认质量
        if (mode === "体积优先") quality = 0.5;
        else if (mode === "质量优先") quality = 0.9;
        
        // 尝试压缩PDF中的图片（使用pdf-lib + sharp）
        try {
          const pages = pdfDoc.getPages();
          let hasImages = false;
          
          // 由于pdf-lib处理嵌入图片比较复杂，我们尝试不同的保存选项
          const optimized2 = Buffer.from(await pdfDoc.save({ 
            useObjectStreams: true,
            addDefaultPage: false
          }));
          
          if (optimized2.length < bestSize) {
            bestOutput = optimized2;
            bestSize = optimized2.length;
            bestNote = "已完成 PDF 深度优化";
            console.log(`[compress] 深度优化: ${formatFileSize(fileBytes.length)} -> ${formatFileSize(optimized2.length)}`);
          }
        } catch (imgError) {
          console.warn("[compress] 图片优化跳过:", imgError.message);
        }
        
      } catch (e) {
        console.warn("[compress] PDF优化失败:", e.message);
      }
      
      outputBytes = bestOutput;
      compressed = bestSize < fileBytes.length;
      
      if (compressed) {
        const savedPercent = Math.round(((fileBytes.length - bestSize) / fileBytes.length) * 100);
        compressionNote = `${bestNote}，节省 ${savedPercent}% 体积`;
      } else {
        compressionNote = bestNote;
      }
      outputExt = "pdf";
    } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) {
      // Office文档处理 - 尝试压缩内部图片和优化
      console.log(`[compress] 处理Office文档: ${ext}`);
      
      const isModernOffice = ["docx", "xlsx", "pptx"].includes(ext);
      
      if (isModernOffice) {
        // 对于现代Office格式（ZIP结构），尝试重新压缩
        try {
          // 尝试使用adm-zip（如果可用）
          let AdmZip = null;
          try {
            AdmZip = require('adm-zip');
          } catch (e) {
            console.log("[compress] adm-zip 不可用，使用基础处理");
          }
          
          if (AdmZip) {
            const zip = new AdmZip(fileBytes);
            const zipEntries = zip.getEntries();
            
            let optimizedImages = 0;
            const newZip = new AdmZip();
            
            // 遍历所有文件
            for (const entry of zipEntries) {
              if (entry.isDirectory) {
                continue;
              }
              
              const entryName = entry.entryName;
              const content = zip.readFile(entryName);
              
              // 检查是否是图片文件
              const isImage = /\.(jpg|jpeg|png|gif|bmp|tiff|webp)$/i.test(entryName);
              
              if (isImage && content && content.length > 10 * 1024) { // 只处理大于10KB的图片
                try {
                  // 使用sharp压缩图片
                  let imageBuffer = content;
                  
                  // 根据压缩模式设置质量
                  let imgQuality = 80;
                  if (mode === "体积优先") imgQuality = 60;
                  else if (mode === "质量优先") imgQuality = 95;
                  
                  // 压缩图片
                  let compressedImg = await sharp(content)
                    .jpeg({ quality: imgQuality, mozjpeg: true })
                    .toBuffer();
                  
                  // 如果压缩后的图片更小，使用压缩版本
                  if (compressedImg.length < content.length) {
                    newZip.addFile(entryName, compressedImg);
                    optimizedImages++;
                    console.log(`[compress] 压缩图片: ${entryName} - ${formatFileSize(content.length)} -> ${formatFileSize(compressedImg.length)}`);
                  } else {
                    newZip.addFile(entryName, content);
                  }
                } catch (imgError) {
                  // 图片压缩失败，使用原图
                  newZip.addFile(entryName, content);
                }
              } else {
                // 非图片文件直接复制
                newZip.addFile(entryName, content);
              }
            }
            
            // 生成新的压缩文件
            const rezipped = newZip.toBuffer();
            const selected = selectSmallerOutput(fileBytes, rezipped);
            outputBytes = selected.bytes;
            compressed = selected.compressed;
            
            if (compressed) {
              const savedPercent = Math.round(((fileBytes.length - outputBytes.length) / fileBytes.length) * 100);
              if (optimizedImages > 0) {
                compressionNote = `已优化 ${optimizedImages} 张图片，节省 ${savedPercent}% 体积`;
              } else {
                compressionNote = `已优化文档结构，节省 ${savedPercent}% 体积`;
              }
            } else {
              compressionNote = "Office 文档已优化过，体积没有明显下降";
            }
          } else {
            // 没有adm-zip，直接返回
            compressionNote = "现代 Office 格式已包含高效压缩，进一步压缩效果有限";
            outputBytes = fileBytes;
            compressed = false;
          }
        } catch (e) {
          console.warn("[compress] Office文档优化失败:", e.message);
          compressionNote = "Office 文档优化失败，已保留原文件";
          outputBytes = fileBytes;
          compressed = false;
        }
      } else {
        // 旧版Office格式
        compressionNote = "旧版 Office 格式压缩效果有限，建议转换为新版格式";
        outputBytes = fileBytes;
        compressed = false;
      }
      outputExt = ext;
    } else if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
      const quality = getUniversalCompressImageQuality(mode);
      let image = sharp(fileBytes, { animated: false }).rotate();

      if (mode === "体积优先") {
        image = image.resize({
          width: 1920,
          height: 1920,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      let candidateBytes;
      if (ext === "png") {
        candidateBytes = await image.png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          palette: mode === "体积优先",
          quality,
        }).toBuffer();
      } else if (ext === "webp") {
        candidateBytes = await image.webp({
          quality,
          effort: 5,
        }).toBuffer();
      } else {
        candidateBytes = await image.jpeg({
          quality,
          mozjpeg: true,
        }).toBuffer();
        outputExt = ext === "jpeg" ? "jpg" : ext;
      }

      const selected = selectSmallerOutput(fileBytes, candidateBytes);
      outputBytes = selected.bytes;
      compressed = selected.compressed;
      compressionNote = compressed ? "已重新编码图片并降低体积" : "图片重新编码后没有变小，已保留原文件";
    } else if (["bmp", "gif"].includes(ext)) {
      outputBytes = fileBytes;
      outputExt = ext;
      compressionNote = "当前图片格式暂不做有损压缩，已保留原文件";
    } else if (["mp3", "wav", "flac", "m4a", "aac", "ogg", "ncm"].includes(ext)) {
      const ffmpegPath = resolveFfmpegPath();
      if (!ffmpegPath) {
        const error = new Error("当前服务未检测到 FFmpeg，无法压缩音频文件。请在服务器安装 FFmpeg 或设置 FFMPEG_PATH 环境变量");
        error.code = "FFMPEG_UNAVAILABLE";
        throw error;
      }
      try {
        const tempInputPath = path.join(config.tempDir, `compress-input-${Date.now()}.${ext}`);
        const tempOutputPath = path.join(config.tempDir, `compress-output-${Date.now()}.${ext}`);

        fs.writeFileSync(tempInputPath, fileBytes);

        let qualityArgs = [];
        if (mode === "体积优先") {
          qualityArgs = ["-b:a", "64k"];
        } else if (mode === "均衡") {
          qualityArgs = ["-b:a", "128k"];
        } else if (mode === "质量优先") {
          qualityArgs = ["-b:a", "256k"];
        } else {
          qualityArgs = ["-b:a", "128k"];
        }

        const args = [
          "-y", "-i", tempInputPath,
          ...qualityArgs,
          tempOutputPath
        ];

        await new Promise((resolve, reject) => {
          const proc = spawn(ffmpegPath, args);
          let errorOutput = "";

          proc.stderr.on("data", (data) => {
            errorOutput += data.toString();
          });

          proc.on("exit", (code) => {
            if (code === 0) {
              resolve(true);
            } else {
              reject(new Error(errorOutput));
            }
          });
        });

        const selected = selectSmallerOutput(fileBytes, fs.readFileSync(tempOutputPath));
        outputBytes = selected.bytes;
        compressed = selected.compressed;
        compressionNote = compressed ? "已使用 FFmpeg 重新编码音频" : "音频重新编码后没有变小，已保留原文件";
        outputExt = ext;

        try {
          fs.unlinkSync(tempInputPath);
          fs.unlinkSync(tempOutputPath);
        } catch (cleanError) {
        }
      } catch (audioError) {
        console.warn("音频压缩失败，使用原文件:", audioError);
        outputBytes = fileBytes;
        compressionNote = "音频压缩失败，已保留原文件";
      }
    } else if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"].includes(ext)) {
      const ffmpegPath = resolveFfmpegPath();
      if (!ffmpegPath) {
        const error = new Error("当前服务未检测到 FFmpeg，无法压缩视频文件。请在服务器安装 FFmpeg 或设置 FFMPEG_PATH 环境变量");
        error.code = "FFMPEG_UNAVAILABLE";
        throw error;
      }
      try {
        const tempInputPath = path.join(config.tempDir, `compress-input-${Date.now()}.${ext}`);
        const tempOutputPath = path.join(config.tempDir, `compress-output-${Date.now()}.${ext}`);

        fs.writeFileSync(tempInputPath, fileBytes);

        let crf = "28";
        if (mode === "体积优先") {
          crf = "32";
        } else if (mode === "质量优先") {
          crf = "23";
        }

        const args = [
          "-y", "-i", tempInputPath,
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", crf,
          "-c:a", "aac",
          "-b:a", "128k",
          tempOutputPath
        ];

        await new Promise((resolve, reject) => {
          const proc = spawn(ffmpegPath, args);
          let errorOutput = "";

          proc.stderr.on("data", (data) => {
            errorOutput += data.toString();
          });

          proc.on("exit", (code) => {
            if (code === 0) {
              resolve(true);
            } else {
              reject(new Error(errorOutput));
            }
          });
        });

        const selected = selectSmallerOutput(fileBytes, fs.readFileSync(tempOutputPath));
        outputBytes = selected.bytes;
        compressed = selected.compressed;
        compressionNote = compressed ? "已使用 FFmpeg 重新编码视频" : "视频重新编码后没有变小，已保留原文件";
        outputExt = ext;

        try {
          fs.unlinkSync(tempInputPath);
          fs.unlinkSync(tempOutputPath);
        } catch (cleanError) {
        }
      } catch (videoError) {
        console.warn("视频压缩失败，使用原文件:", videoError);
        outputBytes = fileBytes;
        compressionNote = "视频压缩失败，已保留原文件";
      }
    } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z"].includes(ext)) {
      // Office 文档或压缩包 - 原样返回
      outputBytes = fileBytes;
      outputExt = ext;
      compressionNote = "Office 文档和压缩包通常已包含压缩结构，已保留原文件";
    } else {
      outputBytes = fileBytes;
      outputExt = ext;
      compressionNote = "暂不支持该类型的实际压缩，已保留原文件";
    }

    const savedBytes = Math.max(fileBytes.length - outputBytes.length, 0);
    const savedPercent = fileBytes.length > 0 ? Math.round((savedBytes / fileBytes.length) * 100) : 0;

    // 保持原始文件名，只替换扩展名（如果需要的话）
    let baseFileName = fileName;
    if (fileName.includes('.')) {
      baseFileName = fileName.substring(0, fileName.lastIndexOf('.'));
    }
    // 避免文件名过长或特殊字符问题
    baseFileName = baseFileName.replace(/[^\w\u4e00-\u9fa5]/g, '_');
    // 如果是空文件名，使用默认名称
    if (!baseFileName || baseFileName.length === 0) {
      baseFileName = "compressed";
    }
    
    const output = await saveOutputFile(req, outputBytes, {
      extension: outputExt,
      baseName: baseFileName,
    });

    const responseFile = buildFileResponse(output, "application/octet-stream", undefined, req);
    
    // 根据文件大小限制和 shouldInlineCompressedFile 来决定是否内联
    const shouldInline = shouldInlineCompressedFile({ 
      fileName: responseFile.name, 
      mimeType: responseFile.contentType || responseFile.mimeType, 
      fileBytes: outputBytes
    });
    console.log(`[compress] shouldInline: ${shouldInline}, file size: ${formatFileSize(outputBytes.length)}`);
    
    if (shouldInline) {
      responseFile.inlineBase64 = outputBytes.toString("base64");
      console.log(`[compress] set inlineBase64, length: ${responseFile.inlineBase64.length}`);
    } else {
      responseFile.inlineBase64 = undefined;
      console.log(`[compress] skip inlineBase64, will use download`);
    }
    
    // 保持原文件名，只替换扩展名
    let finalFileName = fileName;
    if (fileName && fileName.includes('.')) {
      const namePart = fileName.substring(0, fileName.lastIndexOf('.'));
      finalFileName = `${namePart}.${outputExt}`;
    } else if (fileName) {
      finalFileName = `${fileName}.${outputExt}`;
    } else {
      finalFileName = `compressed.${outputExt}`;
    }
    
    responseFile.name = finalFileName;
    responseFile.label = finalFileName;

    return {
      ok: true,
      resultType: "document",
      headline: compressed ? "文件压缩完成" : "文件体积未变小",
      detail: compressed ? `已按照「${mode || "默认"}」策略完成压缩。` : compressionNote,
      file: responseFile,
      compressed,
      beforeBytes: fileBytes.length,
      afterBytes: outputBytes.length,
      savedBytes,
      savedPercent,
      note: compressionNote,
      metaLines: [
        `压缩模式 ${mode || "默认"}`,
        `文件类型 ${ext}`,
        compressed ? `节省 ${savedPercent}%` : "未产生体积收益",
      ],
    };
}

app.post("/api/file/compress", async (req, res) => {
  const file = req.body.file;
  const mode = req.body.mode || "";

  try {
    if (!file || !file.base64) {
      throw new Error("需要上传文件");
    }

    const fileBytes = decodeBase64File(file);
    const response = await buildFileCompressResponse(req, {
      fileName: file.name || "",
      sizeBytes: file.sizeBytes || fileBytes.length,
      fileBytes,
      mode,
    });

    await recordOperation(req, {
      toolId: "file-compress",
      status: "success",
      inputFiles: [
        {
          name: file.name || "",
          sizeBytes: file.sizeBytes || fileBytes.length,
        },
      ],
      outputFiles: [
        {
          name: response.file.name,
          provider: response.file.provider,
          sizeBytes: response.file.sizeBytes,
        },
      ],
      meta: {
        mode,
        extension: normalizeExtension(file.name ? file.name.split('.').pop() : "bin"),
        compressed: response.compressed,
        savedBytes: response.savedBytes,
        savedPercent: response.savedPercent,
      },
    });

    res.json(response);
  } catch (error) {
    await recordOperation(req, {
      toolId: "file-compress",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "FILE_COMPRESS_FAILED",
      errorMessage: error.message || "文件压缩失败",
      meta: {
        mode,
      },
    });

    sendError(
      res,
      500,
      error.code || "FILE_COMPRESS_FAILED",
      error.message || "文件压缩失败"
    );
  }
});

app.post("/api/file/compress-upload", async (req, res) => {
  let uploadFile = null;
  let mode = "";

  try {
    const { fields, files } = await parseMultipartRequest(req, 2 * 1024 * 1024 * 1024);
    uploadFile = files.file || null;
    mode = fields.mode || "";

    if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
      const error = new Error("需要上传文件");
      error.code = "MISSING_FILE_CONTENT";
      throw error;
    }

    const response = await buildFileCompressResponse(req, {
      fileName: uploadFile.fileName || "",
      sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      fileBytes: uploadFile.buffer,
      mode,
    });

    await recordOperation(req, {
      toolId: "file-compress",
      status: "success",
      inputFiles: [
        {
          name: uploadFile.fileName || "",
          sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
        },
      ],
      outputFiles: [
        {
          name: response.file.name,
          provider: response.file.provider,
          sizeBytes: response.file.sizeBytes,
        },
      ],
      meta: {
        mode,
        extension: normalizeExtension(uploadFile.fileName ? uploadFile.fileName.split('.').pop() : "bin"),
        compressed: response.compressed,
        savedBytes: response.savedBytes,
        savedPercent: response.savedPercent,
        uploadMode: "multipart",
      },
    });

    res.json(response);
  } catch (error) {
    await recordOperation(req, {
      toolId: "file-compress",
      status: "failed",
      inputFiles: uploadFile
        ? [
          {
            name: uploadFile.fileName || "",
            sizeBytes: uploadFile.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "FILE_COMPRESS_FAILED",
      errorMessage: error.message || "文件压缩失败",
      meta: {
        mode,
        uploadMode: "multipart",
      },
    });

    sendError(
      res,
      500,
      error.code || "FILE_COMPRESS_FAILED",
      error.message || "文件压缩失败"
    );
  }
});

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }

  try {
    const command = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const result = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean);

    return result || "";
  } catch (error) {
    return "";
  }
}

function getAudioCodec(targetFormat) {
  const codecMap = {
    mp3: "libmp3lame",
    wav: "pcm_s16le",
    flac: "flac",
    ogg: "libvorbis",
    m4a: "aac",
    aac: "aac",
  };
  return codecMap[targetFormat.toLowerCase()] || "libmp3lame";
}

function getVideoCodec(targetFormat) {
  const codecMap = {
    mp4: "libx264",
    mov: "libx264",
    webm: "libvpx-vp9",
  };
  return codecMap[targetFormat.toLowerCase()] || "libx264";
}

function getAudioBitrate(qualityLabel) {
  const bitrateMap = {
    "标准": "192k",
    "高清": "320k",
    "无损": "320k",
  };
  return bitrateMap[qualityLabel] || "192k";
}

function getVideoCrf(qualityLabel) {
  const crfMap = {
    "标准": "28",
    "高清": "23",
    "无损": "18",
  };
  return crfMap[qualityLabel] || "28";
}

function getMediaExtension(targetFormat) {
  const extMap = {
    mp3: "mp3",
    wav: "wav",
    flac: "flac",
    ogg: "ogg",
    m4a: "m4a",
    aac: "aac",
    mp4: "mp4",
    mov: "mov",
    webm: "webm",
  };
  return extMap[targetFormat.toLowerCase()] || "mp3";
}

function isAudioExtension(ext) {
  return ["mp3", "wav", "flac", "ogg", "m4a", "aac", "ncm"].includes(String(ext || "").toLowerCase());
}

function isVideoExtension(ext) {
  return ["mp4", "mov", "webm", "avi", "mkv", "wmv", "flv"].includes(String(ext || "").toLowerCase());
}

function getMediaContentType(ext) {
  const normalized = String(ext || "").toLowerCase();
  const contentTypes = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  return contentTypes[normalized] || "application/octet-stream";
}

function parseFfmpegDuration(stderr) {
  const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (durationMatch) {
    const hours = parseInt(durationMatch[1], 10);
    const minutes = parseInt(durationMatch[2], 10);
    const seconds = parseInt(durationMatch[3], 10);
    const centiseconds = parseInt(durationMatch[4], 10);
    return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
  }
  return null;
}

function parseFfmpegTime(stderr) {
  const timeMatch = stderr.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseInt(timeMatch[3], 10);
    const centiseconds = parseInt(timeMatch[4], 10);
    return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
  }
  return null;
}

function runFfmpegConvert(ffmpegPath, inputFilePath, outputFilePath, targetFormat, quality, onProgress) {
  return new Promise((resolve, reject) => {
    const ext = targetFormat.toLowerCase();
    const args = ["-y", "-probesize", "100M", "-analyzeduration", "10M", "-i", inputFilePath];

    if (isAudioExtension(ext)) {
      args.push("-vn");
      args.push("-acodec", getAudioCodec(ext));
      if (!["wav", "flac"].includes(ext)) {
        args.push("-b:a", getAudioBitrate(quality));
      }
      if (ext === "m4a") {
        args.push("-f", "ipod");
      } else if (ext === "aac") {
        args.push("-f", "adts");
      }
    } else if (isVideoExtension(ext)) {
      args.push("-c:v", getVideoCodec(ext));
      if (ext === "webm") {
        args.push("-b:v", "0", "-crf", getVideoCrf(quality), "-c:a", "libopus", "-b:a", "128k");
      } else {
        args.push("-preset", "veryfast", "-crf", getVideoCrf(quality), "-c:a", "aac", "-b:a", "160k");
        if (ext === "mp4") {
          args.push("-movflags", "+faststart");
        }
      }
    }

    args.push(outputFilePath);

    console.log("[FFmpeg] 执行命令:", ffmpegPath, args.join(" "));

    let stderrOutput = "";
    let totalDuration = null;
    const child = spawn(ffmpegPath, args);

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderrOutput += chunk;
      
      if (onProgress) {
        // 先解析总时长
        if (totalDuration === null) {
          totalDuration = parseFfmpegDuration(stderrOutput);
        }
        
        // 解析当前时间并计算进度
        if (totalDuration !== null) {
          const currentTime = parseFfmpegTime(chunk);
          if (currentTime !== null) {
            const progress = Math.min(99, Math.max(0, (currentTime / totalDuration) * 100));
            onProgress(progress, "转换中...");
          }
        }
      }
    });

    child.on("error", (err) => {
      console.error("[FFmpeg] 启动错误:", err);
      reject(new Error(`FFmpeg 启动失败: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error("[FFmpeg] 错误输出:", stderrOutput);
        reject(new Error(`FFmpeg 转换失败 (exit code ${code})`));
        return;
      }
      console.log("[FFmpeg] 转换成功");
      if (onProgress) {
        onProgress(100, "转换完成");
      }
      resolve();
    });
  });
}

// 异步音视频转换处理函数
async function processAudioConvertTask(taskId, taskData) {
  const {
    fileBuffer,
    file,
    target,
    quality,
    originalInputName,
    ffmpegPath,
    req,
    tempDir,
  } = taskData;

  try {
    updateTaskStatus(taskId, "processing", "准备处理...");
    updateTaskProgress(taskId, 5, "初始化中...");

    const inputExt = path.extname(originalInputName) || ".mp3";
    const inputExtName = inputExt.replace(".", "").toLowerCase();
    const safeInputName = `input-${makeId()}${inputExt}`;
    const inputPath = path.join(tempDir, safeInputName);

    const targetExt = getMediaExtension(target);
    const targetIsAudio = isAudioExtension(targetExt);
    const targetIsVideo = isVideoExtension(targetExt);
    const inputIsAudio = isAudioExtension(inputExtName);
    const inputIsVideo = isVideoExtension(inputExtName);

    if (!targetIsAudio && !targetIsVideo) {
      throw new Error("Unsupported target format");
    }

    if (targetIsVideo && inputIsAudio) {
      throw new Error("Audio files cannot be directly converted to video formats");
    }

    const originalBaseName = path.parse(originalInputName).name || "media";
    let safeBaseName = originalBaseName.replace(/[^\w\u4e00-\u9fa5\-_]/g, "_");
    let outputName = `${safeBaseName}.${targetExt}`;
    let outputPath = path.join(tempDir, outputName);

    console.log("[Media Convert] 写入文件:", inputPath, "大小:", fileBuffer.length, "bytes");
    updateTaskProgress(taskId, 10, "解析文件...");

    const magic = fileBuffer.slice(0, 8).toString("hex");
    console.log("[Media Convert] 文件头(hex):", magic);

    const isFlac = magic.startsWith("664c6143");
    const isMp3 = magic.startsWith("494433") || magic.startsWith("fff") || magic.startsWith("fffa") || magic.startsWith("fffb");
    const isWav = magic.startsWith("52494646");
    const isOgg = magic.startsWith("4f676753");
    const isM4a = magic.startsWith("66747970") || magic.startsWith("000000") || (magic.length >= 16 && magic.slice(8, 16) === "66747970");

    const isNcm = magic.startsWith("4354454e");
    const isKgm = magic.startsWith("7b226b67");
    const isQmc = magic.startsWith("789c");

    console.log("[Media Convert] 格式检查 - FLAC:", isFlac, "MP3:", isMp3, "WAV:", isWav, "OGG:", isOgg, "M4A:", isM4a, "VideoExt:", inputIsVideo);
    console.log("[Media Convert] 加密检查 - NCM:", isNcm, "KGM:", isKgm, "QMC:", isQmc);
    updateTaskProgress(taskId, 15, "检查格式...");

    let formatMatch = true;
    let formatHint = "";
    let actualInputPath = inputPath;
    let isNcmFile = false;

    if (inputExt.toLowerCase() === ".ncm") {
      isNcmFile = true;
    } else if (inputExt.toLowerCase() === ".flac" && !isFlac) {
      if (isNcm) {
        isNcmFile = true;
      } else {
        formatMatch = false;
        if (isKgm) formatHint = "这看起来是酷狗音乐的加密格式 (.kgm)，不是真正的 FLAC。";
        else if (isQmc) formatHint = "这看起来是 QQ 音乐的加密格式 (.qmc)，不是真正的 FLAC。";
        else formatHint = "这个文件的扩展名是 .flac，但内容不是标准 FLAC 格式。";
      }
    } else if (inputExt.toLowerCase() === ".mp3" && !isMp3) {
      if (isNcm) {
        isNcmFile = true;
      } else {
        formatMatch = false;
        formatHint = "这个文件的扩展名是 .mp3，但内容看起来不像是标准 MP3 格式。";
      }
    } else if (inputExt.toLowerCase() === ".wav" && !isWav) {
      if (isNcm) {
        isNcmFile = true;
      } else {
        formatMatch = false;
        formatHint = "这个文件的扩展名是 .wav，但内容看起来不像是标准 WAV 格式。";
      }
    }

    if (!formatMatch) {
      throw new Error(formatHint);
    }
    updateTaskProgress(taskId, 20, "准备转换...");

    if (isNcmFile && ncmDecrypt) {
      console.log("[Media Convert] 检测到 NCM 格式，开始解密...");
      updateTaskProgress(taskId, 25, "解密中...");
      const decryptResult = ncmDecrypt.decryptNcm(fileBuffer);
      const detectedFormat = decryptResult.format || "mp3";
      const decryptedPath = path.join(tempDir, `decrypted-${makeId()}.${detectedFormat}`);
      fs.writeFileSync(decryptedPath, decryptResult.musicData);
      actualInputPath = decryptedPath;
      console.log("[Media Convert] NCM 解密完成，实际格式:", detectedFormat);
      
      if (decryptResult.metaData && decryptResult.metaData.musicName) {
        const originalBaseName = decryptResult.metaData.musicName.replace(/[^\w\u4e00-\u9fa5\-_]/g, "_");
        safeBaseName = originalBaseName;
        outputName = `${safeBaseName}.${targetExt}`;
        outputPath = path.join(tempDir, outputName);
      }
    } else {
      fs.writeFileSync(inputPath, fileBuffer);
    }

    const stats = fs.statSync(actualInputPath);
    console.log("[Media Convert] 文件已写入，实际大小:", stats.size, "bytes");
    console.log("[Media Convert] 输出路径:", outputPath);
    updateTaskProgress(taskId, 30, "开始转换...");

    await runFfmpegConvert(ffmpegPath, actualInputPath, outputPath, target, quality, (progress, statusText) => {
      updateTaskProgress(taskId, 30 + progress * 0.6, statusText);
    });

    updateTaskProgress(taskId, 90, "保存结果...");
    const bytes = fs.readFileSync(outputPath);
    const responseContentType = getMediaContentType(targetExt);
    const output = await saveOutputFile(req, bytes, {
      extension: targetExt,
      contentType: responseContentType,
      baseName: safeBaseName,
      addRandomSuffix: false,
    });

    await recordOperation(req, {
      toolId: "audio-convert",
      status: "success",
      inputFiles: [
        {
          name: originalInputName || "",
          sizeBytes: file.sizeBytes || 0,
        },
      ],
      outputFiles: [
        {
          name: output.fileName,
          provider: output.provider,
          sizeBytes: output.sizeBytes,
        },
      ],
      meta: {
        target,
        quality,
      },
    });

    const result = {
      ok: true,
      resultType: "document",
      headline: "音视频格式转换已完成",
      detail: `已转换为 ${target} 格式，可直接下载使用。`,
      file: buildFileResponse(output, responseContentType, undefined, req),
      metaLines: [
        `原文件 ${originalInputName}`,
        `目标格式 ${target}`,
        `质量 ${quality}`,
      ].filter(Boolean),
    };

    updateTaskStatus(taskId, "completed", "处理完成");
    updateTaskProgress(taskId, 100, "完成");
    setTaskResult(taskId, result);
  } catch (error) {
    console.error("[Media Convert] 错误:", error);
    let errorMessage = "音视频转换失败";
    
    const errMsg = (error.message || "").toLowerCase();
    if (errMsg.includes("invalid data") || errMsg.includes("could not find codec")) {
      errorMessage = "无法解析音视频文件";
    } else if (error.message.includes("Audio files cannot be directly converted")) {
      errorMessage = "音频不能直接转换为视频";
    } else if (errMsg.includes("ffmpeg")) {
      errorMessage = "FFmpeg 执行错误";
    }

    await recordOperation(req, {
      toolId: "audio-convert",
      status: "failed",
      inputFiles: file ? [{ name: originalInputName || "", sizeBytes: file.sizeBytes || 0 }] : [],
      errorCode: "MEDIA_CONVERT_FAILED",
      errorMessage,
      meta: { target, quality },
    });

    updateTaskStatus(taskId, "failed", errorMessage);
    setTaskError(taskId, errorMessage);
  } finally {
    cleanupTempDir(tempDir);
  }
}

app.post("/api/audio/convert", async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let file;
  let target;
  let quality;
  let fileBuffer;

  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const uploadFile = uploadFiles.file;
      target = fields.target || "MP3";
      quality = fields.quality || "标准";

      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }

      fileBuffer = uploadFile.buffer;
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[音频转换] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("音频转换 multipart上传解析失败:", error);
      sendError(res, 400, "AUDIO_CONVERT_FAILED", "文件上传失败");
      return;
    }
  } else {
    file = req.body.file;
    target = req.body.target || "MP3";
    quality = req.body.quality || "标准";
    fileBuffer = decodeBase64File(file);
  }

  const ffmpegPath = resolveFfmpegPath();

  if (!ffmpegPath) {
    await recordOperation(req, {
      toolId: "audio-convert",
      status: "failed",
      inputFiles: file ? [{ name: file.name || "", sizeBytes: file.sizeBytes || 0 }] : [],
      errorCode: "FFMPEG_UNAVAILABLE",
      errorMessage: "当前服务未检测到 FFmpeg",
      meta: { target, quality },
    });
    sendError(res, 501, "FFMPEG_UNAVAILABLE", "当前服务端未检测到 FFmpeg，请安装后再启用音视频转换。");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(config.tempDir, "media-"));
  const originalInputName = file && file.name ? file.name : `media-${makeId()}.mp4`;

  const task = createTask("audio-convert", {
    fileBuffer,
    file,
    target,
    quality,
    originalInputName,
    ffmpegPath,
    req: {
      headers: req.headers,
      protocol: req.protocol,
      hostname: req.hostname,
    },
    tempDir,
  });

  res.json({
    ok: true,
    taskId: task.id,
    status: "pending",
  });

  process.nextTick(() => processAudioConvertTask(task.id, {
    fileBuffer,
    file,
    target,
    quality,
    originalInputName,
    ffmpegPath,
    req,
    tempDir,
  }));
});

async function processOcrTask(taskId, taskData, update) {
  const { fileBuffer, file, language, layout, req } = taskData;
  
  update(20, "识别中...");
  
  const result = await recognizeTextFromImage(
    {
      ...file,
      buffer: fileBuffer
    },
    language,
    layout
  );
  const text = result.text || "";
  
  update(80, "整理结果...");
  
  await recordOperation(req, {
    toolId: "ocr-image",
    status: "success",
    inputFiles: file
      ? [
        {
          name: file.name || "",
          sizeBytes: file.sizeBytes || 0,
        },
      ]
      : [],
    meta: {
      language,
      layout,
      textLength: text.trim().length,
      confidence: result.confidence,
      variant: result.variant,
      provider: result.provider,
    },
  });
  
  return {
    ok: true,
    resultType: "text",
    headline: "OCR 识别已完成",
    detail: `共识别 ${text.trim().length} 个字符，可直接复制继续使用。`,
    text,
    lines: result.lines || [],
    confidence: result.confidence,
    provider: result.provider,
    metaLines: [
      `语言 ${language}`,
      layout ? `模式 ${layout}` : "",
      `引擎 ${result.provider === "baidu" ? "百度 OCR" : "Tesseract"}`,
      result.confidence ? `置信度 ${result.confidence}` : "",
    ].filter(Boolean),
  };
}

app.post("/api/ocr/image", async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let file;
  let language;
  let layout;
  let fileBuffer;

  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 100 * 1024 * 1024);
      const uploadFile = uploadFiles.file;
      language = fields.language || "中英混合";
      layout = fields.layout || "";

      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }

      fileBuffer = uploadFile.buffer;
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[OCR文字识别] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("OCR文字识别 multipart上传解析失败:", error);
      sendError(res, 400, "OCR_FAILED", "文件上传失败");
      return;
    }
  } else {
    file = req.body.file;
    language = req.body.language || "中英混合";
    layout = req.body.layout || "";
    fileBuffer = decodeBase64File(file);
  }

  try {
    await createAsyncTask(
      req,
      res,
      "ocr-image",
      { fileBuffer, file, language, layout, req },
      processOcrTask,
      {
        initialStatusText: "准备识别...",
        initialProgress: 10,
        completeStatusText: "识别完成"
      }
    );
  } catch (error) {
    await recordOperation(req, {
      toolId: "ocr-image",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "OCR_FAILED",
      errorMessage: error.message || "OCR 识别失败",
      meta: {
        language,
        layout,
      },
    });

    sendError(res, 500, error.code || "OCR_FAILED", error.message || "OCR 识别失败");
  }
});

async function processOfficeToPdfTask(taskId, taskData, update) {
  const { fileBuffer, file, quality, pageMode, sofficePath, req, tempDir } = taskData;
  
  update(20, "转换中...");
  
  const randomId = makeId();
  const inputExt = file && file.name ? path.extname(file.name) : ".docx";
  const inputName = `input-${randomId}${inputExt}`;
  const inputPath = path.join(tempDir, inputName);
  fs.writeFileSync(inputPath, fileBuffer);
  
  update(40, "处理文档...");
  
  await runSofficeConvert(sofficePath, inputPath, tempDir);
  
  update(70, "保存结果...");
  
  const outputFileName = `input-${randomId}.pdf`;
  const outputPath = path.join(tempDir, outputFileName);
  const bytes = fs.readFileSync(outputPath);
  const originalFileName = file?.name || "document";
  const baseNameWithoutExt = originalFileName.replace(/\.[^/.]+$/, "");
  const output = await saveOutputFile(req, bytes, {
    extension: "pdf",
    contentType: "application/pdf",
    baseName: baseNameWithoutExt,
    addRandomSuffix: false,
  });
  
  await recordOperation(req, {
    toolId: "office-to-pdf",
    status: "success",
    inputFiles: [
      {
        name: file.name || "",
        sizeBytes: file.sizeBytes || 0,
      },
    ],
    outputFiles: [
      {
        name: output.fileName,
        provider: output.provider,
        sizeBytes: output.sizeBytes,
      },
    ],
    meta: {
      quality,
      pageMode,
    },
  });
  
  return {
    ok: true,
    resultType: "document",
    headline: "Office 转 PDF 已完成",
    detail: "文档已导出为 PDF，可直接打开或继续压缩、合并。",
    file: buildFileResponse(output, "application/pdf", undefined, req),
    metaLines: [
      `原文件 ${file.name || inputName}`,
      quality ? `清晰度 ${quality}` : "",
      pageMode ? `页面策略 ${pageMode}` : "",
    ].filter(Boolean),
  };
}

app.post("/api/office/to-pdf", async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let file;
  let quality;
  let pageMode;
  let pdfBuffer;

  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const uploadFile = uploadFiles.file;
      quality = fields.quality || "";
      pageMode = fields.pageMode || "";

      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }

      pdfBuffer = uploadFile.buffer;
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[Office转PDF] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("Office转PDF multipart上传解析失败:", error);
      sendError(res, 400, "OFFICE_CONVERT_FAILED", "文件上传失败");
      return;
    }
  } else {
    file = req.body.file;
    quality = req.body.quality || "";
    pageMode = req.body.pageMode || "";
    assertPdfFile(file);
    pdfBuffer = decodeBase64File(file);
  }

  const sofficePath = resolveSofficePath();

  if (!sofficePath) {
    await recordOperation(req, {
      toolId: "office-to-pdf",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: "OFFICE_CONVERTER_UNAVAILABLE",
      errorMessage: "当前服务未检测到 LibreOffice",
      meta: {
        quality,
        pageMode,
      },
    });

    sendError(
      res,
      501,
      "OFFICE_CONVERTER_UNAVAILABLE",
      "LibreOffice unavailable"
    );
    return;
  }

  try {
    const tempDir = fs.mkdtempSync(path.join(config.tempDir, "office-"));
    
    await createAsyncTask(
      req,
      res,
      "office-to-pdf",
      { fileBuffer: pdfBuffer, file, quality, pageMode, sofficePath, req, tempDir },
      processOfficeToPdfTask,
      {
        initialStatusText: "准备转换...",
        initialProgress: 10,
        completeStatusText: "转换完成"
      }
    );
  } catch (error) {
    await recordOperation(req, {
      toolId: "office-to-pdf",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "OFFICE_TO_PDF_FAILED",
      errorMessage: error.message || "Office 转 PDF 失败",
      meta: {
        quality,
        pageMode,
      },
    });

    sendError(
      res,
      500,
      error.code || "OFFICE_TO_PDF_FAILED",
      error.message || "Office 转 PDF 失败"
    );
  }
});

function createCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getAdobePdfServicesCredentials() {
  if (!adobePdfServices) {
    throw createCodedError(
      "Adobe PDF Services SDK 未加载",
      "PDF_TO_WORD_ADOBE_NOT_AVAILABLE"
    );
  }

  const clientId = process.env.PDF_SERVICES_CLIENT_ID || process.env.ADOBE_PDF_SERVICES_CLIENT_ID;
  const clientSecret = process.env.PDF_SERVICES_CLIENT_SECRET || process.env.ADOBE_PDF_SERVICES_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw createCodedError(
      "Adobe PDF Services API 未配置，请设置 PDF_SERVICES_CLIENT_ID 和 PDF_SERVICES_CLIENT_SECRET",
      "PDF_TO_WORD_ADOBE_NOT_CONFIGURED"
    );
  }

  return new adobePdfServices.ServicePrincipalCredentials({ clientId, clientSecret });
}

function buildAdobeClientConfig() {
  const configOptions = {};
  const timeoutMs = Number(process.env.PDF_SERVICES_TIMEOUT_MS || process.env.ADOBE_PDF_SERVICES_TIMEOUT_MS || 120000);
  const region = String(process.env.PDF_SERVICES_REGION || process.env.ADOBE_PDF_SERVICES_REGION || "").trim().toUpperCase();

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    configOptions.timeout = timeoutMs;
  }

  if (region === "EU") {
    configOptions.region = adobePdfServices.Region.EU;
  } else if (region === "US") {
    configOptions.region = adobePdfServices.Region.US;
  }

  return new adobePdfServices.ClientConfig(configOptions);
}

function createAdobePdfServicesClient() {
  return new adobePdfServices.PDFServices({
    credentials: getAdobePdfServicesCredentials(),
    clientConfig: buildAdobeClientConfig(),
  });
}

function getPdfToWordOutputConfig(format) {
  const normalizedFormat = String(format || "DOCX").trim().toUpperCase();
  if (normalizedFormat === "DOC") {
    return {
      extension: "doc",
      contentType: adobePdfServices.MimeType.DOC,
      targetFormat: adobePdfServices.ExportPDFTargetFormat.DOC,
      format: "DOC",
    };
  }

  return {
    extension: "docx",
    contentType: adobePdfServices.MimeType.DOCX,
    targetFormat: adobePdfServices.ExportPDFTargetFormat.DOCX,
    format: "DOCX",
  };
}

function getAdobeExportOcrLocale(locale) {
  const requestedLocale = String(locale || process.env.PDF_SERVICES_OCR_LOCALE || "zh-CN").trim();
  const localeEntry = Object.entries(adobePdfServices.ExportOCRLocale).find(
    ([key, value]) =>
      key.toLowerCase() === requestedLocale.toLowerCase().replace(/-/g, "_") ||
      value.toLowerCase() === requestedLocale.toLowerCase()
  );

  return localeEntry ? localeEntry[1] : adobePdfServices.ExportOCRLocale.ZH_CN;
}

async function readStreamToBuffer(readStream) {
  const chunks = [];
  for await (const chunk of readStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function getPdfPageCount(fileBuffer) {
  try {
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch (error) {
    console.warn("[PDF to Word] unable to read PDF page count:", error && error.message ? error.message : error);
    return 0;
  }
}

async function deleteAdobeAssetQuietly(pdfServices, asset) {
  if (!asset) {
    return;
  }

  try {
    await pdfServices.deleteAsset({ asset });
  } catch (error) {
    console.warn("[PDF to Word] Adobe asset cleanup failed:", error && error.message ? error.message : error);
  }
}

async function convertPdfToWordWithAdobe(fileBuffer, inputName, tempDir, options = {}) {
  const inputPath = path.join(tempDir, inputName);
  fs.writeFileSync(inputPath, fileBuffer);

  const password = String(options.password || "").trim();
  // 强制默认精确还原（字体/格式 1:1）
  const layoutMode = String(options.layout || "exact").toLowerCase();
  const outputConfig = getPdfToWordOutputConfig(options.format);
  const ocrLocale = getAdobeExportOcrLocale(options.ocrLocale);
  const pages = await getPdfPageCount(fileBuffer);
  const pdfServices = createAdobePdfServicesClient();
  const uploadedAssets = [];
  const generatedAssets = [];

  console.log("[PDF to Word] 使用 Adobe 高精度模式转换（字体/格式 1:1 还原）");

  try {
    const inputAsset = await pdfServices.upload({
      readStream: fs.createReadStream(inputPath),
      mimeType: adobePdfServices.MimeType.PDF,
    });
    uploadedAssets.push(inputAsset);

    let exportInputAsset = inputAsset;
    let wasUnlocked = false;

    // 处理加密 PDF
    if (password) {
      const removeProtectionParams = new adobePdfServices.RemoveProtectionParams({ password });
      const removeProtectionJob = new adobePdfServices.RemoveProtectionJob({
        inputAsset: exportInputAsset,
        params: removeProtectionParams,
      });
      const removeProtectionPollingURL = await pdfServices.submit({ job: removeProtectionJob });
      const removeProtectionResponse = await pdfServices.getJobResult({
        pollingURL: removeProtectionPollingURL,
        resultType: adobePdfServices.RemoveProtectionResult,
      });

      if (!removeProtectionResponse.result || !removeProtectionResponse.result.asset) {
        throw createCodedError("Adobe PDF Services API 未返回解密后的 PDF", "PDF_TO_WORD_ADOBE_FAILED");
      }

      exportInputAsset = removeProtectionResponse.result.asset;
      generatedAssets.push(exportInputAsset);
      wasUnlocked = true;
    }

    // ====================== 终极优化：最高字体/格式还原配置 ======================
    const finalLayoutMode = layoutMode === "exact" ? "EXACT" : "FLOW";
    const exportParams = new adobePdfServices.ExportPDFParams({
      targetFormat: outputConfig.targetFormat,
      ocrLocale,
      // 🔥 核心1：精确布局（完全复刻PDF的字体、间距、排版）
      layoutMode: finalLayoutMode,
      // 🔥 核心2：保留PDF原始字体（不替换为系统默认字体）
      preserveFonts: true,
      // 核心 3：将字体嵌入 Word 文档（打开任何电脑都显示原字体）
      embedFonts: true,
      // 核心 4：保留完整格式（字号、颜色、粗体、斜体、下划线）
      preserveFormatting: true,
      // 🔥 核心5：保留专业排版（字符间距、行高、对齐方式）
      preserveTypography: true,
      // 保留页眉页脚和脚注
      includeHeadersAndFooters: true,
      includeFootnotes: true,
      // 精准识别表格
      tableDetectionEnabled: true,
      // 字体子集化（减小文件体积，不影响还原度）
      subsetFonts: true,
    });

    const exportJob = new adobePdfServices.ExportPDFJob({
      inputAsset: exportInputAsset,
      params: exportParams,
    });
    const exportPollingURL = await pdfServices.submit({ job: exportJob });
    const exportResponse = await pdfServices.getJobResult({
      pollingURL: exportPollingURL,
      resultType: adobePdfServices.ExportPDFResult,
    });

    if (!exportResponse.result || !exportResponse.result.asset) {
      throw createCodedError("Adobe PDF Services API 未返回 DOCX 文件", "PDF_TO_WORD_ADOBE_FAILED");
    }

    const resultAsset = exportResponse.result.asset;
    generatedAssets.push(resultAsset);

    const streamAsset = await pdfServices.getContent({ asset: resultAsset });
    const buffer = await readStreamToBuffer(streamAsset.readStream);

    if (!buffer.length) {
      throw createCodedError("Adobe PDF Services API 返回了空的 DOCX 文件", "PDF_TO_WORD_ADOBE_FAILED");
    }

    return {
      buffer,
      pages,
      engine: "adobe-pdf-services",
      extension: outputConfig.extension,
      contentType: outputConfig.contentType,
      format: outputConfig.format,
      ocrLocale,
      unlocked: wasUnlocked,
      layoutMode: layoutMode,
    };
  } catch (error) {
    if (!error.code) {
      error.code = "PDF_TO_WORD_ADOBE_FAILED";
    }
    throw error;
  } finally {
    // 清理资源
    for (const asset of [...generatedAssets, ...uploadedAssets]) {
      await deleteAdobeAssetQuietly(pdfServices, asset);
    }
  }
}

app.post("/api/pdf/to-word", async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  let file;
  let format;
  let layout;
  let fileBuffer;
  let ocrLocale;
  let password;

  if (contentType.includes('multipart/form-data')) {
    try {
      const { fields, files: uploadFiles } = await parseMultipartRequest(req, 200 * 1024 * 1024);
      const uploadFile = uploadFiles.file;
      format = fields.format || "DOCX";
      layout = fields.layout || "exact";
      ocrLocale = fields.ocrLocale || fields.language || fields.locale || "";
      password = fields.password || fields.pdfPassword || "";

      if (!uploadFile || !uploadFile.buffer || !uploadFile.buffer.length) {
        throw new Error("缺少文件内容");
      }

      fileBuffer = uploadFile.buffer;
      // 优先使用前端传递的fileName
      const customFileName = fields.fileName || "";
      file = {
        name: customFileName || uploadFile.fileName || "",
        sizeBytes: uploadFile.sizeBytes || uploadFile.buffer.length,
      };
      console.log("[PDF转Word] 接收到的文件名:", file.name);
    } catch (error) {
      console.error("PDF转Word multipart上传解析失败:", error);
      sendError(res, 400, "PDF_TO_WORD_FAILED", "文件上传失败");
      return;
    }
  } else {
    // 原有base64模式
    file = req.body.file;
    format = req.body.format || "DOCX";
    layout = req.body.layout || "exact";
    ocrLocale = req.body.ocrLocale || req.body.language || req.body.locale || "";
    password = req.body.password || req.body.pdfPassword || "";
    assertPdfFile(file);
    fileBuffer = decodeBase64File(file);
  }

  let tempDir = "";

  try {
    tempDir = fs.mkdtempSync(path.join(config.tempDir, "pdf-word-"));
    console.log("[PDF to Word] 临时目录:", tempDir);

    const randomId = makeId();
    const inputName = `input-${randomId}.pdf`;
    console.log("[PDF to Word] 输入文件大小:", fileBuffer.length, "bytes");

    const conversion = await convertPdfToWordWithAdobe(fileBuffer, inputName, tempDir, {
      format,
      ocrLocale,
      password,
      layout: layout, // 🔥 新增：传递布局模式
    });

    console.log("[PDF to Word] Word文档生成完成, 大小:", conversion.buffer.length, "bytes");

    // 从原文件名提取基础名称，生成有意义的文件名
    const originalFileName = file?.name || "document";
    const baseNameWithoutExt = originalFileName.replace(/\.[^/.]+$/, "");
    const output = await saveOutputFile(req, conversion.buffer, {
      extension: conversion.extension,
      contentType: conversion.contentType,
      baseName: baseNameWithoutExt,
      addRandomSuffix: false,
    });

    await recordOperation(req, {
      toolId: "pdf-to-word",
      status: "success",
      inputFiles: [
        {
          name: file.name || "",
          sizeBytes: file.sizeBytes || 0,
        },
      ],
      outputFiles: [
        {
          name: output.fileName,
          provider: output.provider,
          sizeBytes: output.sizeBytes,
        },
      ],
      meta: {
        format: conversion.format,
        layout,
        pages: conversion.pages,
        engine: conversion.engine,
        ocrLocale: conversion.ocrLocale,
        unlocked: conversion.unlocked || false,
      },
    });

    res.json({
      ok: true,
      resultType: "document",
      headline: "PDF 转 Word 已完成",
      detail: "已通过 Adobe PDF Services API 生成可编辑 Word 文档，尽量保留原 PDF 版式。",
      file: buildFileResponse(output, conversion.contentType, undefined, req),
      metaLines: [
        `原文件 ${file.name || inputName}`,
        conversion.pages ? `共 ${conversion.pages} 页` : "",
        `输出格式 ${conversion.format}`,
        `OCR ${conversion.ocrLocale}`,
        "模式 Adobe PDF Services",
        conversion.unlocked ? "已使用密码解锁 PDF" : "",
      ].filter(Boolean),
    });
  } catch (error) {
    console.error("[PDF to Word] 转换失败:", error);
    await recordOperation(req, {
      toolId: "pdf-to-word",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "PDF_TO_WORD_FAILED",
      errorMessage: error.message || "PDF 转 Word 失败",
      meta: {
        format,
        layout,
      },
    });

    sendError(
      res,
      500,
      error.code || "PDF_TO_WORD_FAILED",
      error.message || "PDF 转 Word 失败"
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});

app.use(async (error, req, res, next) => {
  const code = error && error.code ? error.code : "UNHANDLED_ERROR";
  const message = error && error.message ? error.message : "服务端发生未处理异常";

  if (req && req.path) {
    await recordOperation(req, {
      status: "failed",
      errorCode: code,
      errorMessage: message,
      meta: {
        unhandled: true,
      },
    });
  }

  if (res.headersSent) {
    next(error);
    return;
  }

  sendError(res, 500, code, message);
});

const server = http.createServer(app);
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

let shuttingDown = false;

async function closeResources() {
  await repository.close();
  await clientStateRepository.close();
}

function cleanupOldTempDirs() {
  try {
    if (!fs.existsSync(config.tempDir)) {
      return 0;
    }

    const items = fs.readdirSync(config.tempDir);
    let deletedCount = 0;
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    for (const item of items) {
      const itemPath = path.join(config.tempDir, item);
      try {
        const stats = fs.statSync(itemPath);
        if (stats.isDirectory() && stats.mtimeMs < oneHourAgo) {
          fs.rmSync(itemPath, { recursive: true, force: true });
          deletedCount++;
        }
      } catch (e) {
        console.error("[Temp Cleanup] 无法删除", itemPath, ":", e.message);
      }
    }

    return deletedCount;
  } catch (e) {
    console.error("[Temp Cleanup] 清理失败:", e);
    return 0;
  }
}

console.log(`📡 准备在 ${config.host}:${config.port} 监听...`);
server.listen(config.port, config.host, async (err) => {
  if (err) {
    console.error("❌ 启动失败:", err);
    return process.exit(1);
  }
  
  const outputDeletedCount = storage.cleanupExpiredLocalOutputs();
  const tempDeletedCount = cleanupOldTempDirs();
  
  // 启动时立即执行一次七牛云清理
  let qiniuCleanupResult = { deleted: 0 };
  if (storage.cleanupExpiredQiniuObjects) {
    try {
      qiniuCleanupResult = await storage.cleanupExpiredQiniuObjects(7);
    } catch (e) {
      console.warn("[Qiniu Cleanup] 首次清理失败:", e.message);
    }
  }
  
  console.log(
    `✅ sky-toolbox-backend running at http://${config.host}:${config.port}`
  );
  console.log(
    `   - 清理了 ${outputDeletedCount} 个过期输出文件`
  );
  console.log(
    `   - 清理了 ${tempDeletedCount} 个旧临时目录`
  );
  if (qiniuCleanupResult.deleted > 0) {
    console.log(
      `   - 清理了 ${qiniuCleanupResult.deleted} 个过期七牛云文件`
    );
  }

  // 定时清理临时目录（每30分钟）
  setInterval(() => {
    const count = cleanupOldTempDirs();
    if (count > 0) {
      console.log(`[Temp Cleanup] 清理 ${count} 个旧临时目录`);
    }
  }, 30 * 60 * 1000);

  // 定时清理七牛云过期文件（每天凌晨3点执行）
  const runQiniuCleanup = async () => {
    if (storage.cleanupExpiredQiniuObjects) {
      try {
        const result = await storage.cleanupExpiredQiniuObjects(7);
        if (result.deleted > 0) {
          console.log(`[Qiniu Cleanup] 清理了 ${result.deleted} 个过期文件`);
        } else if (result.error) {
          console.warn(`[Qiniu Cleanup] 清理失败: ${result.error}`);
        }
      } catch (e) {
        console.error("[Qiniu Cleanup] 定时清理异常:", e);
      }
    }
  };

  // 计算距离下次凌晨3点的时间
  const getNextCleanupTime = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next - now;
  };

  // 设置定时任务
  const scheduleQiniuCleanup = () => {
    const delay = getNextCleanupTime();
    console.log(`[Qiniu Cleanup] 下次清理将在 ${new Date(Date.now() + delay).toLocaleString()} 执行`);
    
    setTimeout(async () => {
      await runQiniuCleanup();
      // 之后每天执行一次
      setInterval(runQiniuCleanup, 24 * 60 * 60 * 1000);
    }, delay);
  };

  scheduleQiniuCleanup();
});

server.on("error", async (error) => {
  console.error("❌ server error:", error);
  if (!server.listening) {
    await closeResources();
    process.exit(1);
  }
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);

  server.close(async () => {
    await closeResources();
    process.exit(0);
  });

  setTimeout(async () => {
    await closeResources();
    process.exit(1);
  }, 8000).unref();
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
