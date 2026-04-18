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
const PDFParser = require("pdf2json");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require("docx");
const { buildPhotoIdImage, warmPhotoIdModel } = require("./lib/photo-id");
const { decodePdfTextToken } = require("./lib/pdf-text");

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
app.use("/files", express.static(config.outputDir));

setTimeout(() => {
  warmPhotoIdModel(config)
    .then(() => {
      console.log("photo-id model warmed");
    })
    .catch((error) => {
      console.warn("photo-id model warmup failed", error && error.message ? error.message : error);
    });
}, 0);

function makeId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
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

  res.setHeader("content-type", getFallbackContentType(fallbackName));
  res.sendFile(fallbackPath);
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
    label.includes("鎸夐〉")
  ) {
    return "page-range";
  }

  return "all-pages";
}

function normalizeOcrLanguage(languageLabel) {
  const label = String(languageLabel || "").trim().toLowerCase();

  if (label === "eng" || label === "english") {
    return "eng";
  }

  if (label === "chi_sim" || label === "chinese") {
    return "chi_sim";
  }

  return "eng+chi_sim";
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

async function recognizeTextFromImage(file, languageLabel) {
  const worker = await createWorker(normalizeOcrLanguage(languageLabel));

  try {
    const result = await worker.recognize(decodeBase64File(file));
    return result.data.text || "";
  } finally {
    await worker.terminate();
  }
}

function runSofficeConvert(sofficePath, inputFilePath, outputDir, outputFormat = "pdf") {
  return new Promise((resolve, reject) => {
    const args = ["--headless", "--convert-to", outputFormat, "--outdir", outputDir, inputFilePath];
    console.log("[LibreOffice] 开始转换, 命令:", sofficePath, args.join(" "));
    
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
      console.log("[LibreOffice] 进程退出, code:", code);
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

    const object = await storage.readRemoteObject(key);
    if (!object) {
      if (sendLocalFallbackFile(req, res)) {
        return;
      }

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
    next(error);
  }
});

app.use("/api", requireApiToken);

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
        `尺寸 ${result.width} × ${result.height}`,
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
      error.message || "客户端文件上传失败"
    );
  }
});

const pendingOrders = new Map();

app.post("/api/pay/create", async (req, res) => {
  const { type, itemId } = req.body || {};

  if (!type || !itemId) {
    return res.status(400).json({ error: "MISSING_PARAMS", message: "缺少 type 或 itemId" });
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
    return res.status(400).json({ error: "MISSING_ORDER_ID", message: "缺少 orderId" });
  }

  const order = pendingOrders.get(orderId);
  if (!order) {
    return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "订单不存在" });
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
      sendError(res, 400, "INVALID_FILE_COUNT", "至少需要 2 个 PDF 文件");
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
      headline: "PDF 合并已完成",
      detail: `已合并 ${files.length} 份 PDF 文档，可直接下载或继续处理。`,
      file: buildFileResponse(output, "application/pdf"),
      metaLines: [
        `输入文件 ${files.length} 份`,
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
          `第 ${index + 1} 份 · 第 ${pages.map((page) => page + 1).join(", ")} 页`
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

function getAudioBitrate(qualityLabel) {
  const bitrateMap = {
    "标准": "192k",
    "高清": "320k",
    "无损": "320k",
  };
  return bitrateMap[qualityLabel] || "192k";
}

function getAudioExtension(targetFormat) {
  const extMap = {
    mp3: "mp3",
    wav: "wav",
    flac: "flac",
    ogg: "ogg",
    m4a: "m4a",
    aac: "aac",
  };
  return extMap[targetFormat.toLowerCase()] || "mp3";
}

function runFfmpegConvert(ffmpegPath, inputFilePath, outputFilePath, targetFormat, quality) {
  return new Promise((resolve, reject) => {
    const ext = targetFormat.toLowerCase();
    const args = ["-y", "-probesize", "100M", "-analyzeduration", "10M", "-i", inputFilePath];

    if (ext === "mp3") {
      args.push("-acodec", "libmp3lame");
      args.push("-b:a", getAudioBitrate(quality));
    } else if (ext === "wav") {
      args.push("-acodec", "pcm_s16le");
    } else if (ext === "flac") {
      args.push("-acodec", "flac");
    } else if (ext === "ogg") {
      args.push("-acodec", "libvorbis");
      args.push("-b:a", getAudioBitrate(quality));
    } else if (ext === "m4a") {
      args.push("-acodec", "aac");
      args.push("-b:a", getAudioBitrate(quality));
      args.push("-f", "ipod");
    } else if (ext === "aac") {
      args.push("-acodec", "aac");
      args.push("-b:a", getAudioBitrate(quality));
      args.push("-f", "adts");
    } else {
      args.push("-acodec", "libmp3lame");
      args.push("-b:a", getAudioBitrate(quality));
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
      "当前服务端未检测到 FFmpeg，请安装后再启用音频转换。"
    );
    return;
  }

  let tempDir = "";

  try {
    tempDir = fs.mkdtempSync(path.join(config.tempDir, "audio-"));
    const originalInputName = file && file.name ? file.name : `audio-${makeId()}.mp3`;
    
    const inputExt = path.extname(originalInputName) || ".mp3";
    const safeInputName = `input-${makeId()}${inputExt}`;
    const inputPath = path.join(tempDir, safeInputName);

    const targetExt = getAudioExtension(target);
    const originalBaseName = path.parse(originalInputName).name || "audio";
    const safeBaseName = originalBaseName.replace(/[^\w\u4e00-\u9fa5\-_]/g, "_");
    const outputName = `${safeBaseName}.${targetExt}`;
    const outputPath = path.join(tempDir, outputName);

    const fileBuffer = decodeBase64File(file);
    console.log("[Audio Convert] 写入文件:", inputPath, "大小:", fileBuffer.length, "bytes");

    const magic = fileBuffer.slice(0, 8).toString("hex");
    console.log("[Audio Convert] 文件头 (hex):", magic);
    
    const isFlac = magic.startsWith("664c6143");
    const isMp3 = magic.startsWith("494433") || magic.startsWith("fff") || magic.startsWith("fffa") || magic.startsWith("fffb");
    const isWav = magic.startsWith("52494646");
    const isOgg = magic.startsWith("4f676753");
    const isM4a = magic.startsWith("66747970") || magic.startsWith("000000") || (magic.length >= 16 && magic.slice(8, 16) === "66747970");

    const isNcm = magic.startsWith("4354454e");
    const isKgm = magic.startsWith("7b226b67");
    const isQmc = magic.startsWith("789c");

    console.log("[Audio Convert] 格式检测 - FLAC:", isFlac, "MP3:", isMp3, "WAV:", isWav, "OGG:", isOgg, "M4A:", isM4a);
    console.log("[Audio Convert] 加密检测 - NCM:", isNcm, "KGM:", isKgm, "QMC:", isQmc);

    let formatMatch = true;
    let formatHint = "";

    if (inputExt.toLowerCase() === ".flac" && !isFlac) {
      formatMatch = false;
      if (isNcm) formatHint = "这看起来是网易云音乐的加密格式 (.ncm)，不是真正的 FLAC！";
      else if (isKgm) formatHint = "这看起来是酷狗音乐的加密格式 (.kgm)，不是真正的 FLAC！";
      else if (isQmc) formatHint = "这看起来是 QQ 音乐的加密格式 (.qmc)，不是真正的 FLAC！";
      else formatHint = "这个文件的扩展名是 .flac，但内容不是标准 FLAC 格式！";
    } else if (inputExt.toLowerCase() === ".mp3" && !isMp3) {
      formatMatch = false;
      formatHint = "这个文件的扩展名是 .mp3，但内容看起来不像是标准 MP3 格式！";
    } else if (inputExt.toLowerCase() === ".wav" && !isWav) {
      formatMatch = false;
      formatHint = "这个文件的扩展名是 .wav，但内容看起来不像是标准 WAV 格式！";
    }

    if (!formatMatch) {
      const error = new Error(formatHint);
      error.code = "INVALID_AUDIO_FORMAT";
      throw error;
    }

    fs.writeFileSync(inputPath, fileBuffer);

    const stats = fs.statSync(inputPath);
    console.log("[Audio Convert] 文件已写入, 实际大小:", stats.size, "bytes");
    console.log("[Audio Convert] 输出路径:", outputPath);

    await runFfmpegConvert(ffmpegPath, inputPath, outputPath, target, quality);

    const bytes = fs.readFileSync(outputPath);
    const output = await saveOutputFile(req, bytes, {
      extension: targetExt,
      contentType: `audio/${targetExt}`,
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
      headline: "音频格式转换已完成",
      detail: `已转换为 ${target} 格式，可直接下载使用。`,
      file: buildFileResponse(output, `audio/${targetExt}`),
      metaLines: [
        `原文件 ${originalInputName}`,
        `目标格式 ${target}`,
        `音质 ${quality}`,
      ].filter(Boolean),
    });
  } catch (error) {
    console.error("[Audio Convert] 错误:", error);
    let errorMessage = "音频转换失败";
    let errorHint = "";

    const errMsg = (error.message || "").toLowerCase();
    if (errMsg.includes("invalid data") || errMsg.includes("could not find codec")) {
      errorMessage = "无法解析音频文件";
      errorHint = "请检查文件是否损坏，或尝试转换为其他格式";
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
      errorCode: error.code || "AUDIO_CONVERT_FAILED",
      errorMessage: errorMessage,
      meta: {
        target,
        quality,
      },
    });

    sendError(
      res,
      500,
      error.code || "AUDIO_CONVERT_FAILED",
      errorHint ? `${errorMessage}。${errorHint}` : errorMessage
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
    const text = await recognizeTextFromImage(file, language);

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
      },
    });

    res.json({
      ok: true,
      resultType: "text",
      headline: "OCR 识别已完成",
      detail: `共识别 ${text.trim().length} 个字符，可直接复制继续使用。`,
      text,
      metaLines: [
        `语言 ${language}`,
        layout ? `模式 ${layout}` : "",
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
      "当前服务端未检测到 LibreOffice，请安装后再启用 Office 转 PDF。"
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

app.post("/api/pdf/to-word", async (req, res) => {
  const file = req.body.file;
  const format = req.body.format || "DOCX";
  const layout = req.body.layout || "";

  let tempDir = "";

  try {
    assertPdfFile(file);
    tempDir = fs.mkdtempSync(path.join(config.tempDir, "pdf-word-"));
    console.log("[PDF to Word] 临时目录:", tempDir);
    
    const randomId = makeId();
    const inputName = `input-${randomId}.pdf`;
    const inputPath = path.join(tempDir, inputName);

    const fileBuffer = decodeBase64File(file);
    console.log("[PDF to Word] 输入文件大小:", fileBuffer.length, "bytes");
    fs.writeFileSync(inputPath, decodeBase64File(file));
    
    console.log("[PDF to Word] 开始提取PDF文本...");
    const pdfParser = new PDFParser(this, 1);
    
    const data = await new Promise((resolve, reject) => {
      pdfParser.on("pdfParser_dataError", (errData) => {
        reject(new Error(errData.parserError));
      });
      pdfParser.on("pdfParser_dataReady", (pdfData) => {
        resolve(pdfData);
      });
      pdfParser.parseBuffer(fileBuffer);
    });
    
    const numPages = data.Pages.length;
    console.log("[PDF to Word] 提取完成, 共", numPages, "页");
    
    console.log("[PDF to Word] 生成Word文档...");
    const paragraphs = [];
    
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: "PDF转换结果", bold: true, size: 32 })],
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }));
    
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: "文档信息", bold: true, size: 24 })],
      heading: HeadingLevel.HEADING_2,
      spacing: { after: 200 },
    }));
    
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: `原文件: ${file.name || inputName}` })],
      spacing: { after: 100 },
    }));
    
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: `页数: ${numPages}` })],
      spacing: { after: 200 },
    }));
    
    paragraphs.push(new Paragraph({
      children: [new TextRun({ text: "文档内容", bold: true, size: 24 })],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 400, after: 200 },
    }));
    
    for (let pageIndex = 0; pageIndex < data.Pages.length; pageIndex++) {
      const page = data.Pages[pageIndex];
      
      if (pageIndex > 0) {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: `--- 第 ${pageIndex + 1} 页 ---`, bold: true })],
          spacing: { before: 200, after: 100 },
        }));
      }
      
      if (page.Texts) {
        const textParts = page.Texts.map(t => t.R && t.R[0] ? decodePdfTextToken(t.R[0].T) : "");
        const pageText = textParts.join(" ").replace(/\s+/g, " ").trim();
        
        const textLines = pageText.split(/\n+/);
        for (const line of textLines) {
          if (line.trim()) {
            paragraphs.push(new Paragraph({
              children: [new TextRun({ text: line.trim() })],
              spacing: { after: 100 },
            }));
          }
        }
      }
    }
    
    const doc = new Document({
      sections: [{
        properties: {},
        children: paragraphs,
      }],
    });
    
    const buffer = await Packer.toBuffer(doc);
    console.log("[PDF to Word] Word文档生成完成, 大小:", buffer.length, "bytes");
    
    const output = await saveOutputFile(req, buffer, {
      extension: "docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
        format,
        layout,
        pages: numPages,
      },
    });

    res.json({
      ok: true,
      resultType: "document",
      headline: "PDF 转 Word 已完成",
      detail: "已提取PDF文本内容并转换为可编辑的Word文档。",
      file: buildFileResponse(output, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      metaLines: [
        `原文件 ${file.name || inputName}`,
        `共 ${numPages} 页`,
        `输出格式 DOCX`,
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
      console.log(`[Temp Cleanup] 清理了 ${count} 个旧临时目录`);
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
