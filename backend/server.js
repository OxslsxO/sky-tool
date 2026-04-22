require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const { PDFDocument } = require("pdf-lib");
const { createWorker } = require("tesseract.js");
const sharp = require("sharp");
const Pay = require("wechatpay-node-v3");
const {
  PDFServices,
  MimeType,
  ServicePrincipalCredentials,
  ClientConfig,
  Region,
  ExportPDFParams,
  ExportPDFTargetFormat,
  ExportOCRLocale,
  ExportPDFJob,
  ExportPDFResult,
  RemoveProtectionParams,
  RemoveProtectionJob,
  RemoveProtectionResult,
} = require("@adobe/pdfservices-node-sdk");
const { buildPhotoIdImage, warmPhotoIdModel } = require("./lib/photo-id");

// ==================== 微信支付初始化 ====================
let wechatPay = null;
function initWechatPay() {
  try {
    const appId = process.env.WECHAT_APPID;
    const mchId = process.env.WECHAT_MCH_ID;
    const apiV3Key = process.env.WECHAT_API_V3_KEY;
    const serialNo = process.env.WECHAT_SERIAL_NO;
    const privateKey = process.env.WECHAT_PRIVATE_KEY;
    const publicKey = process.env.WECHAT_PUBLIC_KEY;

    if (!appId || !mchId || !apiV3Key || !serialNo || !privateKey || !publicKey) {
      console.warn("⚠️ 微信支付配置不完整，将使用模拟支付");
      return null;
    }

    // 确保 PEM 格式正确
    const cleanedPrivateKey = privateKey.replace(/\\n/g, "\n").trim();
    const cleanedPublicKey = publicKey.replace(/\\n/g, "\n").trim();

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
  } catch (error) {
    console.error("❌ 微信支付初始化失败:", error && error.message ? error.message : error);
    return null;
  }
}

wechatPay = initWechatPay();

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
app.use(express.json({ limit: "80mb" }));
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

if (isTruthyEnv(process.env.PHOTO_ID_WARM_MODEL) && process.env.PHOTO_ID_DISABLE_MODEL !== 'true') {
  setTimeout(() => {
    warmPhotoIdModel(config)
      .then(() => {
        console.log("photo-id model warmed");
      })
      .catch((error) => {
        console.warn("photo-id model warmup failed", error && error.message ? error.message : error);
      });
  }, 5000); // 延迟5秒预热，避免启动时内存压力
}

function makeId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function getPublicBaseUrl(req) {
  return config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
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

function createOutputFileName(extension, baseName) {
  const normalizedExtension = normalizeExtension(extension);
  const safeBaseName = sanitizeBaseName(baseName);
  const suffix = makeId();
  return safeBaseName
    ? `${safeBaseName}-${suffix}.${normalizedExtension}`
    : `${suffix}.${normalizedExtension}`;
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
  const stored = await storage.saveBuffer(req, buffer, {
    folder: options.folder || "outputs",
    fileName: createOutputFileName(options.extension, options.baseName),
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

function buildFileResponse(storedFile, mimeType, label) {
  return {
    name: storedFile.fileName,
    url: storedFile.url,
    sizeBytes: storedFile.sizeBytes,
    mimeType,
    label: label || storedFile.fileName,
    provider: storedFile.provider,
    key: storedFile.key || "",
    externalUrl: storedFile.externalUrl || "",
    fallbackUrl: storedFile.fallbackUrl || "",
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
  const fileBuffer = decodeBase64File(file);
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

  const fileBuffer = decodeBase64File(file);
  const variants = await prepareOcrImageVariants(fileBuffer, layoutLabel);
  const worker = await createWorker(normalizeOcrLanguage(languageLabel));

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

app.get("/files/qiniu", async (req, res, next) => {
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

app.use("/files", express.static(config.outputDir));

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

app.post("/api/photo-id", async (req, res) => {
  const { file, size, background, retouch } = req.body || {};

  try {
    const inputBuffer = decodeBase64File(file);
    const result = await buildPhotoIdImage(config, inputBuffer, {
      size,
      background,
      retouch,
    });
    const output = await saveOutputFile(req, result.buffer, {
      extension: "png",
      contentType: "image/png",
      baseName: "photo-id",
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
        ...buildFileResponse(output, "image/png", "证件照.png"),
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
      file: buildFileResponse(output, mimeType),
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

const pendingOrders = new Map();

// 商品/会员套餐配置
const PRODUCTS = {
  member: {
    month: { name: "月度会员", price: 990 }, // 分
    season: { name: "季度会员", price: 2490 }, // 分
    year: { name: "年度会员", price: 7990 }, // 分
  },
  points: {
    p100: { name: "100积分", price: 100 }, // 分
    p500: { name: "500积分", price: 450 }, // 分
    p2000: { name: "2000积分", price: 1680 }, // 分
  },
};

app.post("/api/pay/create", async (req, res) => {
  const { type, itemId, userId, deviceId } = req.body || {};

  if (!type || !itemId) {
    return res.status(400).json({ error: "MISSING_PARAMS", message: "缺少 type 或 itemId" });
  }

  const orderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const product = PRODUCTS[type]?.[itemId];

  if (!product) {
    return res.status(400).json({ error: "INVALID_PRODUCT", message: "无效的商品" });
  }

  let payment = null;

  if (wechatPay) {
    try {
      console.log(`[支付] 创建订单 ${orderId} - ${product.name} (${product.price}分)`);
      
      const params = {
        appid: process.env.WECHAT_APPID,
        mchid: process.env.WECHAT_MCH_ID,
        description: product.name,
        out_trade_no: orderId,
        notify_url: `${process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3100"}/api/pay/notify`,
        amount: {
          total: product.price,
          currency: "CNY",
        },
        payer: {
          openid: userId || "otO5s0d40q0jV8QqN5L5W8wZ9w", // 提供一个测试 openid
        },
      };

      const result = await wechatPay.transactions_jsapi(params);

      if (result.status !== 200) {
        console.error("[支付] 预下单失败:", result);
        throw new Error("创建订单失败");
      }

      console.log(`[支付] 预下单成功:`, result.data);
      
      // wechatpay-node-v3 已经在 data 里返回了签好名的小程序支付参数
      payment = result.data;

      console.log(`[支付] 返回小程序支付参数:`, payment);
    } catch (error) {
      console.error("❌ 微信支付创建订单失败:", error && error.message ? error.message : error);
    }
  }

  if (!payment) {
    console.warn("⚠️ 回退到模拟支付模式");
    const nonceStr = crypto.randomBytes(16).toString("hex");
    const timeStamp = String(Math.floor(Date.now() / 1000));

    payment = {
      timeStamp,
      nonceStr,
      package: `prepay_id=wx${Date.now()}`,
      signType: "MD5",
      paySign: crypto.createHash("md5").update(`${orderId}${nonceStr}${timeStamp}`).digest("hex"),
    };
  }

  pendingOrders.set(orderId, {
    type,
    itemId,
    userId,
    deviceId,
    amount: product.price,
    productName: product.name,
    status: "pending",
    createdAt: Date.now(),
  });

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

  if (wechatPay) {
    try {
      console.log(`[支付] 查询订单 ${orderId}`);
      const result = await wechatPay.query({ out_trade_no: orderId });

      if (result.status === 200 && (result.data.trade_state === "SUCCESS" || result.data.trade_state === "TRADE_SUCCESS")) {
        order.status = "paid";
        order.paidAt = Date.now();
        order.transactionId = result.data.transaction_id;
        pendingOrders.set(orderId, order);
        console.log(`✅ 订单 ${orderId} 支付成功`);
      } else {
        console.log(`[支付] 订单 ${orderId} 未支付:`, result.data);
      }
    } catch (error) {
      console.error("[支付] 查询订单失败:", error);
    }
  }

  res.json({ success: true, orderId, status: order.status, type: order.type, itemId: order.itemId });
});

app.post("/api/pay/notify", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    if (!wechatPay) {
      console.warn("[支付] 收到模拟支付通知");
      const body = JSON.parse(req.body);
      if (body.out_trade_no) {
        const order = pendingOrders.get(body.out_trade_no);
        if (order) {
          order.status = "paid";
          order.paidAt = Date.now();
          order.transactionId = `SIM-${Date.now()}`;
          pendingOrders.set(body.out_trade_no, order);
          console.log(`✅ 模拟支付订单 ${body.out_trade_no} 标记为已支付`);
        }
      }
      return res.json({ code: "SUCCESS", message: "" });
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
        pendingOrders.set(orderId, order);
        console.log(`✅ 订单 ${orderId} 支付成功 (transaction_id: ${result.transaction_id})`);
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
    // 这里是模拟微信登录
    // 实际生产环境需要调用微信 code2Session 接口
    
    // 查找或创建用户
    let user = null;
    let isNewUser = false;
    const collections = await clientStateRepository.getCollections();
    
    let mockOpenid = null;
    
    if (collections) {
      // MongoDB 模式
      
      // 1. 先尝试查找最近有活动的用户（有积分或会员的）
      const recentActiveUser = await collections.users.findOne(
        { $or: [ { memberActive: true }, { points: { $gt: 0 } } ] },
        { sort: { updatedAt: -1 } }
      );
      
      if (recentActiveUser) {
        // 找到了有数据的用户，直接用这个用户！
        user = recentActiveUser;
        mockOpenid = user.openid;
        console.log(`[Auth] 找到有数据的用户，直接登录: ${mockOpenid}`);
      } else {
        // 没找到有数据的用户，生成一个新 openid
        mockOpenid = `wx_user_${crypto.createHash('md5').update(code).digest('hex').substring(0, 12)}`;
        console.log(`[Auth] 微信登录模拟: ${mockOpenid}`);
        
        // 查找是否已有这个 openid 的用户
        user = await collections.users.findOne({ openid: mockOpenid });
        
        if (!user) {
          // 新用户，创建
          isNewUser = true;
          const now = new Date().toISOString();
          const newUser = {
            userId: mockOpenid, // 用 openid 作为 userId
            openid: mockOpenid,
            nickname: userInfo?.nickName || "微信用户",
            avatar: userInfo?.avatarUrl || "",
            gender: userInfo?.gender || 0,
            points: 0,
            memberPlan: null,
            memberActive: false,
            memberExpire: null,
            phoneNumber: null,
            createdAt: now,
            updatedAt: now,
          };
          
          await collections.users.insertOne(newUser);
          user = newUser;
          
          console.log(`[Auth] 创建新用户: ${mockOpenid}`);
        }
      }
      
      if (user && user.openid) {
        // 老用户，更新一下信息
        const now = new Date().toISOString();
        await collections.users.updateOne(
          { openid: user.openid },
          {
            $set: {
              updatedAt: now,
              ...(userInfo?.nickName && { nickname: userInfo.nickName }),
              ...(userInfo?.avatarUrl && { avatar: userInfo.avatarUrl }),
            },
          }
        );
        
        // 重新获取最新的用户信息
        user = await collections.users.findOne({ openid: user.openid });
        
        console.log(`[Auth] 老用户登录: ${user.openid}`);
      }
    } else {
      // 文件模式（简单模拟）
      if (!mockOpenid) {
        mockOpenid = `wx_user_${crypto.createHash('md5').update(code).digest('hex').substring(0, 12)}`;
      }
      user = {
        userId: mockOpenid,
        openid: mockOpenid,
        nickname: userInfo?.nickName || "微信用户",
        avatar: userInfo?.avatarUrl || "",
        points: 0,
        memberActive: false,
        phoneNumber: null,
      };
    }

    await recordOperation(req, {
      toolId: "auth-login",
      status: "success",
      meta: { openid: mockOpenid },
    });

    // 返回用户信息（不包含敏感字段）
    const safeUser = {
      userId: user.userId,
      openid: user.openid,
      nickname: user.nickname,
      avatar: user.avatar,
      points: user.points,
      memberPlan: user.memberPlan,
      memberActive: user.memberActive,
      memberExpire: user.memberExpire,
      phoneNumber: user.phoneNumber,
    };

    res.json({
      ok: true,
      user: safeUser,
      isNewUser: isNewUser,
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

app.post("/api/auth/bind-phone", async (req, res) => {
  const { code, userId: reqUserId, openid: reqOpenid } = req.body;

  try {
    // 模拟获取手机号（实际需要调用微信手机号接口）
    // 为了演示，我们用一个模拟的手机号
    const mockPhone = `138${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
    
    console.log(`[Auth] 绑定手机号模拟: ${reqOpenid || reqUserId} -> ${mockPhone}`);

    // 更新用户
    const collections = await clientStateRepository.getCollections();
    let user = null;
    
    if (collections) {
      // 查找用户策略：
      // 1. 先用 openid 查找（如果有）
      // 2. 再用 userId 查找（如果有）
      // 3. 最后找最近更新的有数据的用户
      if (reqOpenid) {
        user = await collections.users.findOne({ openid: reqOpenid });
      }
      if (!user && reqUserId) {
        user = await collections.users.findOne({ userId: reqUserId });
      }
      if (!user) {
        // 找最近有数据的用户
        const recentUser = await collections.users.findOne(
          { $or: [ { memberActive: true }, { points: { $gt: 0 } } ] },
          { sort: { updatedAt: -1 } }
        );
        user = recentUser;
      }
      // 如果还没有，找最近更新的任意用户
      if (!user) {
        const recentUser = await collections.users
          .find({})
          .sort({ updatedAt: -1 })
          .limit(1)
          .toArray();
        user = recentUser.length > 0 ? recentUser[0] : null;
      }
      
      if (user) {
        // 更新手机号
        await collections.users.updateOne(
          { userId: user.userId },
          {
            $set: {
              phoneNumber: mockPhone,
              updatedAt: new Date().toISOString(),
            },
          }
        );
        
        // 重新获取完整用户信息
        user = await collections.users.findOne({ userId: user.userId });
        
        console.log(`[Auth] 手机号绑定成功: ${user.userId} -> ${mockPhone}`);
      }
    }

    if (!user) {
      sendError(res, 404, "USER_NOT_FOUND", "User not found");
      return;
    }

    await recordOperation(req, {
      toolId: "auth-bind-phone",
      status: "success",
      meta: { userId: user.userId },
    });

    // 返回用户信息
    const safeUser = {
      userId: user.userId,
      openid: user.openid,
      nickname: user.nickname,
      avatar: user.avatar,
      points: user.points,
      memberPlan: user.memberPlan,
      memberActive: user.memberActive,
      memberExpire: user.memberExpire,
      phoneNumber: user.phoneNumber,
    };

    res.json({
      ok: true,
      user: safeUser,
    });
  } catch (error) {
    console.error("[Auth] 绑定手机失败:", error);
    await recordOperation(req, {
      toolId: "auth-bind-phone",
      status: "failed",
      errorCode: error.code || "BIND_FAILED",
      errorMessage: error.message,
    });

    sendError(res, 500, "BIND_FAILED", "Bind failed");
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
        memberPlan: state.user.memberPlan,
        memberActive: state.user.memberActive,
        memberExpire: state.user.memberExpire,
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
  const tryRecover = req.query.tryRecover === "1";

  try {
    let state = await clientStateRepository.getState({
      userId,
      deviceId,
    });

    // 如果没找到，但在恢复模式，尝试查找最近的用户
    if (!state && tryRecover) {
      console.log("🔄 恢复模式：未找到精确匹配，尝试查找最近用户...");
      state = await clientStateRepository.tryFindRecentState();
      
      if (state) {
        console.log("✅ 恢复模式：找到最近用户:", state.user && state.user.userId);
      }
    }

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
        tryRecover,
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
        tryRecover,
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
  const files = req.body.files || [];
  try {
    const results = [];
    for (const file of files) {
      assertPdfFile(file);
      const pdfBuffer = decodeBase64File(file);
      const pdfDoc = await PDFDocument.load(pdfBuffer);
      const pageCount = pdfDoc.getPageCount();
      results.push({
        name: file.name || "",
        sizeBytes: file.sizeBytes || 0,
        pageCount,
      });
    }
    res.json({
      ok: true,
      files: results,
    });
  } catch (error) {
    sendError(res, 400, "PDF_PREVIEW_FAILED", error.message || "PDF预览失败");
  }
});

app.post("/api/pdf/merge", async (req, res) => {
  const files = req.body.files || [];

  try {
    if (files.length < 2) {
      sendError(res, 400, "INVALID_FILE_COUNT", "至少需要 2 份 PDF 文件");
      return;
    }

    const mergedPdf = await PDFDocument.create();
    let totalPages = 0;

    for (const file of files) {
      assertPdfFile(file);
      const sourcePdf = await PDFDocument.load(decodeBase64File(file));
      const pageCount = sourcePdf.getPageCount();
      totalPages += pageCount;
      const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const bytes = await mergedPdf.save({ useObjectStreams: true });
    const output = await saveOutputFile(req, Buffer.from(bytes), {
      extension: "pdf",
      contentType: "application/pdf",
      baseName: "merged",
    });

    await recordOperation(req, {
      toolId: "pdf-merge",
      status: "success",
      inputFiles: files.map((file) => ({
        name: file.name || "",
        sizeBytes: file.sizeBytes || 0,
      })),
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
      file: buildFileResponse(output, "application/pdf"),
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
  const file = req.body.file;
  const splitMode = req.body.splitMode || "";
  const pageRange = req.body.pageRange || "1";

  try {
    assertPdfFile(file);
    const pdfDoc = await PDFDocument.load(decodeBase64File(file));
    const totalPages = pdfDoc.getPageCount();
    const normalizedSplitMode = normalizeSplitMode(splitMode);

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
      const output = await saveOutputFile(req, Buffer.from(bytes), {
        extension: "pdf",
        contentType: "application/pdf",
        baseName: `split-${index + 1}`,
      });

      outputs.push(
        buildFileResponse(
          output,
          "application/pdf",
          `拆分 ${index + 1} - 第 ${pages.map((page) => page + 1).join(", ")} 页`
        )
      );
    }

    await recordOperation(req, {
      toolId: "pdf-split",
      status: "success",
      inputFiles: [
        {
          name: file.name || "",
          sizeBytes: file.sizeBytes || 0,
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
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
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
  const file = req.body.file;
  const mode = req.body.mode || "";

  try {
    assertPdfFile(file);

    const pdfDoc = await PDFDocument.load(decodeBase64File(file));
    const bytes = await pdfDoc.save({ useObjectStreams: true });
    const output = await saveOutputFile(req, Buffer.from(bytes), {
      extension: "pdf",
      contentType: "application/pdf",
      baseName: "compressed",
    });

    await recordOperation(req, {
      toolId: "pdf-compress",
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
        mode,
      },
    });

    res.json({
      ok: true,
      resultType: "document",
      headline: "PDF 基础优化已完成",
      detail: "已完成基础压缩优化，实际体积变化会受原文档结构影响。",
      file: buildFileResponse(output, "application/pdf"),
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

app.post("/api/file/compress", async (req, res) => {
  const file = req.body.file;
  const mode = req.body.mode || "";

  try {
    if (!file || !file.base64) {
      throw new Error("需要上传文件");
    }

    const ext = normalizeExtension(file.name ? file.name.split('.').pop() : "bin");
    const fileBytes = decodeBase64File(file);

    let outputBytes = fileBytes;
    let outputExt = ext;
    let compressed = false;
    let compressionNote = "当前文件未发现可进一步压缩的空间";

    // 根据文件类型进行不同的压缩处理
    if (ext === "pdf") {
      // PDF压缩 - 使用现有的PDF压缩逻辑
      const pdfDoc = await PDFDocument.load(fileBytes);
      const selected = selectSmallerOutput(fileBytes, Buffer.from(await pdfDoc.save({ useObjectStreams: true })));
      outputBytes = selected.bytes;
      compressed = selected.compressed;
      compressionNote = compressed ? "已完成 PDF 基础结构优化" : "这个 PDF 已经比较紧凑，基础优化后体积没有下降";
      outputExt = "pdf";
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
    } else if (["mp3", "wav", "flac", "m4a", "aac", "ogg"].includes(ext)) {
      // 音频压缩 - 使用ffmpeg
      const ffmpegPath = resolveFfmpegPath();
      if (ffmpegPath) {
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

          const result = await new Promise((resolve, reject) => {
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
            // 忽略清理错误
          }
        } catch (audioError) {
          console.warn("音频压缩失败，使用原文件:", audioError);
          outputBytes = fileBytes;
          compressionNote = "音频压缩失败，已保留原文件";
        }
      } else {
        compressionNote = "当前服务未检测到 FFmpeg，已保留原文件";
      }
    } else if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"].includes(ext)) {
      // 视频压缩 - 使用ffmpeg
      const ffmpegPath = resolveFfmpegPath();
      if (ffmpegPath) {
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
          compressionNote = compressed ? "已使用 FFmpeg 重新编码音频" : "音频重新编码后没有变小，已保留原文件";
          outputExt = ext;

          try {
            fs.unlinkSync(tempInputPath);
            fs.unlinkSync(tempOutputPath);
          } catch (cleanError) {
            // 忽略清理错误
          }
        } catch (videoError) {
          console.warn("视频压缩失败，使用原文件:", videoError);
          outputBytes = fileBytes;
          compressionNote = "视频压缩失败，已保留原文件";
        }
      } else {
        compressionNote = "当前服务未检测到 FFmpeg，已保留原文件";
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

    const output = await saveOutputFile(req, outputBytes, {
      extension: outputExt,
      baseName: "compressed",
    });

    await recordOperation(req, {
      toolId: "file-compress",
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
        mode,
        extension: ext,
        compressed,
        savedBytes,
        savedPercent,
      },
    });

    const responseFile = buildFileResponse(output, "application/octet-stream");
    responseFile.name = file.name || responseFile.name;
    responseFile.label = file.name || responseFile.label;

    res.json({
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
    });
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
  return ["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(String(ext || "").toLowerCase());
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

function runFfmpegConvert(ffmpegPath, inputFilePath, outputFilePath, targetFormat, quality) {
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
    const child = spawn(ffmpegPath, args);

    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
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
      resolve();
    });
  });
}

app.post("/api/audio/convert", async (req, res) => {
  const file = req.body.file;
  const target = req.body.target || "MP3";
  const quality = req.body.quality || "标准";
  const ffmpegPath = resolveFfmpegPath();

  if (!ffmpegPath) {
    await recordOperation(req, {
      toolId: "audio-convert",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: file.name || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: "FFMPEG_UNAVAILABLE",
      errorMessage: "当前服务未检测到 FFmpeg",
      meta: {
        target,
        quality,
      },
    });

    sendError(
      res,
      501,
      "FFMPEG_UNAVAILABLE",
      "当前服务端未检测到 FFmpeg，请安装后再启用音视频转换。"
    );
    return;
  }

  let tempDir = "";

  try {
    tempDir = fs.mkdtempSync(path.join(config.tempDir, "media-"));
    const originalInputName = file && file.name ? file.name : `media-${makeId()}.mp4`;

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
      const error = new Error("Unsupported target format");
      error.code = "UNSUPPORTED_MEDIA_TARGET";
      throw error;
    }

    if (targetIsVideo && inputIsAudio) {
      const error = new Error("Audio files cannot be directly converted to video formats");
      error.code = "AUDIO_TO_VIDEO_UNSUPPORTED";
      throw error;
    }

    const originalBaseName = path.parse(originalInputName).name || "media";
    const safeBaseName = originalBaseName.replace(/[^\w\u4e00-\u9fa5\-_]/g, "_");
    const outputName = `${safeBaseName}.${targetExt}`;
    const outputPath = path.join(tempDir, outputName);

    const fileBuffer = decodeBase64File(file);
    console.log("[Media Convert] 写入文件:", inputPath, "大小:", fileBuffer.length, "bytes");

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

    let formatMatch = true;
    let formatHint = "";

    if (inputExt.toLowerCase() === ".flac" && !isFlac) {
      formatMatch = false;
      if (isNcm) formatHint = "这看起来是网易云音乐的加密格式 (.ncm)，不是真正的 FLAC。";
      else if (isKgm) formatHint = "这看起来是酷狗音乐的加密格式 (.kgm)，不是真正的 FLAC。";
      else if (isQmc) formatHint = "这看起来是 QQ 音乐的加密格式 (.qmc)，不是真正的 FLAC。";
      else formatHint = "这个文件的扩展名是 .flac，但内容不是标准 FLAC 格式。";
    } else if (inputExt.toLowerCase() === ".mp3" && !isMp3) {
      formatMatch = false;
      formatHint = "这个文件的扩展名是 .mp3，但内容看起来不像是标准 MP3 格式。";
    } else if (inputExt.toLowerCase() === ".wav" && !isWav) {
      formatMatch = false;
      formatHint = "这个文件的扩展名是 .wav，但内容看起来不像是标准 WAV 格式。";
    }

    if (!formatMatch) {
      const error = new Error(formatHint);
      error.code = "INVALID_MEDIA_FORMAT";
      throw error;
    }

    fs.writeFileSync(inputPath, fileBuffer);

    const stats = fs.statSync(inputPath);
    console.log("[Media Convert] 文件已写入，实际大小:", stats.size, "bytes");
    console.log("[Media Convert] 输出路径:", outputPath);

    await runFfmpegConvert(ffmpegPath, inputPath, outputPath, target, quality);

    const bytes = fs.readFileSync(outputPath);
    const contentType = getMediaContentType(targetExt);
    const output = await saveOutputFile(req, bytes, {
      extension: targetExt,
      contentType,
      baseName: safeBaseName,
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

    res.json({
      ok: true,
      resultType: "document",
      headline: "音视频格式转换已完成",
      detail: `已转换为 ${target} 格式，可直接下载使用。`,
      file: buildFileResponse(output, contentType),
      metaLines: [
        `原文件 ${originalInputName}`,
        `目标格式 ${target}`,
        `质量 ${quality}`,
      ].filter(Boolean),
    });
  } catch (error) {
    console.error("[Media Convert] 错误:", error);
    let errorMessage = "音视频转换失败";
    let errorHint = "";

    const errMsg = (error.message || "").toLowerCase();
    if (errMsg.includes("invalid data") || errMsg.includes("could not find codec")) {
      errorMessage = "无法解析音视频文件";
      errorHint = "请检查文件是否损坏，或尝试转换为其他格式";
    } else if (error.code === "AUDIO_TO_VIDEO_UNSUPPORTED") {
      errorMessage = "音频不能直接转换为视频";
      errorHint = "请选择 MP3、WAV、FLAC、OGG、M4A 或 AAC 等音频目标格式";
    } else if (errMsg.includes("ffmpeg")) {
      errorMessage = "FFmpeg 执行错误";
    }

    await recordOperation(req, {
      toolId: "audio-convert",
      status: "failed",
      inputFiles: file
        ? [
          {
            name: originalInputName || "",
            sizeBytes: file.sizeBytes || 0,
          },
        ]
        : [],
      errorCode: error.code || "MEDIA_CONVERT_FAILED",
      errorMessage: errorMessage,
      meta: {
        target,
        quality,
      },
    });

    sendError(
      res,
      500,
      error.code || "MEDIA_CONVERT_FAILED",
      errorHint ? `${errorMessage}??{errorHint}` : errorMessage
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});

app.post("/api/ocr/image", async (req, res) => {
  const file = req.body.file;
  const language = req.body.language || "中英混合";
  const layout = req.body.layout || "";

  try {
    const result = await recognizeTextFromImage(file, language, layout);
    const text = result.text || "";

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

    res.json({
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
    });
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

app.post("/api/office/to-pdf", async (req, res) => {
  const file = req.body.file;
  const quality = req.body.quality || "";
  const pageMode = req.body.pageMode || "";
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

  let tempDir = "";

  try {
    tempDir = fs.mkdtempSync(path.join(config.tempDir, "office-"));
    const randomId = makeId();
    const inputExt = file && file.name ? path.extname(file.name) : ".docx";
    const inputName = `input-${randomId}${inputExt}`;
    const inputPath = path.join(tempDir, inputName);

    fs.writeFileSync(inputPath, decodeBase64File(file));
    await runSofficeConvert(sofficePath, inputPath, tempDir);

    const outputFileName = `input-${randomId}.pdf`;
    const outputPath = path.join(tempDir, outputFileName);
    const bytes = fs.readFileSync(outputPath);
    const output = await saveOutputFile(req, bytes, {
      extension: "pdf",
      contentType: "application/pdf",
      baseName: path.parse(inputName).name,
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

    res.json({
      ok: true,
      resultType: "document",
      headline: "Office 转 PDF 已完成",
      detail: "文档已导出为 PDF，可直接打开或继续压缩、合并。",
      file: buildFileResponse(output, "application/pdf"),
      metaLines: [
        `原文件 ${file.name || inputName}`,
        quality ? `清晰度 ${quality}` : "",
        pageMode ? `页面策略 ${pageMode}` : "",
      ].filter(Boolean),
    });
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
  } finally {
    cleanupTempDir(tempDir);
  }
});

function createCodedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getAdobePdfServicesCredentials() {
  const clientId = process.env.PDF_SERVICES_CLIENT_ID || process.env.ADOBE_PDF_SERVICES_CLIENT_ID;
  const clientSecret = process.env.PDF_SERVICES_CLIENT_SECRET || process.env.ADOBE_PDF_SERVICES_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw createCodedError(
      "Adobe PDF Services API 未配置，请设置 PDF_SERVICES_CLIENT_ID 和 PDF_SERVICES_CLIENT_SECRET",
      "PDF_TO_WORD_ADOBE_NOT_CONFIGURED"
    );
  }

  return new ServicePrincipalCredentials({ clientId, clientSecret });
}

function buildAdobeClientConfig() {
  const configOptions = {};
  const timeoutMs = Number(process.env.PDF_SERVICES_TIMEOUT_MS || process.env.ADOBE_PDF_SERVICES_TIMEOUT_MS || 120000);
  const region = String(process.env.PDF_SERVICES_REGION || process.env.ADOBE_PDF_SERVICES_REGION || "").trim().toUpperCase();

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    configOptions.timeout = timeoutMs;
  }

  if (region === "EU") {
    configOptions.region = Region.EU;
  } else if (region === "US") {
    configOptions.region = Region.US;
  }

  return new ClientConfig(configOptions);
}

function createAdobePdfServicesClient() {
  return new PDFServices({
    credentials: getAdobePdfServicesCredentials(),
    clientConfig: buildAdobeClientConfig(),
  });
}

function getPdfToWordOutputConfig(format) {
  const normalizedFormat = String(format || "DOCX").trim().toUpperCase();
  if (normalizedFormat === "DOC") {
    return {
      extension: "doc",
      contentType: MimeType.DOC,
      targetFormat: ExportPDFTargetFormat.DOC,
      format: "DOC",
    };
  }

  return {
    extension: "docx",
    contentType: MimeType.DOCX,
    targetFormat: ExportPDFTargetFormat.DOCX,
    format: "DOCX",
  };
}

function getAdobeExportOcrLocale(locale) {
  const requestedLocale = String(locale || process.env.PDF_SERVICES_OCR_LOCALE || "zh-CN").trim();
  const localeEntry = Object.entries(ExportOCRLocale).find(
    ([key, value]) =>
      key.toLowerCase() === requestedLocale.toLowerCase().replace(/-/g, "_") ||
      value.toLowerCase() === requestedLocale.toLowerCase()
  );

  return localeEntry ? localeEntry[1] : ExportOCRLocale.ZH_CN;
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
      mimeType: MimeType.PDF,
    });
    uploadedAssets.push(inputAsset);

    let exportInputAsset = inputAsset;
    let wasUnlocked = false;

    // 处理加密 PDF
    if (password) {
      const removeProtectionParams = new RemoveProtectionParams({ password });
      const removeProtectionJob = new RemoveProtectionJob({
        inputAsset: exportInputAsset,
        params: removeProtectionParams,
      });
      const removeProtectionPollingURL = await pdfServices.submit({ job: removeProtectionJob });
      const removeProtectionResponse = await pdfServices.getJobResult({
        pollingURL: removeProtectionPollingURL,
        resultType: RemoveProtectionResult,
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
    const exportParams = new ExportPDFParams({
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

    const exportJob = new ExportPDFJob({
      inputAsset: exportInputAsset,
      params: exportParams,
    });
    const exportPollingURL = await pdfServices.submit({ job: exportJob });
    const exportResponse = await pdfServices.getJobResult({
      pollingURL: exportPollingURL,
      resultType: ExportPDFResult,
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
  const file = req.body.file;
  const format = req.body.format || "DOCX";
  const layout = req.body.layout || "exact";

  let tempDir = "";

  try {
    assertPdfFile(file);
    tempDir = fs.mkdtempSync(path.join(config.tempDir, "pdf-word-"));
    console.log("[PDF to Word] 临时目录:", tempDir);

    const randomId = makeId();
    const inputName = `input-${randomId}.pdf`;

    const fileBuffer = decodeBase64File(file);
    console.log("[PDF to Word] 输入文件大小:", fileBuffer.length, "bytes");

    const conversion = await convertPdfToWordWithAdobe(fileBuffer, inputName, tempDir, {
      format,
      ocrLocale: req.body.ocrLocale || req.body.language || req.body.locale || "",
      password: req.body.password || req.body.pdfPassword || "",
      layout: layout, // 🔥 新增：传递布局模式
    });

    console.log("[PDF to Word] Word文档生成完成, 大小:", conversion.buffer.length, "bytes");

    const output = await saveOutputFile(req, conversion.buffer, {
      extension: conversion.extension,
      contentType: conversion.contentType,
      baseName: path.parse(inputName).name,
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
      file: buildFileResponse(output, conversion.contentType),
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

server.once("listening", () => {
  const outputDeletedCount = storage.cleanupExpiredLocalOutputs();
  const tempDeletedCount = cleanupOldTempDirs();
  console.log(
    `sky-toolbox-backend running at http://${config.host}:${config.port} (cleaned ${outputDeletedCount} outputs, ${tempDeletedCount} temp dirs)`
  );

  setInterval(() => {
    const count = cleanupOldTempDirs();
    if (count > 0) {
      console.log(`[Temp Cleanup] 清理 ${count} 个旧临时目录`);
    }
  }, 30 * 60 * 1000);
});

server.once("error", async (error) => {
  console.error(
    `failed to start sky-toolbox-backend at http://${config.host}:${config.port}`,
    error
  );
  await closeResources();
  process.exit(1);
});

server.listen(config.port, config.host);

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
