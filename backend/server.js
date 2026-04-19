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

if (isTruthyEnv(process.env.PHOTO_ID_WARM_MODEL)) {
  setTimeout(() => {
    warmPhotoIdModel(config)
      .then(() => {
        console.log("photo-id model warmed");
      })
      .catch((error) => {
        console.warn("photo-id model warmup failed", error && error.message ? error.message : error);
      });
  }, 0);
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
    const error = new Error("缂哄皯鏂囦欢鍐呭");
    error.code = "MISSING_FILE_CONTENT";
    throw error;
  }

  const buffer = Buffer.from(file.base64, "base64");
  if (!buffer.length) {
    const error = new Error("鏂囦欢鍐呭涓虹┖鎴栫紪鐮佷笉姝ｇ‘");
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
    sendError(res, 401, "UNAUTHORIZED", "缂哄皯鏈夋晥鐨勬湇鍔¤闂护鐗?)";
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
    const error = new Error("鍙敮鎸?PDF 鏂囦欢");
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
    const error = new Error("椤电爜鑼冨洿涓嶈兘涓虹┖");
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
        const error = new Error(`鏃犳晥鐨勯〉鐮佽寖鍥达細${part}`);
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
      const error = new Error(`鏃犳晥鐨勯〉鐮侊細${part}`);
      error.code = "INVALID_PAGE_RANGE";
      throw error;
    }

    pageIndexes.push(page - 1);
  });

  const unique = Array.from(new Set(pageIndexes)).filter(
    (pageIndex) => pageIndex >= 0 && pageIndex < totalPages
  );

  if (!unique.length) {
    const error = new Error("椤电爜瓒呭嚭鏂囨。鑼冨洿");
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
    label.includes("鑼冨洿") ||
    label.includes("page") ||
    label.includes("range") ||
    label.includes("閹稿銆?")
  ) {
    return "page-range";
  }

  return "all-pages";
}

function normalizeOcrLanguage(languageLabel) {
  const label = String(languageLabel || "").trim().toLowerCase();

  if (label === "eng" || label === "english" || label.includes("鑻辨枃")) {
    return "eng";
  }

  if (label === "chi_sim" || label === "chinese" || label.includes("涓枃")) {
    return "chi_sim";
  }

  return "chi_sim+eng";
}

function getOcrPageSegMode(layoutLabel) {
  const label = String(layoutLabel || "").trim().toLowerCase();

  if (label.includes("琛ㄦ牸") || label.includes("table")) {
    return "6";
  }

  if (label.includes("鎵嬪啓") || label.includes("sparse")) {
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

  if (!String(layoutLabel || "").includes("鎵嬪啓")) {
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
    throw new Error(data.error_description || data.error || "鐧惧害 OCR access_token 鑾峰彇澶辫触");
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
    throw new Error(data.error_msg || data.error_description || `鐧惧害 OCR 璋冪敤澶辫触 ${data.error_code || response.status}`);
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
      console.warn("[OCR] 鐧惧害 OCR 璋冪敤澶辫触锛屽洖閫€鍒?Tesseract:", error && error.message ? error.message : error);
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
    console.log("[LibreOffice] 寮€濮嬭浆鎹? 鍛戒护:", sofficePath, args.join(" "));

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
      console.log("[LibreOffice] 璁剧疆鐜鍙橀噺, sofficeDir:", sofficeDir, "libreOfficeRoot:", libreOfficeRoot);
    }

    let stderrOutput = "";
    let stdoutOutput = "";
    const child = spawn(sofficePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env
    });

    let timeoutId = setTimeout(() => {
      console.error("[LibreOffice] 杞崲瓒呮椂锛屾鍦ㄦ潃姝昏繘绋?..");
      child.kill("SIGKILL");
      reject(new Error("LibreOffice 杞崲瓒呮椂 (瓒呰繃 60 绉?"));
    }, 60000);

    child.stdout.on("data", (data) => {
      stdoutOutput += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      console.error("[LibreOffice] 鍚姩閿欒:", err);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      console.log("[LibreOffice] 杩涚▼閫€鍑? code:", code);
      if (code !== 0) {
        console.error("[LibreOffice] stdout:", stdoutOutput);
        console.error("[LibreOffice] stderr:", stderrOutput);
        reject(new Error(`LibreOffice 杞崲澶辫触 (code: ${code}): ${stderrOutput}`));
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
  if (mode === "浣撶Н浼樺厛") {
    return 58;
  }

  if (mode === "璐ㄩ噺浼樺厛") {
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
  });
});

app.get("/files/qiniu", async (req, res, next) => {
  try {
    const { provider } = storage.getHealth();
    if (provider !== "qiniu") {
      sendError(res, 404, "QINIU_NOT_ENABLED", "褰撳墠鏈嶅姟鏈惎鐢ㄤ竷鐗涗簯瀛樺偍");
      return;
    }

    const key = String(req.query.key || "").trim();
    if (!key) {
      sendError(res, 400, "MISSING_QINIU_KEY", "缂哄皯涓冪墰浜戞枃浠舵爣璇?)";
      return;
    }

    if (config.qiniu.prefix && !key.startsWith(`${config.qiniu.prefix}/`)) {
      sendError(res, 403, "INVALID_QINIU_KEY", "涓嶅厑璁歌闂綋鍓嶆枃浠?)";
      return;
    }

    if (sendLocalFallbackFile(req, res)) {
      return;
    }

    const object = await storage.readRemoteObject(key);
    if (!object) {
      sendError(res, 404, "FILE_NOT_FOUND", "鏂囦欢涓嶅瓨鍦ㄦ垨宸茶繃鏈?)";
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
      headline: "璇佷欢鐓у凡鐢熸垚",
      detail: `宸叉寜 ${size || "鑰冭瘯鎶ュ悕"} 杈撳嚭鏂板簳鑹茶瘉浠剁収銆俙`,
      file: {
        ...buildFileResponse(output, "image/png", "璇佷欢鐓?png"),
        inlineBase64: result.buffer.toString("base64"),
      },
      metaLines: [
        `瑙勬牸 ${size || "鑰冭瘯鎶ュ悕"}`,
        `鑳屾櫙 ${background || "鐧藉簳"}`,
        `淇グ ${retouch || "鑷劧"}`,
        `灏哄 ${result.width} 脳 ${result.height}`,
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
      errorMessage: error.message || "璇佷欢鐓х敓鎴愬け璐?",
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
      error.message || "璇佷欢鐓х敓鎴愬け璐?"
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
      metaLines: [`瀛樺偍浣嶇疆 ${output.provider === "qiniu" ? "涓冪墰浜? : "鏈湴纾佺洏"}`]",
    });
  } catch (error) {
    await recordOperation(req, {
      toolId: "client-file-upload",
      status: "failed",
      errorCode: error.code || "CLIENT_FILE_UPLOAD_FAILED",
      errorMessage: error.message || "瀹㈡埛绔枃浠朵笂浼犲け璐?",
    });

    sendError(
      res,
      500,
      error.code || "CLIENT_FILE_UPLOAD_FAILED",
      error.message || "瀹㈡埛绔枃浠朵笂浼犲け璐?"
    );
  }
});

const pendingOrders = new Map();

app.post("/api/pay/create", async (req, res) => {
  const { type, itemId } = req.body || {};

  if (!type || !itemId) {
    return res.status(400).json({ error: "MISSING_PARAMS", message: "缂哄皯 type 鎴?itemId" });
  }

  const orderId = `ORD-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const nonceStr = crypto.randomBytes(16).toString("hex");
  const timeStamp = String(Math.floor(Date.now() / 1000));

  const mockPayment = {
    timeStamp,
    nonceStr,
    package: `prepay_id=wx${Date.now()}`,
    signType: "MD5",
    paySign: crypto.createHash("md5").update(`${orderId}${nonceStr}${timeStamp}`).digest("hex"),
  };

  pendingOrders.set(orderId, {
    type,
    itemId,
    status: "pending",
    createdAt: Date.now(),
  });

  res.json({ orderId, payment: mockPayment });
});

app.post("/api/pay/verify", async (req, res) => {
  const { orderId } = req.body || {};

  if (!orderId) {
    return res.status(400).json({ error: "MISSING_ORDER_ID", message: "缂哄皯 orderId" });
  }

  const order = pendingOrders.get(orderId);
  if (!order) {
    return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "璁㈠崟涓嶅瓨鍦? })";
  }

  order.status = "paid";
  order.paidAt = Date.now();
  pendingOrders.set(orderId, order);

  res.json({ success: true, orderId, type: order.type, itemId: order.itemId });
});

app.post("/api/pay/notify", async (req, res) => {
  const { orderId, result_code, out_trade_no } = req.body || {};

  if (result_code === "SUCCESS" && orderId) {
    const order = pendingOrders.get(orderId);
    if (order) {
      order.status = "paid";
      order.paidAt = Date.now();
      order.transactionId = out_trade_no;
      pendingOrders.set(orderId, order);
    }
  }

  res.json({ code: "SUCCESS", message: "" });
});

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

app.post("/api/pdf/merge", async (req, res) => {
  const files = req.body.files || [];

  try {
    if (files.length < 2) {
      sendError(res, 400, "INVALID_FILE_COUNT", "鑷冲皯闇€瑕?2 涓?PDF 鏂囦欢");
      return;
    }

    const mergedPdf = await PDFDocument.create();

    for (const file of files) {
      assertPdfFile(file);
      const sourcePdf = await PDFDocument.load(decodeBase64File(file));
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
      },
    });

    res.json({
      ok: true,
      resultType: "document",
      headline: "PDF 鍚堝苟宸插畬鎴?",
      detail: `宸插悎骞?${files.length} 浠?PDF 鏂囨。锛屽彲鐩存帴涓嬭浇鎴栫户缁鐞嗐€俙`,
      file: buildFileResponse(output, "application/pdf"),
      metaLines: [
        `杈撳叆鏂囦欢 ${files.length} 浠絗`,
        `瀛樺偍浣嶇疆 ${output.provider === "qiniu" ? "涓冪墰浜? : "鏈湴纾佺洏"}`",
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
      errorMessage: error.message || "PDF 鍚堝苟澶辫触",
    });

    sendError(res, 500, error.code || "PDF_MERGE_FAILED", error.message || "PDF 鍚堝苟澶辫触");
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
          `绗?${index + 1} 浠?路 绗?${pages.map((page) => page + 1).join(", ")} 椤礰`
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
      headline: "PDF 鎷嗗垎宸插畬鎴?",
      detail: `宸叉媶鍒嗕负 ${outputs.length} 浠芥枃妗ｏ紝鍙垎鍒墦寮€鎴栦笅杞姐€俙`,
      file: outputs[0],
      files: outputs,
      metaLines: [
        `鎬婚〉鏁?${totalPages}`,
        `鎷嗗垎鏂瑰紡 ${splitMode || normalizedSplitMode}`,
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
      errorMessage: error.message || "PDF 鎷嗗垎澶辫触",
      meta: {
        splitMode,
        pageRange,
      },
    });

    sendError(res, 500, error.code || "PDF_SPLIT_FAILED", error.message || "PDF 鎷嗗垎澶辫触");
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
      headline: "PDF 鍩虹浼樺寲宸插畬鎴?",
      detail: "宸插畬鎴愬熀纭€鍘嬬缉浼樺寲锛屽疄闄呬綋绉彉鍖栦細鍙楀師鏂囨。缁撴瀯褰卞搷銆?",
      file: buildFileResponse(output, "application/pdf"),
      metaLines: [
        `鍘嬬缉妯″紡 ${mode || "榛樿"}`,
        "褰撳墠涓哄熀纭€浼樺寲鐗堝帇缂?",
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
      errorMessage: error.message || "PDF 鍘嬬缉澶辫触",
      meta: {
        mode,
      },
    });

    sendError(
      res,
      500,
      error.code || "PDF_COMPRESS_FAILED",
      error.message || "PDF 鍘嬬缉澶辫触"
    );
  }
});

app.post("/api/file/compress", async (req, res) => {
  const file = req.body.file;
  const mode = req.body.mode || "";

  try {
    if (!file || !file.base64) {
      throw new Error("闇€瑕佷笂浼犳枃浠?)";
    }

    const ext = normalizeExtension(file.name ? file.name.split('.').pop() : "bin");
    const fileBytes = decodeBase64File(file);

    let outputBytes = fileBytes;
    let outputExt = ext;
    let compressed = false;
    let compressionNote = "褰撳墠鏂囦欢鏈彂鐜板彲杩涗竴姝ュ帇缂╃殑绌洪棿";

    // 鏍规嵁鏂囦欢绫诲瀷杩涜涓嶅悓鐨勫帇缂╁鐞?
    if (ext === "pdf") {
      // PDF鍘嬬缉 - 浣跨敤鐜版湁鐨凱DF鍘嬬缉閫昏緫
      const pdfDoc = await PDFDocument.load(fileBytes);
      const selected = selectSmallerOutput(fileBytes, Buffer.from(await pdfDoc.save({ useObjectStreams: true })));
      outputBytes = selected.bytes;
      compressed = selected.compressed;
      compressionNote = compressed ? "宸插畬鎴?PDF 鍩虹缁撴瀯浼樺寲" : "杩欎釜 PDF 宸茬粡姣旇緝绱у噾锛屽熀纭€浼樺寲鍚庝綋绉病鏈変笅闄?";
      outputExt = "pdf";
    } else if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
      const quality = getUniversalCompressImageQuality(mode);
      let image = sharp(fileBytes, { animated: false }).rotate();

      if (mode === "浣撶Н浼樺厛") {
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
          palette: mode === "浣撶Н浼樺厛",
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
      compressionNote = compressed ? "宸查噸鏂扮紪鐮佸浘鐗囧苟闄嶄綆浣撶Н" : "鍥剧墖閲嶆柊缂栫爜鍚庢病鏈夊彉灏忥紝宸蹭繚鐣欏師鏂囦欢";
    } else if (["bmp", "gif"].includes(ext)) {
      outputBytes = fileBytes;
      outputExt = ext;
      compressionNote = "褰撳墠鍥剧墖鏍煎紡鏆備笉鍋氭湁鎹熷帇缂╋紝宸蹭繚鐣欏師鏂囦欢";
    } else if (["mp3", "wav", "flac", "m4a", "aac", "ogg"].includes(ext)) {
      // 闊抽鍘嬬缉 - 浣跨敤ffmpeg
      const ffmpegPath = resolveFfmpegPath();
      if (ffmpegPath) {
        try {
          const tempInputPath = path.join(config.tempDir, `compress-input-${Date.now()}.${ext}`);
          const tempOutputPath = path.join(config.tempDir, `compress-output-${Date.now()}.${ext}`);

          fs.writeFileSync(tempInputPath, fileBytes);

          let qualityArgs = [];
          if (mode === "浣撶Н浼樺厛") {
            qualityArgs = ["-b:a", "64k"];
          } else if (mode === "鍧囪　") {
            qualityArgs = ["-b:a", "128k"];
          } else if (mode === "璐ㄩ噺浼樺厛") {
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
          compressionNote = compressed ? "宸蹭娇鐢?FFmpeg 閲嶆柊缂栫爜瑙嗛" : "瑙嗛閲嶆柊缂栫爜鍚庢病鏈夊彉灏忥紝宸蹭繚鐣欏師鏂囦欢";
          outputExt = ext;

          try {
            fs.unlinkSync(tempInputPath);
            fs.unlinkSync(tempOutputPath);
          } catch (cleanError) {
            // 蹇界暐娓呯悊閿欒
          }
        } catch (audioError) {
          console.warn("闊抽鍘嬬缉澶辫触锛屼娇鐢ㄥ師鏂囦欢:", audioError);
          outputBytes = fileBytes;
          compressionNote = "闊抽鍘嬬缉澶辫触锛屽凡淇濈暀鍘熸枃浠?";
        }
      } else {
        compressionNote = "褰撳墠鏈嶅姟鏈娴嬪埌 FFmpeg锛屽凡淇濈暀鍘熸枃浠?";
      }
    } else if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"].includes(ext)) {
      // 瑙嗛鍘嬬缉 - 浣跨敤ffmpeg
      const ffmpegPath = resolveFfmpegPath();
      if (ffmpegPath) {
        try {
          const tempInputPath = path.join(config.tempDir, `compress-input-${Date.now()}.${ext}`);
          const tempOutputPath = path.join(config.tempDir, `compress-output-${Date.now()}.${ext}`);

          fs.writeFileSync(tempInputPath, fileBytes);

          let crf = "28";
          if (mode === "浣撶Н浼樺厛") {
            crf = "32";
          } else if (mode === "璐ㄩ噺浼樺厛") {
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
          compressionNote = compressed ? "宸蹭娇鐢?FFmpeg 閲嶆柊缂栫爜闊抽" : "闊抽閲嶆柊缂栫爜鍚庢病鏈夊彉灏忥紝宸蹭繚鐣欏師鏂囦欢";
          outputExt = ext;

          try {
            fs.unlinkSync(tempInputPath);
            fs.unlinkSync(tempOutputPath);
          } catch (cleanError) {
            // 蹇界暐娓呯悊閿欒
          }
        } catch (videoError) {
          console.warn("瑙嗛鍘嬬缉澶辫触锛屼娇鐢ㄥ師鏂囦欢:", videoError);
          outputBytes = fileBytes;
          compressionNote = "瑙嗛鍘嬬缉澶辫触锛屽凡淇濈暀鍘熸枃浠?";
        }
      } else {
        compressionNote = "褰撳墠鏈嶅姟鏈娴嬪埌 FFmpeg锛屽凡淇濈暀鍘熸枃浠?";
      }
    } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z"].includes(ext)) {
      // Office鏂囨。鎴栧帇缂╁寘 - 鍘熸牱杩斿洖锛屽凡鍘嬬缉杩?      outputBytes = fileBytes;
      outputExt = ext;
      compressionNote = "Office 鏂囨。鍜屽帇缂╁寘閫氬父宸插寘鍚帇缂╃粨鏋勶紝宸蹭繚鐣欏師鏂囦欢";
    } else {
      // 鍏朵粬鏂囦欢绫诲瀷 - 鍘熸牱杩斿洖
      outputBytes = fileBytes;
      outputExt = ext;
      compressionNote = "鏆備笉鏀寔璇ョ被鍨嬬殑瀹為檯鍘嬬缉锛屽凡淇濈暀鍘熸枃浠?";
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
      headline: compressed ? "鏂囦欢鍘嬬缉瀹屾垚" : "鏂囦欢浣撶Н鏈彉灏?",
      detail: compressed ? `宸叉寜鐓с€?{mode || "榛樿"}銆嶇瓥鐣ュ畬鎴愬帇缂┿€俙 : compressionNote`,
      file: responseFile,
      compressed,
      beforeBytes: fileBytes.length,
      afterBytes: outputBytes.length,
      savedBytes,
      savedPercent,
      note: compressionNote,
      metaLines: [
        `鍘嬬缉妯″紡 ${mode || "榛樿"}`,
        `鏂囦欢绫诲瀷 ${ext}`,
        compressed ? `鑺傜渷 ${savedPercent}%` : "鏈骇鐢熶綋绉敹鐩?",
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
      errorMessage: error.message || "鏂囦欢鍘嬬缉澶辫触",
      meta: {
        mode,
      },
    });

    sendError(
      res,
      500,
      error.code || "FILE_COMPRESS_FAILED",
      error.message || "鏂囦欢鍘嬬缉澶辫触"
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
    "鏍囧噯": "192k",
    "楂樻竻": "320k",
    "鏃犳崯": "320k",
  };
  return bitrateMap[qualityLabel] || "192k";
}

function getVideoCrf(qualityLabel) {
  const crfMap = {
    "鏍囧噯": "28",
    "楂樻竻": "23",
    "鏃犳崯": "18",
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

    console.log("[FFmpeg] 鎵ц鍛戒护:", ffmpegPath, args.join(" "));

    let stderrOutput = "";
    const child = spawn(ffmpegPath, args);

    child.stderr.on("data", (data) => {
      stderrOutput += data.toString();
    });

    child.on("error", (err) => {
      console.error("[FFmpeg] 鍚姩閿欒:", err);
      reject(new Error(`FFmpeg 鍚姩澶辫触: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error("[FFmpeg] 閿欒杈撳嚭:", stderrOutput);
        reject(new Error(`FFmpeg 杞崲澶辫触 (exit code ${code})`));
        return;
      }
      console.log("[FFmpeg] 杞崲鎴愬姛");
      resolve();
    });
  });
}

app.post("/api/audio/convert", async (req, res) => {
  const file = req.body.file;
  const target = req.body.target || "MP3";
  const quality = req.body.quality || "鏍囧噯";
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
      errorMessage: "褰撳墠鏈嶅姟鏈娴嬪埌 FFmpeg",
      meta: {
        target,
        quality,
      },
    });

    sendError(
      res,
      501,
      "FFMPEG_UNAVAILABLE",
      "褰撳墠鏈嶅姟绔湭妫€娴嬪埌 FFmpeg锛岃瀹夎鍚庡啀鍚敤闊宠棰戣浆鎹€?"
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
    console.log("[Media Convert] 鍐欏叆鏂囦欢:", inputPath, "澶у皬:", fileBuffer.length, "bytes");

    const magic = fileBuffer.slice(0, 8).toString("hex");
    console.log("[Media Convert] 鏂囦欢澶?(hex):", magic);

    const isFlac = magic.startsWith("664c6143");
    const isMp3 = magic.startsWith("494433") || magic.startsWith("fff") || magic.startsWith("fffa") || magic.startsWith("fffb");
    const isWav = magic.startsWith("52494646");
    const isOgg = magic.startsWith("4f676753");
    const isM4a = magic.startsWith("66747970") || magic.startsWith("000000") || (magic.length >= 16 && magic.slice(8, 16) === "66747970");

    const isNcm = magic.startsWith("4354454e");
    const isKgm = magic.startsWith("7b226b67");
    const isQmc = magic.startsWith("789c");

    console.log("[Media Convert] 鏍煎紡妫€娴?- FLAC:", isFlac, "MP3:", isMp3, "WAV:", isWav, "OGG:", isOgg, "M4A:", isM4a, "VideoExt:", inputIsVideo);
    console.log("[Media Convert] 鍔犲瘑妫€娴?- NCM:", isNcm, "KGM:", isKgm, "QMC:", isQmc);

    let formatMatch = true;
    let formatHint = "";

    if (inputExt.toLowerCase() === ".flac" && !isFlac) {
      formatMatch = false;
      if (isNcm) formatHint = "杩欑湅璧锋潵鏄綉鏄撲簯闊充箰鐨勫姞瀵嗘牸寮?(.ncm)锛屼笉鏄湡姝ｇ殑 FLAC锛?";
      else if (isKgm) formatHint = "杩欑湅璧锋潵鏄叿鐙楅煶涔愮殑鍔犲瘑鏍煎紡 (.kgm)锛屼笉鏄湡姝ｇ殑 FLAC锛?";
      else if (isQmc) formatHint = "杩欑湅璧锋潵鏄?QQ 闊充箰鐨勫姞瀵嗘牸寮?(.qmc)锛屼笉鏄湡姝ｇ殑 FLAC锛?";
      else formatHint = "杩欎釜鏂囦欢鐨勬墿灞曞悕鏄?.flac锛屼絾鍐呭涓嶆槸鏍囧噯 FLAC 鏍煎紡锛?";
    } else if (inputExt.toLowerCase() === ".mp3" && !isMp3) {
      formatMatch = false;
      formatHint = "杩欎釜鏂囦欢鐨勬墿灞曞悕鏄?.mp3锛屼絾鍐呭鐪嬭捣鏉ヤ笉鍍忔槸鏍囧噯 MP3 鏍煎紡锛?";
    } else if (inputExt.toLowerCase() === ".wav" && !isWav) {
      formatMatch = false;
      formatHint = "杩欎釜鏂囦欢鐨勬墿灞曞悕鏄?.wav锛屼絾鍐呭鐪嬭捣鏉ヤ笉鍍忔槸鏍囧噯 WAV 鏍煎紡锛?";
    }

    if (!formatMatch) {
      const error = new Error(formatHint);
      error.code = "INVALID_MEDIA_FORMAT";
      throw error;
    }

    fs.writeFileSync(inputPath, fileBuffer);

    const stats = fs.statSync(inputPath);
    console.log("[Media Convert] 鏂囦欢宸插啓鍏? 瀹為檯澶у皬:", stats.size, "bytes");
    console.log("[Media Convert] 杈撳嚭璺緞:", outputPath);

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
      headline: "闊宠棰戞牸寮忚浆鎹㈠凡瀹屾垚",
      detail: `宸茶浆鎹负 ${target} 鏍煎紡锛屽彲鐩存帴涓嬭浇浣跨敤銆俙`,
      file: buildFileResponse(output, contentType),
      metaLines: [
        `鍘熸枃浠?${originalInputName}`,
        `鐩爣鏍煎紡 ${target}`,
        `璐ㄩ噺 ${quality}`,
      ].filter(Boolean),
    });
  } catch (error) {
    console.error("[Media Convert] 閿欒:", error);
    let errorMessage = "闊宠棰戣浆鎹㈠け璐?";
    let errorHint = "";

    const errMsg = (error.message || "").toLowerCase();
    if (errMsg.includes("invalid data") || errMsg.includes("could not find codec")) {
      errorMessage = "鏃犳硶瑙ｆ瀽闊宠棰戞枃浠?";
      errorHint = "璇锋鏌ユ枃浠舵槸鍚︽崯鍧忥紝鎴栧皾璇曡浆鎹负鍏朵粬鏍煎紡";
    } else if (error.code === "AUDIO_TO_VIDEO_UNSUPPORTED") {
      errorMessage = "闊抽涓嶈兘鐩存帴杞崲涓鸿棰?";
      errorHint = "璇烽€夋嫨 MP3銆乄AV銆丗LAC銆丱GG銆丮4A 鎴?AAC 绛夐煶棰戠洰鏍囨牸寮?";
    } else if (errMsg.includes("ffmpeg")) {
      errorMessage = "FFmpeg 鎵ц閿欒";
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
      errorHint ? `${errorMessage}銆?{errorHint}` : errorMessage
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});

app.post("/api/ocr/image", async (req, res) => {
  const file = req.body.file;
  const language = req.body.language || "涓嫳娣峰悎";
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
      headline: "OCR 璇嗗埆宸插畬鎴?",
      detail: `鍏辫瘑鍒?${text.trim().length} 涓瓧绗︼紝鍙洿鎺ュ鍒剁户缁娇鐢ㄣ€俙`,
      text,
      lines: result.lines || [],
      confidence: result.confidence,
      provider: result.provider,
      metaLines: [
        `璇█ ${language}`,
        layout ? `妯″紡 ${layout}` : "",
        `寮曟搸 ${result.provider === "baidu" ? "鐧惧害 OCR" : "Tesseract"}`,
        result.confidence ? `缃俊搴?${result.confidence}` : "",
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
      errorMessage: error.message || "OCR 璇嗗埆澶辫触",
      meta: {
        language,
        layout,
      },
    });

    sendError(res, 500, error.code || "OCR_FAILED", error.message || "OCR 璇嗗埆澶辫触");
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
      errorMessage: "褰撳墠鏈嶅姟鏈娴嬪埌 LibreOffice",
      meta: {
        quality,
        pageMode,
      },
    });

    sendError(
      res,
      501,
      "OFFICE_CONVERTER_UNAVAILABLE",
      "褰撳墠鏈嶅姟绔湭妫€娴嬪埌 LibreOffice锛岃瀹夎鍚庡啀鍚敤 Office 杞?PDF銆?"
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
      headline: "Office 杞?PDF 宸插畬鎴?",
      detail: "鏂囨。宸插鍑轰负 PDF锛屽彲鐩存帴鎵撳紑鎴栫户缁帇缂┿€佸悎骞躲€?",
      file: buildFileResponse(output, "application/pdf"),
      metaLines: [
        `鍘熸枃浠?${file.name || inputName}`,
        quality ? `娓呮櫚搴?${quality}` : "",
        pageMode ? `椤甸潰绛栫暐 ${pageMode}` : "",
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
      errorMessage: error.message || "Office 杞?PDF 澶辫触",
      meta: {
        quality,
        pageMode,
      },
    });

    sendError(
      res,
      500,
      error.code || "OFFICE_TO_PDF_FAILED",
      error.message || "Office 杞?PDF 澶辫触"
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
      "Adobe PDF Services API 鏈厤缃紝璇疯缃?PDF_SERVICES_CLIENT_ID 鍜?PDF_SERVICES_CLIENT_SECRET",
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
  // 馃敟 寮哄埗榛樿绮剧‘杩樺師锛堝瓧浣?鏍煎紡1:1锛?
  const layoutMode = String(options.layout || "exact").toLowerCase();
  const outputConfig = getPdfToWordOutputConfig(options.format);
  const ocrLocale = getAdobeExportOcrLocale(options.ocrLocale);
  const pages = await getPdfPageCount(fileBuffer);
  const pdfServices = createAdobePdfServicesClient();
  const uploadedAssets = [];
  const generatedAssets = [];

  console.log("[PDF to Word] 浣跨敤 Adobe 楂樼簿搴︽ā寮忚浆鎹紙瀛椾綋/鏍煎紡1:1杩樺師锛?)";

  try {
    const inputAsset = await pdfServices.upload({
      readStream: fs.createReadStream(inputPath),
      mimeType: MimeType.PDF,
    });
    uploadedAssets.push(inputAsset);

    let exportInputAsset = inputAsset;
    let wasUnlocked = false;

    // 澶勭悊鍔犲瘑PDF
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
        throw createCodedError("Adobe PDF Services API 鏈繑鍥炶В瀵嗗悗鐨?PDF", "PDF_TO_WORD_ADOBE_FAILED");
      }

      exportInputAsset = removeProtectionResponse.result.asset;
      generatedAssets.push(exportInputAsset);
      wasUnlocked = true;
    }

    // ====================== 鉁?缁堟瀬浼樺寲锛氭渶楂樺瓧浣?鏍煎紡杩樺師閰嶇疆 ======================
    const finalLayoutMode = layoutMode === "exact" ? "EXACT" : "FLOW";
    const exportParams = new ExportPDFParams({
      targetFormat: outputConfig.targetFormat,
      ocrLocale,
      // 馃敟 鏍稿績1锛氱簿纭竷灞€锛堝畬鍏ㄥ鍒籔DF鐨勫瓧浣撱€侀棿璺濄€佹帓鐗堬級
      layoutMode: finalLayoutMode,
      // 馃敟 鏍稿績2锛氫繚鐣橮DF鍘熷瀛椾綋锛堜笉鏇挎崲涓虹郴缁熼粯璁ゅ瓧浣擄級
      preserveFonts: true,
      // 馃敟 鏍稿績3锛氬皢瀛椾綋宓屽叆Word鏂囨。锛堟墦寮€浠讳綍鐢佃剳閮芥樉绀哄師瀛椾綋锛?
      embedFonts: true,
      // 馃敟 鏍稿績4锛氫繚鐣欏畬鏁存牸寮忥紙瀛楀彿銆侀鑹层€佺矖浣撱€佹枩浣撱€佷笅鍒掔嚎锛?
      preserveFormatting: true,
      // 馃敟 鏍稿績5锛氫繚鐣欎笓涓氭帓鐗堬紙瀛楃闂磋窛銆佽楂樸€佸榻愭柟寮忥級
      preserveTypography: true,
      // 淇濈暀椤电湁椤佃剼/鑴氭敞
      includeHeadersAndFooters: true,
      includeFootnotes: true,
      // 绮惧噯璇嗗埆琛ㄦ牸
      tableDetectionEnabled: true,
      // 瀛椾綋瀛愰泦鍖栵紙鍑忓皬鏂囦欢浣撶Н锛屼笉褰卞搷杩樺師搴︼級
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
      throw createCodedError("Adobe PDF Services API 鏈繑鍥?DOCX 鏂囦欢", "PDF_TO_WORD_ADOBE_FAILED");
    }

    const resultAsset = exportResponse.result.asset;
    generatedAssets.push(resultAsset);

    const streamAsset = await pdfServices.getContent({ asset: resultAsset });
    const buffer = await readStreamToBuffer(streamAsset.readStream);

    if (!buffer.length) {
      throw createCodedError("Adobe PDF Services API 杩斿洖浜嗙┖鐨?DOCX 鏂囦欢", "PDF_TO_WORD_ADOBE_FAILED");
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
    // 娓呯悊璧勬簮
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
    console.log("[PDF to Word] 涓存椂鐩綍:", tempDir);

    const randomId = makeId();
    const inputName = `input-${randomId}.pdf`;

    const fileBuffer = decodeBase64File(file);
    console.log("[PDF to Word] 杈撳叆鏂囦欢澶у皬:", fileBuffer.length, "bytes");

    const conversion = await convertPdfToWordWithAdobe(fileBuffer, inputName, tempDir, {
      format,
      ocrLocale: req.body.ocrLocale || req.body.language || req.body.locale || "",
      password: req.body.password || req.body.pdfPassword || "",
      layout: layout, // 馃敟 鏂板锛氫紶閫掑竷灞€妯″紡
    });

    console.log("[PDF to Word] Word鏂囨。鐢熸垚瀹屾垚, 澶у皬:", conversion.buffer.length, "bytes");

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
      headline: "PDF 杞?Word 宸插畬鎴?",
      detail: "宸查€氳繃 Adobe PDF Services API 鐢熸垚鍙紪杈?Word 鏂囨。锛屽敖閲忎繚鐣欏師 PDF 鐗堝紡銆?",
      file: buildFileResponse(output, conversion.contentType),
      metaLines: [
        `鍘熸枃浠?${file.name || inputName}`,
        conversion.pages ? `鍏?${conversion.pages} 椤礰` : "",
        `杈撳嚭鏍煎紡 ${conversion.format}`,
        `OCR ${conversion.ocrLocale}`,
        "妯″紡 Adobe PDF Services",
        conversion.unlocked ? "宸蹭娇鐢ㄥ瘑鐮佽В閿?PDF" : "",
      ].filter(Boolean),
    });
  } catch (error) {
    console.error("[PDF to Word] 杞崲澶辫触:", error);
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
      errorMessage: error.message || "PDF 杞?Word 澶辫触",
      meta: {
        format,
        layout,
      },
    });

    sendError(
      res,
      500,
      error.code || "PDF_TO_WORD_FAILED",
      error.message || "PDF 杞?Word 澶辫触"
    );
  } finally {
    cleanupTempDir(tempDir);
  }
});

app.use(async (error, req, res, next) => {
  const code = error && error.code ? error.code : "UNHANDLED_ERROR";
  const message = error && error.message ? error.message : "鏈嶅姟绔彂鐢熸湭澶勭悊寮傚父";

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
        console.error("[Temp Cleanup] 鏃犳硶鍒犻櫎", itemPath, ":", e.message);
      }
    }

    return deletedCount;
  } catch (e) {
    console.error("[Temp Cleanup] 娓呯悊澶辫触:", e);
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
      console.log(`[Temp Cleanup] 娓呯悊浜?${count} 涓棫涓存椂鐩綍`);
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
