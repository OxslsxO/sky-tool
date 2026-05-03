const qrcode = require("../../utils/vendor/qrcode-generator");
const { PDFDocument } = require("../../utils/vendor/pdf-lib");
const { getToolById, getCategoryById } = require("../../data/mock");

const BACKGROUND_COLOR_MAP = {
  "白色": "#ffffff",
  "蓝色": "#2d6ec9",
  "红色": "#cf5446",
  "浅蓝": "#87ceeb",
  "天蓝": "#2d6ec9",
  "藏蓝": "#1e3a5f",
  "大红": "#cf5446",
  "酒红": "#8b0000",
  "浅灰": "#d3d3d3",
  "淡粉": "#ffb6c1",
  "淡绿": "#90ee90",
};

const DEFAULT_BACKGROUND_COLORS = ["白色", "蓝色", "红色"];
const AUDIO_CONVERT_AUDIO_FORMATS = ["MP3", "WAV", "FLAC", "OGG", "M4A", "AAC"];
const AUDIO_CONVERT_VIDEO_FORMATS = ["MP4", "MOV", "WEBM"];
const AUDIO_CONVERT_AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a", "aac", "ncm"];
const AUDIO_CONVERT_VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv", "wmv", "flv"];
const {
  createTask,
  getBillingPreview,
  commitUsage,
  toggleFavorite,
  isFavoriteTool,
  touchRecentTool,
  listTasks,
  getPhotoIdStats,
  incrementPhotoIdUsage,
  getUserState,
} = require("../../utils/task-store");
const { isClientTool } = require("../../utils/tool-engine");
const { getGroupUnits, convertValue } = require("../../utils/unit-converter");
const { formatFileSize } = require("../../utils/format");
const { getPreferredRemoteFileUrl } = require("../../utils/remote-file");
const { hasBackendService } = require("../../services/backend-tools");
const { ensureWechatLogin } = require("../../utils/page-auth");
const logger = require("../../utils/logger");
const {
  requestJson,
  packLocalFile,
  downloadRemoteFile,
  uploadLocalFile,
  uploadFileForJson,
} = require("../../services/remote-executor");
const payment = require("../../services/payment");

function chooseImage(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ["image"],
      sizeType: ["original"],
      sourceType: ["album", "camera"],
      success: (result) => resolve(result.tempFiles),
      fail: reject,
    });
  });
}

function chooseMessageFiles(count, extension) {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count,
      type: "file",
      extension,
      success: (result) => resolve(result.tempFiles || []),
      fail: reject,
    });
  });
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: resolve,
      fail: reject,
    });
  });
}

function getFileInfo(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: resolve,
      fail: () => resolve(null),
    });
  });
}

function drawContext(ctx) {
  return new Promise((resolve) => {
    ctx.draw(false, resolve);
  });
}

function canvasToTempFilePath(page, options) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath(
      {
        canvasId: "toolCanvas",
        ...options,
        success: resolve,
        fail: reject,
      },
      page
    );
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function estimateRemoteDurationMs(toolId, sizeBytes) {
  const mb = Math.max(Number(sizeBytes || 0) / 1024 / 1024, 0.1);
  const baseMap = {
    "photo-id": 15000,
    "ocr-text": 9000,
    "pdf-merge": 9000,
    "pdf-split": 9000,
    "pdf-compress": 11000,
    "office-to-pdf": 18000,
    "pdf-to-word": 24000,
    "audio-convert": 18000,
    "universal-compress": 14000,
  };
  const perMbMap = {
    "photo-id": 900,
    "ocr-text": 700,
    "pdf-merge": 700,
    "pdf-split": 650,
    "pdf-compress": 900,
    "office-to-pdf": 1200,
    "pdf-to-word": 1500,
    "audio-convert": 1300,
    "universal-compress": 1200,
  };
  const base = baseMap[toolId] || 8000;
  const perMb = perMbMap[toolId] || 800;
  return Math.min(65000, Math.max(5000, Math.round(base + mb * perMb)));
}

function buildOcrLineItems(lines, fallbackText) {
  const sourceLines = Array.isArray(lines) && lines.length
    ? lines
    : String(fallbackText || "").split(/\r?\n/);

  const cleanLines = sourceLines
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  const blocks = [];

  cleanLines.forEach((line) => {
    const previous = blocks[blocks.length - 1];
    if (!previous) {
      blocks.push(line);
      return;
    }

    if (shouldMergeOcrLine(previous, line)) {
      blocks[blocks.length - 1] = mergeOcrLines(previous, line);
      return;
    }

    blocks.push(line);
  });

  return blocks.map((line, index) => ({
    id: `${index}-${line.slice(0, 12)}`,
    text: line,
  }));
}

function shouldMergeOcrLine(previous, current) {
  const prev = String(previous || "").trim();
  const next = String(current || "").trim();

  if (!prev || !next) {
    return false;
  }

  if (/^https?:\/\//i.test(prev) && !/[。！？!?]$/.test(prev)) {
    return /^[A-Za-z0-9&?=._:/-]+$/.test(next);
  }

  if ((/[&?=/_-]$/.test(prev) || /^[&?=/_-]/.test(next)) && /^[A-Za-z0-9&?=._:/-]+$/.test(next)) {
    return true;
  }

  const prevHasCjk = /[\u4e00-\u9fff]/.test(prev);
  const nextHasCjk = /[\u4e00-\u9fff]/.test(next);
  if (prevHasCjk !== nextHasCjk) {
    return false;
  }

  if (prevHasCjk && prev.length <= 28 && next.length <= 14 && (prev.length + next.length) <= 34 && !/[。！？!?]$/.test(prev)) {
    return true;
  }

  if (!prevHasCjk && /^[A-Za-z0-9\s&?=._:/-]+$/.test(prev) && /^[A-Za-z0-9\s&?=._:/-]+$/.test(next) && (prev.length + next.length) < 80) {
    return true;
  }

  return false;
}

function mergeOcrLines(previous, current) {
  const prev = String(previous || "").trim();
  const next = String(current || "").trim();

  if (/[&?=/_-]$/.test(prev) || /^[&?=/_-]/.test(next)) {
    return `${prev}${next}`;
  }

  if (/[\u4e00-\u9fff]$/.test(prev) && /^[\u4e00-\u9fff]/.test(next)) {
    return `${prev} / ${next}`;
  }

  return `${prev} ${next}`;
}

function readFileArrayBuffer(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (result) => resolve(result.data),
      fail: reject,
    });
  });
}

function writeArrayBufferFile(filePath, data) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: data.buffer || data,
      success: () => resolve(filePath),
      fail: reject,
    });
  });
}

function writeBase64File(filePath, base64) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: base64,
      encoding: "base64",
      success: () => resolve(filePath),
      fail: reject,
    });
  });
}

function setFillStyle(ctx, color) {
  if (ctx.setFillStyle) {
    ctx.setFillStyle(color);
    return;
  }

  ctx.fillStyle = color;
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    return;
  }

  const right = x + width;
  const bottom = y + height;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(right - radius, y);
  ctx.quadraticCurveTo(right, y, right, y + radius);
  ctx.lineTo(right, bottom - radius);
  ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
  ctx.lineTo(x + radius, bottom);
  ctx.quadraticCurveTo(x, bottom, x, bottom - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

function drawQrLogoImage(ctx, logo, canvasSize) {
  if (!logo || !logo.path) {
    return;
  }

  const logoSize = Math.max(46, Math.min(76, Math.round(canvasSize * 0.18)));
  const padding = 8;
  const x = Math.round((canvasSize - logoSize) / 2);
  const y = x;
  setFillStyle(ctx, "#ffffff");
  drawRoundedRect(ctx, x - padding, y - padding, logoSize + padding * 2, logoSize + padding * 2, 14);
  ctx.drawImage(logo.path, x, y, logoSize, logoSize);
}

function getImageExtension(filePath) {
  const match = /\.([A-Za-z0-9]+)$/.exec(filePath || "");
  return match ? match[1].toLowerCase() : "jpg";
}

function getFileName(filePath) {
  return (filePath || "").split(/[\\/]/).pop() || "file";
}

function clampDimension(value, fallback) {
  const number = Number(value);
  if (!number || Number.isNaN(number)) {
    return fallback;
  }

  return Math.max(100, Math.min(2400, Math.round(number)));
}

function getToolParam(tool, key) {
  return (tool.params || []).find((item) => item.key === key) || null;
}

function getToolOption(tool, key, index) {
  const param = getToolParam(tool, key);
  return param && param.options ? param.options[index] : "";
}

function getFileExtension(fileName) {
  return String(fileName || "").split(".").pop().toLowerCase();
}

function getAudioConvertInputKind(fileName) {
  const ext = getFileExtension(fileName);
  if (AUDIO_CONVERT_AUDIO_EXTS.includes(ext)) {
    return "audio";
  }
  if (AUDIO_CONVERT_VIDEO_EXTS.includes(ext)) {
    return "video";
  }
  return "";
}

function getAudioConvertTargetOptions(inputKind) {
  if (inputKind === "audio") {
    return AUDIO_CONVERT_AUDIO_FORMATS;
  }
  if (inputKind === "video") {
    return AUDIO_CONVERT_AUDIO_FORMATS.concat(AUDIO_CONVERT_VIDEO_FORMATS);
  }
  return [];
}

function getAudioConvertResultKind(fileName, target) {
  const ext = getFileExtension(fileName || target);
  if (AUDIO_CONVERT_AUDIO_EXTS.includes(ext)) {
    return "audio";
  }
  if (AUDIO_CONVERT_VIDEO_FORMATS.map((item) => item.toLowerCase()).includes(ext)) {
    return "video";
  }
  return "";
}

const PHOTO_ID_SESSION_KEY = "tool-detail-photo-id-session";

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function readPhotoIdSession() {
  try {
    const session = wx.getStorageSync(PHOTO_ID_SESSION_KEY) || null;
    if (session && isRemoteUrl(session.photoIdResultPath)) {
      session.photoIdResultPath = "";
    }
    return session;
  } catch (error) {
    return null;
  }
}

function writePhotoIdSession(payload) {
  try {
    // 只存储必要的信息，减少存储数据量
    const minimalPayload = {
      selections: payload.selections || {},
      imageInput: payload.imageInput || null,
      imageInputs: payload.imageInputs || [],
      photoIdResultReady: payload.photoIdResultReady,
      photoIdResultPath: isRemoteUrl(payload.photoIdResultPath) ? "" : payload.photoIdResultPath,
      photoIdResultRemoteUrl: payload.photoIdResultRemoteUrl,
      photoIdResultName: payload.photoIdResultName,
      photoIdResultHeadline: payload.photoIdResultHeadline,
      photoIdResultDetail: payload.photoIdResultDetail,
      photoIdResultMetaLines: payload.photoIdResultMetaLines || [],
    };
    wx.setStorageSync(PHOTO_ID_SESSION_KEY, minimalPayload);
  } catch (error) {
    // Ignore storage write failures and keep the current page usable.
  }
}

function persistPhotoIdSession(nextState) {
  writePhotoIdSession(nextState);
}

function clearPhotoIdSession() {
  try {
    wx.removeStorageSync(PHOTO_ID_SESSION_KEY);
  } catch (error) {
    // Ignore storage cleanup failures.
  }
}

Page({
  data: {
    // 音视频分类目标格式（分离音频和视频）
    audioConvertAudioFormats: AUDIO_CONVERT_AUDIO_FORMATS,
    audioConvertVideoFormats: AUDIO_CONVERT_VIDEO_FORMATS,
    // PDF合并相关
    pdfMergePreviewFiles: [], // 预览用的PDF文件信息（带页数）
    pdfMergeSorting: false, // 是否正在排序
    pdfMergeCurrentIndex: 0, // 当前预览的索引
    pdfMergeResultReady: false,
    pdfMergeResultPath: "",
    pdfMergeResultRemoteUrl: "",
    pdfMergeResultName: "",
    pdfMergeResultHeadline: "",
    pdfMergeResultDetail: "",
    pdfMergeResultMetaLines: [],
    tool: null,
    category: null,
    selections: {},
    billing: null,
    favorite: false,
    relatedTasks: [],
    heroScenario: "",
    isClientTool: false,
    isBackendTool: false,
    visibleParams: [],
    showImageUpload: false,
    showTextInput: false,
    showUnitConverter: false,
    showCustomSize: false,
    canvasWidth: 320,
    canvasHeight: 320,
    imageInput: null,
    imageInputs: [],
    textInput: "https://",
    qrLogoInput: null,
    numberInput: "1",
    unitOptions: [],
    fromUnit: "",
    toUnit: "",
    customWidth: "1600",
    customHeight: "900",
    isWorking: false,
    helperTitle: "",
    helperCopy: "",
    backendConfigured: false,
    actionTitle: "",
    actionHint: "",
    primaryActionText: "",
    primaryActionDisabled: false,
    latestCreatedTaskId: "",
    backendFiles: [],
    pageRange: "1-1",
    showBackendFilePicker: false,
    showBackendRangeInput: false,
    backendPickerTitle: "",
    backendPickerButtonText: "",
    audioTargetOptions: [],
    audioInputKind: "",
    audioConvertResultReady: false,
    audioConvertResultPath: "",
    audioConvertResultRemoteUrl: "",
    audioConvertResultName: "",
    audioConvertResultHeadline: "",
    audioConvertResultDetail: "",
    audioConvertResultMetaLines: [],
    audioConvertResultKind: "",
    audioConvertIsPlaying: false,
    audioConvertAudioContext: null,
    showRecentTasks: true,
    photoIdResultReady: false,
    photoIdResultPath: "",
    photoIdResultRemoteUrl: "",
    photoIdResultName: "",
    photoIdResultHeadline: "",
    photoIdResultDetail: "",
    photoIdResultMetaLines: [],
    ocrResultReady: false,
    ocrResultText: "",
    ocrResultLines: [],
    ocrResultHeadline: "",
    ocrResultDetail: "",
    ocrResultProviderText: "",
    compressResultReady: false,
    compressResultPath: "",
    compressResultRemoteUrl: "",
    compressResultName: "",
    compressResultHeadline: "",
    compressResultDetail: "",
    compressResultBeforeSizeText: "",
    compressResultAfterSizeText: "",
    compressResultSavedText: "",
    compressResultMetaLines: [],
    convertResultReady: false,
    convertResultPath: "",
    convertResultRemoteUrl: "",
    convertResultName: "",
    convertResultHeadline: "",
    convertResultDetail: "",
    convertResultFromFormat: "",
    convertResultToFormat: "",
    convertResultMetaLines: [],
    resizeResultReady: false,
    resizeResultPath: "",
    resizeResultRemoteUrl: "",
    resizeResultName: "",
    resizeResultHeadline: "",
    resizeResultDetail: "",
    resizeResultMetaLines: [],
    resizeBeforeWidth: 0,
    resizeBeforeHeight: 0,
    resizeAfterWidth: 0,
    resizeAfterHeight: 0,
    universalCompressResultReady: false,
    universalCompressResultPath: "",
    universalCompressResultRemoteUrl: "",
    universalCompressResultName: "",
    universalCompressResultHeadline: "",
    universalCompressResultDetail: "",
    universalCompressResultBeforeSizeText: "",
    universalCompressResultAfterSizeText: "",
    universalCompressResultSavedText: "",
    universalCompressResultMetaLines: [],
    universalCompressFileType: "",
    pdfToWordResultReady: false,
    pdfToWordResultPath: "",
    pdfToWordResultRemoteUrl: "",
    pdfToWordResultName: "",
    pdfToWordResultHeadline: "",
    pdfToWordResultDetail: "",
    pdfToWordResultMetaLines: [],
    imageToPdfResultReady: false,
    imageToPdfResultPath: "",
    imageToPdfResultRemoteUrl: "",
    imageToPdfResultName: "",
    imageToPdfResultHeadline: "",
    imageToPdfResultDetail: "",
    imageToPdfResultMetaLines: [],
    imageToPdfCurrentIndex: 0,
    imageToPdfSorting: false,
    photoIdIsProcessing: false,
    backgroundColorMap: BACKGROUND_COLOR_MAP,
    processingProgress: 0,
    processingDisplayProgress: 0,
    processingDisplayProgressText: 0,
    processingEstimateFrom: 0,
    processingEstimateTo: 0,
    processingEstimateStartedAt: 0,
    processingEstimateDurationMs: 0,
    processingStatus: "",
    processingTitle: "",
    processingKind: "",
    showProcessingOverlay: false,
    showMoreColors: false,
    userState: null,
    selectedPayment: "points", // 默认选择积分支付
  },

  onLoad(options) {
    if (!ensureWechatLogin()) {
      return;
    }

    logger.log("[tool-detail] onLoad", options);
    const tool = getToolById(options.id);

    if (!tool) {
      wx.showToast({
        title: "工具不存在",
        icon: "none",
      });
      return;
    }

    const selections = options.selections
      ? JSON.parse(decodeURIComponent(options.selections))
      : this.buildDefaultSelections(tool);
    const viewState = this.buildViewState(tool, selections);
    const photoIdSession = tool.id === "photo-id" ? readPhotoIdSession() : null;
    const photoIdStats = tool.id === "photo-id" ? getPhotoIdStats() : null;
    // 添加 silent 选项，避免触发同步操作导致页面刷新
    touchRecentTool(tool.id, { silent: true });

    // 计算直接支付的价格显示
    const directPriceDisplay = (tool.points * 0.1).toFixed(1);

    const nextState = {
      tool,
      category: getCategoryById(tool.categoryId),
      selections,
      billing: getBillingPreview(tool),
      favorite: isFavoriteTool(tool.id),
      relatedTasks: this.getRelatedTasks(tool.id),
      heroScenario: (tool.scenarios && tool.scenarios[0]) || "",
      helperTitle: this.getHelperTitle(tool.id),
      helperCopy: this.getHelperCopy(tool.id),
      backendPickerTitle: this.getBackendPickerTitle(tool.id),
      backendPickerButtonText: this.getBackendPickerButtonText(tool.id),
      userState: getUserState(),
      directPriceDisplay,
      ...viewState,
      ...(photoIdSession || {}),
      ...(photoIdStats || {}),
    };

    this.setData(nextState);

    const finalBilling = this.data.billing;
    if (finalBilling && !finalBilling.usable) {
      this.setData({
        primaryActionText: this.getPrimaryActionText({
          isClientTool: this.data.isClientTool,
          backendConfigured: this.data.backendConfigured,
        }),
      });
    }
  },

  onShow() {
    // 🔥 终极根治：完全禁用所有自动刷新逻辑
    // 保留最基础的判断，不执行任何页面重绘、状态更新
    const { tool } = this.data;
    if (!tool) {
      return;
    }
    // 空函数，不做任何刷新、不setData、不重新渲染页面
  },

  onShow() {
    logger.log("[tool-detail] onShow", {
      toolId: this.data.tool ? this.data.tool.id : "",
      photoIdResultReady: this.data.photoIdResultReady,
    });
    const { tool, photoIdResultReady } = this.data;
    if (!tool || tool.id !== "photo-id" || photoIdResultReady) {
      return;
    }

    const photoIdSession = readPhotoIdSession();
    if (photoIdSession && photoIdSession.photoIdResultReady) {
      this.setData(photoIdSession);
    }
  },

  onHide() {
    logger.log("[tool-detail] onHide", {
      toolId: this.data.tool ? this.data.tool.id : "",
      photoIdResultReady: this.data.photoIdResultReady,
    });
  },

  onUnload() {
    this.stopProcessingProgressTicker();
    if (this.data.audioConvertAudioContext) {
      this.data.audioConvertAudioContext.destroy();
    }
    logger.log("[tool-detail] onUnload", {
      toolId: this.data.tool ? this.data.tool.id : "",
      photoIdResultReady: this.data.photoIdResultReady,
    });
  },

  buildDefaultSelections(tool) {
    const selections = {};
    tool.params.forEach((param) => {
      if (tool.id === "image-compress" && param.key === "mode") {
        selections[param.key] = "体积优先";
      } else if (tool.id === "universal-compress" && param.key === "mode") {
        selections[param.key] = "体积优先";
      } else if (tool.id === "image-convert" && param.key === "quality") {
        selections[param.key] = "高清";
      } else {
        selections[param.key] = param.options[0];
      }
    });
    return selections;
  },

  buildViewState(tool, selections) {
    const unitOptions = tool.id === "unit-convert"
      ? getGroupUnits(selections.group)
      : [];
    const customSizeValue = getToolOption(tool, "size", 7);
    const pageRangeValue = getToolOption(tool, "splitMode", 0);
    const backendConfigured = hasBackendService();
    const clientTool = isClientTool(tool.id);
    const backendFiles = this.data && this.data.backendFiles ? this.data.backendFiles : [];
    const audioInputKind = tool.id === "audio-convert" && backendFiles.length
      ? getAudioConvertInputKind(backendFiles[0].name)
      : "";
    const audioTargetOptions = getAudioConvertTargetOptions(audioInputKind);
    const visibleParams = (tool.params || [])
      .filter((param) => !(tool.id === "audio-convert" && param.key === "target" && !audioTargetOptions.length))
      .map((param) => {
        if (tool.id === "audio-convert" && param.key === "target") {
          return {
            ...param,
            options: audioTargetOptions,
          };
        }
        return param;
      });

    // 万能压缩同时支持图片和文件选择
    const isUniversalCompress = tool.id === "universal-compress";

    return {
      isClientTool: clientTool || isUniversalCompress,
      isBackendTool: !clientTool && !isUniversalCompress,
      visibleParams,
      audioTargetOptions,
      audioInputKind,
      showImageUpload: ["photo-id", "image-compress", "image-convert", "resize-crop", "image-to-pdf", "ocr-text"].includes(tool.id),
      showTextInput: tool.id === "qr-maker",
      showUnitConverter: tool.id === "unit-convert",
      showCustomSize: tool.id === "resize-crop" && selections.size === customSizeValue,
      showBackendFilePicker: ["pdf-merge", "pdf-split", "pdf-compress", "office-to-pdf", "pdf-to-word", "audio-convert"].includes(tool.id),
      showBackendRangeInput: tool.id === "pdf-split" && selections.splitMode === pageRangeValue,
      showRecentTasks: true,
      unitOptions,
      fromUnit: unitOptions.includes(this.data.fromUnit) ? this.data.fromUnit : (unitOptions[0] || ""),
      toUnit: unitOptions.includes(this.data.toUnit)
        ? this.data.toUnit
        : (unitOptions[1] || unitOptions[0] || ""),
      backendConfigured,
      actionTitle: this.getActionTitle({
        isClientTool: clientTool || isUniversalCompress,
        backendConfigured,
      }),
      actionHint: this.getActionHint({
        isClientTool: clientTool || isUniversalCompress,
        backendConfigured,
      }),
      primaryActionText: this.getPrimaryActionText({
        isClientTool: clientTool || isUniversalCompress,
        backendConfigured,
      }),
      primaryActionDisabled: !clientTool && !backendConfigured && !isUniversalCompress,
    };
  },

  getActionTitle({ isClientTool: clientTool, backendConfigured }) {
    if (clientTool) {
      return "直接生成结果";
    }

    if (backendConfigured) {
      return "上传并提交处理";
    }

    return "功能维护中";
  },

  getActionHint({ isClientTool: clientTool, backendConfigured }) {
    if (clientTool || backendConfigured) {
      return "";
    }

    return "我们正在优化这项能力，暂时无法使用，请稍后再试。";
  },

  getPrimaryActionText({ isClientTool: clientTool, backendConfigured }) {
    if (this.data.isWorking) {
      return "处理中...";
    }

    const billing = this.data.billing;
    if (billing && !billing.usable) {
      if (clientTool) {
        return "支付并处理";
      }
      if (backendConfigured) {
        return "支付并提交";
      }
      return "支付并处理";
    }

    if (clientTool) {
      return "开始处理";
    }

    if (backendConfigured) {
      return "提交处理";
    }

    return "敬请期待";
  },

  getRelatedTasks(toolId) {
    return listTasks()
      .filter((item) => item.toolId === toolId)
      .slice(0, 3);
  },

  getHelperTitle(toolId) {
    const map = {
      "photo-id": "智能证件照云处理",
      "image-compress": "客户端即时压缩",
      "image-convert": "客户端即时转换",
      "resize-crop": "画布与比例调整",
      "image-to-pdf": "图片整理为 PDF",
      "qr-maker": "二维码即时生成",
      "unit-convert": "即时换算结果",
      "audio-convert": "音视频格式转换",
    };

    return map[toolId] || "云处理能力";
  },

  getBackendPickerTitle(toolId) {
    const map = {
      "pdf-merge": "选择要合并的 PDF",
      "pdf-split": "选择要拆分的 PDF",
      "pdf-compress": "选择要优化的 PDF",
      "office-to-pdf": "选择 Office 文件",
      "audio-convert": "选择音视频文件",
    };

    return map[toolId] || "选择文件";
  },

  getBackendPickerButtonText(toolId) {
    const map = {
      "pdf-merge": "选择 PDF（可多选）",
      "pdf-split": "选择 PDF",
      "pdf-compress": "选择 PDF",
      "office-to-pdf": "选择 Office 文件",
      "audio-convert": "选择音视频文件",
    };

    return map[toolId] || "选择文件";
  },

  getHelperCopy(toolId) {
    const map = {
      "photo-id": "将调用后端自动抠图、规范留白并输出证件照，底色切换会直接走云端处理。",
      "image-compress": "不依赖后端，直接在小程序内完成压缩和导出。",
      "image-convert": "当前客户端稳定支持 JPG 和 PNG 之间互转。",
      "resize-crop": "支持居中裁切、完整缩放和留白版式，适合社媒与商品图。",
      "image-to-pdf": "当前版本支持把一组图片直接整理成单个 PDF，适合作业、票据和资料提交。",
      "qr-maker": "输入链接或文本即可生成二维码，并可保存到相册。",
      "unit-convert": "输入数值后生成可复制结果，适合日常碎片场景。",
      "audio-convert": "支持 MP3、WAV、FLAC、OGG、M4A、AAC、MP4、MOV、WEBM 等音视频格式转换，适合不同设备使用。",
    };

    return map[toolId] || "这类功能依赖云端处理服务，当前仓库已经预留前端结构，后续接后端即可启用。";
  },

  async chooseInputImage() {
    try {
      this.ignoreOnShowRefreshUntil = 0;
      const medias = await chooseImage(this.data.tool.id === "image-to-pdf" ? 9 : 1);
      const imageInputs = [];

      for (let index = 0; index < medias.length; index += 1) {
        const media = medias[index];
        const imageInfo = await getImageInfo(media.tempFilePath);
        const fileInfo = await getFileInfo(media.tempFilePath);
        imageInputs.push({
          path: media.tempFilePath,
          size: fileInfo ? fileInfo.size : media.size,
          sizeText: formatFileSize(fileInfo ? fileInfo.size : media.size),
          width: imageInfo.width,
          height: imageInfo.height,
          extension: getImageExtension(media.tempFilePath),
        });
      }

      const nextState = {
        imageInput: imageInputs[0] || null,
        imageInputs,
      };

      if (this.data.tool && this.data.tool.id === "photo-id") {
        clearPhotoIdSession();
        Object.assign(nextState, this.getClearedPhotoIdResult());
      }

      if (this.data.tool && this.data.tool.id === "image-compress") {
        Object.assign(nextState, this.getClearedCompressResult());
      }

      if (this.data.tool && this.data.tool.id === "image-convert") {
        Object.assign(nextState, this.getClearedConvertResult());

        const allFormats = ["JPG", "PNG", "WEBP", "BMP"];
        const sourceFormat = (imageInputs[0] && imageInputs[0].extension || "").toUpperCase();
        const availableFormats = allFormats.filter(f => f !== sourceFormat);
        nextState.convertTargetOptions = availableFormats;

        const currentTarget = this.data.selections && this.data.selections.target;
        if (!availableFormats.includes(currentTarget)) {
          nextState.selections = { ...this.data.selections, target: availableFormats[0] || "JPG" };
        }
      }

      if (this.data.tool && this.data.tool.id === "resize-crop") {
        Object.assign(nextState, this.getClearedResizeResult());
      }

      if (this.data.tool && this.data.tool.id === "ocr-text") {
        Object.assign(nextState, this.getClearedOcrResult());
      }

      if (this.data.tool && this.data.tool.id === "universal-compress") {
        Object.assign(nextState, this.getClearedUniversalCompressResult());
      }

      this.setData(nextState);
      if (this.data.tool && this.data.tool.id === "photo-id") {
        persistPhotoIdSession({
          ...this.data,
          ...nextState,
        });
      }
    } catch (error) {
      this.ignoreOnShowRefreshUntil = 0;
      if (error && error.errMsg && error.errMsg.indexOf("cancel") > -1) {
        return;
      }

      wx.showToast({
        title: "选择图片失败",
        icon: "none",
      });
    }
  },

  // 万能压缩选择文件
  async chooseUniversalCompressFile() {
    wx.showActionSheet({
      itemList: ['选择图片', '选择文件(PDF/Office/音视频)'],
      success: async (res) => {
        try {
          this.ignoreOnShowRefreshUntil = Date.now() + 3000;

          const nextState = {};

          if (res.tapIndex === 0) {
            // 选择图片
            const medias = await chooseImage(1);
            const imageInputs = [];

            for (let index = 0; index < medias.length; index += 1) {
              const media = medias[index];
              const imageInfo = await getImageInfo(media.tempFilePath);
              const fileInfo = await getFileInfo(media.tempFilePath);
              imageInputs.push({
                path: media.tempFilePath,
                size: fileInfo ? fileInfo.size : media.size,
                sizeText: formatFileSize(fileInfo ? fileInfo.size : media.size),
                width: imageInfo.width,
                height: imageInfo.height,
                extension: getImageExtension(media.tempFilePath),
              });
            }

            Object.assign(nextState, {
              imageInput: imageInputs[0] || null,
              imageInputs,
              backendFiles: [],
            });
          } else {
            // 选择文件
            const files = await chooseMessageFiles(1, ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "mp3", "wav", "flac", "m4a", "aac", "ogg", "mp4", "mov", "avi", "mkv", "webm", "ncm"]);
            Object.assign(nextState, {
              imageInput: null,
              imageInputs: [],
              backendFiles: files.map((file) => ({
                path: file.path,
                name: file.name || getFileName(file.path),
                size: file.size || 0,
                sizeText: formatFileSize(file.size || 0),
              })),
            });
          }

          // 清除之前的结果
          Object.assign(nextState, this.getClearedUniversalCompressResult());

          this.setData(nextState);
        } catch (error) {
          this.ignoreOnShowRefreshUntil = 0;
          if (error && error.errMsg && error.errMsg.indexOf("cancel") > -1) {
            return;
          }

          wx.showToast({
            title: "选择文件失败",
            icon: "none",
          });
        }
      }
    });
  },

  async chooseQrLogo() {
    try {
      const medias = await chooseImage(1);
      const media = medias[0];
      if (!media) {
        return;
      }

      const imageInfo = await getImageInfo(media.tempFilePath);
      const fileInfo = await getFileInfo(media.tempFilePath);
      this.setData({
        qrLogoInput: {
          path: media.tempFilePath,
          size: fileInfo ? fileInfo.size : media.size,
          sizeText: formatFileSize(fileInfo ? fileInfo.size : media.size),
          width: imageInfo.width,
          height: imageInfo.height,
        },
      });
    } catch (error) {
      if (error && error.errMsg && error.errMsg.indexOf("cancel") > -1) {
        return;
      }

      wx.showToast({
        title: "Logo 选择失败",
        icon: "none",
      });
    }
  },

  removeQrLogo() {
    this.setData({
      qrLogoInput: null,
    });
  },

  handleTextInput(event) {
    this.setData({
      textInput: event.detail.value,
    });
  },

  handlePageRangeInput(event) {
    this.setData({
      pageRange: event.detail.value,
    });
  },

  handleOptionSelect(event) {
    const { key, value } = event.currentTarget.dataset;
    const selections = {
      ...this.data.selections,
      [key]: value,
    };

    const nextState = {
      selections,
      ...this.buildViewState(this.data.tool, selections),
    };

    if (this.data.tool && this.data.tool.id === "photo-id") {
      clearPhotoIdSession();
      Object.assign(nextState, this.getClearedPhotoIdResult());
    }

    if (this.data.tool && this.data.tool.id === "image-compress") {
      Object.assign(nextState, this.getClearedCompressResult());
    }

    if (this.data.tool && this.data.tool.id === "audio-convert") {
      Object.assign(nextState, this.getClearedAudioConvertResult());
    }

    this.setData(nextState);
    if (this.data.tool && this.data.tool.id === "photo-id") {
      persistPhotoIdSession({
        ...this.data,
        ...nextState,
      });
    }
  },

  toggleMoreColors() {
    this.setData({ showMoreColors: !this.data.showMoreColors });
  },

  handleNumberInput(event) {
    this.setData({
      numberInput: event.detail.value,
    });
  },

  handleCustomWidth(event) {
    this.setData({
      customWidth: event.detail.value,
    });
  },

  handleCustomHeight(event) {
    this.setData({
      customHeight: event.detail.value,
    });
  },

  handleUnitChange(event) {
    const { field } = event.currentTarget.dataset;
    const unit = this.data.unitOptions[event.detail.value];
    this.setData({
      [field]: unit,
    });
  },

  swapUnits() {
    this.setData({
      fromUnit: this.data.toUnit,
      toUnit: this.data.fromUnit,
    });
  },

  handleFavorite() {
    const { tool } = this.data;
    const favorite = toggleFavorite(tool.id);

    this.setData({
      favorite,
    });

    wx.showToast({
      title: favorite ? "已收藏" : "已取消收藏",
      icon: "none",
    });
  },

  selectPayment(e) {
    const { type } = e.currentTarget.dataset;
    this.setData({
      selectedPayment: type,
    });
  },

  openTask(event) {
    const { id } = event.currentTarget.dataset;
    if (!id) {
      return;
    }

    wx.navigateTo({
      url: `/pages/task-detail/index?id=${id}`,
    });
  },

  openServiceConfig() {
    wx.navigateTo({
      url: "/pages/service-config/index",
    });
  },

  getProcessingTitle(tool) {
    const titleMap = {
      "photo-id": "证件照处理中",
      "image-compress": "图片压缩中",
      "image-convert": "图片转换中",
      "resize-crop": "图片调整中",
      "universal-compress": "文件压缩中",
      "image-to-pdf": "PDF 生成中",
      "ocr-text": "文字识别中",
      "pdf-merge": "PDF 合并中",
      "pdf-split": "PDF 拆分中",
      "pdf-compress": "PDF 压缩中",
      "office-to-pdf": "文档转换中",
      "pdf-to-word": "Word 转换中",
      "audio-convert": "音视频转换中",
      "qr-maker": "二维码生成中",
      "unit-convert": "单位换算中",
    };

    return titleMap[tool && tool.id] || "处理中";
  },

  showProcessingPanel(tool, options = {}) {
    this.setData({
      isWorking: true,
      photoIdIsProcessing: tool && tool.id === "photo-id",
      showProcessingOverlay: true,
      processingProgress: options.progress || 6,
      processingDisplayProgress: 0,
      processingDisplayProgressText: 0,
      processingEstimateFrom: 0,
      processingEstimateTo: options.progress || 6,
      processingEstimateStartedAt: Date.now(),
      processingEstimateDurationMs: 0,
      processingStatus: options.status || "正在准备...",
      processingTitle: options.title || this.getProcessingTitle(tool),
      processingKind: tool ? tool.id : "",
    });
    this.startProcessingProgressTicker();
  },

  async handleExecute() {
    logger.log("[处理执行] 开始执行处理");

    if (this.data.isWorking) {
      logger.log("[处理执行] 已经在处理中，跳过");
      return;
    }

    logger.log("[处理执行] 检查计费信息");
    const billing = getBillingPreview(this.data.tool);
    logger.log("[处理执行] 计费信息:", billing);

    if (!billing.usable) {
      logger.log("[处理执行] 计费不可用，进入支付流程");
      try {
        const payResult = await payment.purchaseTool(this.data.tool);
        if (!payResult.success) {
          wx.showToast({
            title: payResult.message || "支付失败",
            icon: "none",
          });
          return;
        }
        this.setData({
          billing: getBillingPreview(this.data.tool),
          userState: getUserState(),
          primaryActionText: this.getPrimaryActionText({
            isClientTool: this.data.isClientTool,
            backendConfigured: this.data.backendConfigured,
          }),
        });
      } catch (err) {
        if (err.cancelled) {
          return;
        }
        wx.showToast({
          title: err.message || "支付失败，请重试",
          icon: "none",
        });
        return;
      }
    } else {
      const usageResult = commitUsage(this.data.tool);
      if (!usageResult.usable) {
        wx.showToast({
          title: usageResult.text || "资源不足",
          icon: "none",
        });
        return;
      }

      this.setData({
        billing: getBillingPreview(this.data.tool),
        userState: getUserState(),
      });
    }

    logger.log("[处理执行] 检查工具类型和合规性");
    const { tool, imageInput } = this.data;

    if (tool.id === "photo-id" && imageInput) {
      logger.log("[处理执行] 执行证件照合规性检查");
      const complianceCheck = await this.checkPhotoCompliance(imageInput);
      if (!complianceCheck.passed) {
        logger.log("[处理执行] 合规性检查未通过:", complianceCheck.message);
        wx.showModal({
          title: "图片检查提示",
          content: complianceCheck.message,
          showCancel: false,
          confirmText: "知道了",
        });
        return;
      }
      logger.log("[处理执行] 合规性检查通过");
    }

    logger.log("[处理执行] 开始设置处理状态");
    this.showProcessingPanel(tool, {
      progress: tool && tool.id === "image-compress" ? 8 : 6,
      status: tool && tool.id === "image-compress" ? "正在读取原图..." : "正在初始化...",
    });
    logger.log("[处理执行] 处理状态设置完成");

    let executionSucceeded = false;
    try {
      const { tool } = this.data;
      logger.log("[处理执行] 当前工具:", tool.id);

      if (this.data.isBackendTool && !this.data.backendConfigured) {
        logger.log("[处理执行] 后端工具未配置");
        wx.showToast({
          title: "功能维护中，请稍后再试",
          icon: "none",
        });
        this.setData({
          isWorking: false,
          photoIdIsProcessing: false,
        });
      } else if (this.data.isBackendTool) {
        logger.log("[处理执行] 执行后端工具");
        await this.runBackendTool();
        logger.log("[处理执行] 后端工具执行完成");
      } else if (tool.id === "image-compress") {
        logger.log("[处理执行] 执行图片压缩");
        await this.runImageCompress();
      } else if (tool.id === "image-convert") {
        logger.log("[处理执行] 执行图片转换");
        await this.runImageConvert();
      } else if (tool.id === "resize-crop") {
        logger.log("[处理执行] 执行图片调整");
        await this.runImageResize();
      } else if (tool.id === "universal-compress") {
        logger.log("[处理执行] 执行万能压缩");
        await this.runUniversalCompress();
      } else if (tool.id === "image-to-pdf") {
        logger.log("[处理执行] 执行图片转PDF");
        await this.runImageToPdf();
      } else if (tool.id === "qr-maker") {
        logger.log("[处理执行] 执行二维码生成");
        await this.runQrMaker();
      } else if (tool.id === "unit-convert") {
        logger.log("[处理执行] 执行单位转换");
        await this.runUnitConvert();
      }
      executionSucceeded = true;
    } catch (error) {
      logger.error("[处理执行] 执行失败:", error.message);
      this.setData({
        isWorking: false,
        photoIdIsProcessing: false,
      });

      wx.showToast({
        title: error && (error.message || error.code) ? (error.message || error.code) : "处理失败，请稍后重试",
        icon: "none",
      });
    }
    finally {
      logger.log("[处理执行] 进入 finally 块");
      if (executionSucceeded && this.data.showProcessingOverlay) {
        this.updateProcessingProgress(100, "处理完成");
        this.setData({
          processingDisplayProgress: 100,
          processingDisplayProgressText: 100,
        });
        await wait(220);
      }

      const nextState = {
        isWorking: false,
        photoIdIsProcessing: false,
      };
      if (!this.data.photoIdResultReady) {
        nextState.showProcessingOverlay = false;
        nextState.processingProgress = 0;
        nextState.processingDisplayProgress = 0;
        nextState.processingDisplayProgressText = 0;
        nextState.processingEstimateFrom = 0;
        nextState.processingEstimateTo = 0;
        nextState.processingEstimateStartedAt = 0;
        nextState.processingEstimateDurationMs = 0;
        nextState.processingStatus = "";
        nextState.processingTitle = "";
        nextState.processingKind = "";
      }
      this.setData(nextState);
      if (!nextState.showProcessingOverlay) {
        this.stopProcessingProgressTicker();
      }
      logger.log("[处理执行] 重置处理状态");
      this.ignoreOnShowRefreshUntil = true;
      logger.log("[处理执行] 设置页面锁定标志");
      if (this.data.photoIdResultReady) {
        persistPhotoIdSession(this.data);
      }
      logger.log("[处理执行] 处理流程结束");
    }
  },

  async chooseBackendFiles() {
    try {
      this.ignoreOnShowRefreshUntil = Date.now() + 3000;
      const { tool } = this.data;
      const count = tool.id === "pdf-merge" ? 20 : 1;
      const extensionMap = {
        "pdf-merge": ["pdf"],
        "pdf-split": ["pdf"],
        "pdf-compress": ["pdf"],
        "office-to-pdf": ["doc", "docx", "xls", "xlsx", "ppt", "pptx"],
        "pdf-to-word": ["pdf"],
        "audio-convert": ["mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "mov", "webm", "avi", "mkv", "wmv", "flv"],
      };

      const files = await chooseMessageFiles(count, extensionMap[tool.id] || []);

      // PDF合并做上传限制
      if (tool.id === "pdf-merge") {
        // 检查文件数量
        if (files.length < 2) {
          wx.showModal({
            title: "提示",
            content: "PDF合并至少需要上传2个PDF文件",
            showCancel: false,
            confirmText: "知道了",
          });
          return;
        }
        // 检查文件大小（单个不超过50MB，总共不超过200MB）
        let totalSize = 0;
        let invalidFile = null;
        for (let file of files) {
          const size = file.size || 0;
          totalSize += size;
          if (size > 50 * 1024 * 1024) {
            invalidFile = file.name || getFileName(file.path);
            break;
          }
        }
        if (invalidFile) {
          wx.showModal({
            title: "提示",
            content: `文件「${invalidFile}」超过50MB，单个文件最大支持50MB`,
            showCancel: false,
            confirmText: "知道了",
          });
          return;
        }
        if (totalSize > 200 * 1024 * 1024) {
          wx.showModal({
            title: "提示",
            content: `所有文件总大小超过200MB，当前总共${formatFileSize(totalSize)}`,
            showCancel: false,
            confirmText: "知道了",
          });
          return;
        }
      }

      const backendFiles = files.map((file) => ({
        path: file.path,
        name: file.name || getFileName(file.path),
        size: file.size || 0,
        sizeText: formatFileSize(file.size || 0),
      }));

      const nextState = {
        backendFiles,
      };

      if (tool.id === "pdf-merge") {
        // PDF合并：先显示基本预览，再加载页数
        const initialPreviewFiles = backendFiles.map((file) => ({
          ...file,
          pageCount: 0,
        }));
        Object.assign(nextState, this.getClearedPdfMergeResult());
        nextState.pdfMergePreviewFiles = initialPreviewFiles;
        nextState.pdfMergeSorting = false;
        nextState.pdfMergeCurrentIndex = 0;
        
        // 先更新UI
        this.setData(nextState);
        
        // 再异步加载预览（不阻塞UI）
        this.loadPdfPreviews(backendFiles);
      } else if (tool.id === "pdf-to-word") {
        Object.assign(nextState, this.getClearedPdfToWordResult());
      } else if (tool.id === "audio-convert") {
        if (this.data.audioConvertAudioContext) {
          this.data.audioConvertAudioContext.stop();
        }
        const firstFile = nextState.backendFiles[0] || {};
        const inputKind = getAudioConvertInputKind(firstFile.name);
        const targetOptions = getAudioConvertTargetOptions(inputKind);
        const selections = {
          ...this.data.selections,
          target: targetOptions[0] || "",
        };
        Object.assign(nextState, {
          selections,
          ...this.buildViewState(tool, selections),
          audioTargetOptions: targetOptions,
          audioInputKind: inputKind,
          visibleParams: (tool.params || [])
            .filter((param) => !(param.key === "target" && !targetOptions.length))
            .map((param) => param.key === "target" ? { ...param, options: targetOptions } : param),
          ...this.getClearedAudioConvertResult(),
        });
      }

      // PDF合并已经提前 setData 了，避免重复
      if (tool.id !== "pdf-merge") {
        this.setData(nextState);
      }
    } catch (error) {
      this.ignoreOnShowRefreshUntil = 0;
      if (error && error.errMsg && error.errMsg.indexOf("cancel") > -1) {
        return;
      }

      wx.showToast({
        title: "选择文件失败",
        icon: "none",
      });
    }
  },

  async runBackendTool() {
    if (!this.data.backendConfigured) {
      wx.showToast({
        title: "功能维护中，请稍后再试",
        icon: "none",
      });
      return;
    }

    const { tool } = this.data;
    if (tool.id === "photo-id") {
      await this.runRemotePhotoId();
      return;
    }

    if (tool.id === "ocr-text") {
      await this.runRemoteOcr();
      return;
    }

    if (tool.id === "pdf-merge") {
      await this.runRemotePdfMerge();
      return;
    }

    if (tool.id === "pdf-split") {
      await this.runRemotePdfSplit();
      return;
    }

    if (tool.id === "pdf-compress") {
      await this.runRemotePdfCompress();
      return;
    }

    if (tool.id === "office-to-pdf") {
      await this.runRemoteOfficeToPdf();
      return;
    }

    if (tool.id === "pdf-to-word") {
      await this.runRemotePdfToWord();
      return;
    }

    if (tool.id === "audio-convert") {
      await this.runRemoteAudioConvert();
    }
  },

  async withCanvas(width, height, renderer, exportOptions) {
    await new Promise((resolve) => {
      this.setData(
        {
          canvasWidth: width,
          canvasHeight: height,
        },
        resolve
      );
    });

    const ctx = wx.createCanvasContext("toolCanvas", this);
    renderer(ctx);
    await drawContext(ctx);
    await wait(80);

    return canvasToTempFilePath(this, {
      x: 0,
      y: 0,
      width,
      height,
      destWidth: width,
      destHeight: height,
      ...exportOptions,
    });
  },

  async createImageTask(taskOptions, options = {}) {
    const { tool, selections } = this.data;
    let remoteFile = null;

    if (taskOptions.outputPath && !options.skipUpload) {
      remoteFile = await this.uploadGeneratedOutput(taskOptions.outputPath, {
        name: taskOptions.outputName,
        folder: `client-outputs/${tool.id}`,
        contentType: taskOptions.contentType || "image/png",
        extension: taskOptions.extension || getImageExtension(taskOptions.outputName || taskOptions.outputPath),
      });
    }

    const result = createTask(tool, selections, {
      instant: true,
      skipUsage: true,
      resultType: "image",
      ...taskOptions,
      remoteUrl: remoteFile ? remoteFile.url : taskOptions.remoteUrl,
      metaLines: [
        ...(taskOptions.metaLines || []),
        remoteFile ? `云端存储 ${remoteFile.provider === "qiniu" ? "七牛云" : "后端"}` : "云端存储 待同步",
      ],
    });

    if (!result.task) {
      wx.showToast({
        title: result.usage.costText,
        icon: "none",
      });
      return {
        task: null,
        remoteFile,
      };
    }

    this.latestCreatedTaskId = result.task.id;
    this.setData({
      latestCreatedTaskId: result.task.id,
    });

    if (!options.skipToast) {
      wx.showToast({
        title: "处理完成，结果已保存",
        icon: "none",
      });
    }

    return {
      task: result.task,
      remoteFile,
    };
  },

  getClearedCompressResult() {
    return {
      compressResultReady: false,
      compressResultPath: "",
      compressResultRemoteUrl: "",
      compressResultName: "",
      compressResultHeadline: "",
      compressResultDetail: "",
      compressResultBeforeSizeText: "",
      compressResultAfterSizeText: "",
      compressResultSavedText: "",
      compressResultMetaLines: [],
    };
  },

  getClearedConvertResult() {
    return {
      convertResultReady: false,
      convertResultPath: "",
      convertResultRemoteUrl: "",
      convertResultName: "",
      convertResultHeadline: "",
      convertResultDetail: "",
      convertResultFromFormat: "",
      convertResultToFormat: "",
      convertResultMetaLines: [],
    };
  },

  getClearedResizeResult() {
    return {
      resizeResultReady: false,
      resizeResultPath: "",
      resizeResultRemoteUrl: "",
      resizeResultName: "",
      resizeResultHeadline: "",
      resizeResultDetail: "",
      resizeResultMetaLines: [],
      resizeBeforeWidth: 0,
      resizeBeforeHeight: 0,
      resizeAfterWidth: 0,
      resizeAfterHeight: 0,
    };
  },

  getClearedUniversalCompressResult() {
    return {
      universalCompressResultReady: false,
      universalCompressResultPath: "",
      universalCompressResultRemoteUrl: "",
      universalCompressResultName: "",
      universalCompressResultHeadline: "",
      universalCompressResultDetail: "",
      universalCompressResultBeforeSizeText: "",
      universalCompressResultAfterSizeText: "",
      universalCompressResultSavedText: "",
      universalCompressResultMetaLines: [],
      universalCompressFileType: "",
    };
  },

  getClearedOcrResult() {
    return {
      ocrResultReady: false,
      ocrResultText: "",
      ocrResultLines: [],
      ocrResultHeadline: "",
      ocrResultDetail: "",
      ocrResultProviderText: "",
    };
  },

  getClearedPdfToWordResult() {
    return {
      pdfToWordResultReady: false,
      pdfToWordResultPath: "",
      pdfToWordResultRemoteUrl: "",
      pdfToWordResultName: "",
      pdfToWordResultHeadline: "",
      pdfToWordResultDetail: "",
      pdfToWordResultMetaLines: [],
    };
  },

  getClearedAudioConvertResult() {
    return {
      audioConvertResultReady: false,
      audioConvertResultPath: "",
      audioConvertResultRemoteUrl: "",
      audioConvertResultName: "",
      audioConvertResultHeadline: "",
      audioConvertResultDetail: "",
      audioConvertResultMetaLines: [],
      audioConvertResultKind: "",
      audioConvertIsPlaying: false,
    };
  },

  getClearedPdfMergePreview() {
    return {
      pdfMergePreviewFiles: [],
      pdfMergeSorting: false,
      pdfMergeCurrentIndex: 0,
    };
  },

  getClearedPdfMergeResult() {
    return {
      pdfMergeResultReady: false,
      pdfMergeResultPath: "",
      pdfMergeResultRemoteUrl: "",
      pdfMergeResultName: "",
      pdfMergeResultHeadline: "",
      pdfMergeResultDetail: "",
      pdfMergeResultMetaLines: [],
    };
  },

  async loadPdfPreviews(files) {
    try {
      if (!files || !files.length) {
        return;
      }
      // 上传文件并获取PDF信息
      const { packLocalFile, requestJson } = require("../../services/remote-executor");
      const { hasBackendService } = require("../../services/backend-tools");
      if (!hasBackendService()) {
        wx.showToast({
          title: "未配置后端服务",
          icon: "none",
        });
        // 即使没有后端，也显示基本预览
        const previewFiles = files.map((file) => ({
          ...file,
          pageCount: 0,
        }));
        this.setData({
          pdfMergePreviewFiles: previewFiles,
        });
        return;
      }
      // 打包所有PDF文件
      const packedFiles = [];
      for (let file of files) {
        try {
          const packed = await packLocalFile(file);
          packedFiles.push(packed);
        } catch (err) {
          // 打包失败，继续
          packedFiles.push({
            name: file.name,
            sizeBytes: file.size || 0,
            base64: "",
          });
        }
      }
      // 调用预览API
      const result = await requestJson("/api/pdf/preview", { files: packedFiles });
      if (result && result.ok && result.files) {
        // 组合预览文件信息
        const previewFiles = files.map((file, index) => ({
          ...file,
          pageCount: (result.files[index] && result.files[index].pageCount) || 0,
        }));
        this.setData({
          pdfMergePreviewFiles: previewFiles,
        });
      } else {
        // 失败时也显示基本信息
        const previewFiles = files.map((file) => ({
          ...file,
          pageCount: 0,
        }));
        this.setData({
          pdfMergePreviewFiles: previewFiles,
        });
      }
    } catch (error) {
      // 忽略预览错误，继续使用基本信息
      console.error("loadPdfPreviews error:", error);
      const previewFiles = files.map((file) => ({
        ...file,
        pageCount: 0,
      }));
      this.setData({
        pdfMergePreviewFiles: previewFiles,
      });
    }
  },

  handlePdfMergeSwiperChange(e) {
    this.setData({
      pdfMergeCurrentIndex: e.detail.current || 0,
    });
  },

  handlePdfMergeThumbLongPress(e) {
    const index = e.currentTarget.dataset.index;
    wx.showModal({
      title: "调整PDF顺序",
      content: "长按后可拖动调整顺序，点击完成保存。",
      showCancel: false,
      confirmText: "知道了",
      success: () => {
        this.setData({
          pdfMergeSorting: true,
        });
      },
    });
  },

  previewCompressResult() {
    const current = this.data.compressResultPath || this.data.compressResultRemoteUrl;
    if (!current) {
      return;
    }

    wx.previewImage({
      current,
      urls: [current],
    });
  },

  async saveCompressResult() {
    let filePath = this.data.compressResultPath;

    try {
      if (!filePath && this.data.compressResultRemoteUrl) {
        const download = await downloadRemoteFile(this.data.compressResultRemoteUrl);
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("COMPRESS_FILE_MISSING");
      }

      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject,
        });
      });

      wx.showToast({
        title: "已保存到相册",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "保存失败，请检查相册权限",
        icon: "none",
      });
    }
  },

  copyCompressResultLink() {
    if (!this.data.compressResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.compressResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  previewResizeResult() {
    const current = this.data.resizeResultPath || this.data.resizeResultRemoteUrl;
    if (!current) {
      return;
    }

    wx.previewImage({
      current,
      urls: [current],
    });
  },

  async saveResizeResult() {
    let filePath = this.data.resizeResultPath;

    try {
      if (!filePath && this.data.resizeResultRemoteUrl) {
        const download = await downloadRemoteFile(this.data.resizeResultRemoteUrl);
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("RESIZE_FILE_MISSING");
      }

      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject,
        });
      });

      wx.showToast({
        title: "已保存到相册",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "保存失败，请检查相册权限",
        icon: "none",
      });
    }
  },

  copyResizeResultLink() {
    if (!this.data.resizeResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.resizeResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  previewUniversalCompressResult() {
    const current = this.data.universalCompressResultPath || this.data.universalCompressResultRemoteUrl;
    if (!current) {
      return;
    }

    // 如果是图片，使用图片预览
    if (this.data.universalCompressFileType === "image") {
      wx.previewImage({
        current,
        urls: [current],
      });
    } else {
      // 其他文件直接打开
      wx.openDocument({
        filePath: current,
        showMenu: true,
      });
    }
  },

  async saveUniversalCompressResult() {
    const filePath = this.data.universalCompressResultPath;
    const fileType = this.data.universalCompressFileType;
    const remoteUrl = this.data.universalCompressResultRemoteUrl;

    try {
      if (filePath) {
        // 如果是图片，保存到相册
        if (fileType === "image") {
          await new Promise((resolve, reject) => {
            wx.saveImageToPhotosAlbum({
              filePath,
              success: resolve,
              fail: reject,
            });
          });
          wx.showToast({
            title: "已保存到相册",
            icon: "none",
          });
        } else {
          // 其他文件通过文档方式打开，让用户自己保存
          await new Promise((resolve, reject) => {
            wx.openDocument({
              filePath,
              showMenu: true,
              success: resolve,
              fail: reject,
            });
          });
        }
      } else if (remoteUrl) {
        // 如果有远程链接，提供复制链接选项
        wx.showModal({
          title: "文件较大",
          content: "文件较大，建议复制链接后在浏览器中下载保存。",
          confirmText: "复制链接",
          cancelText: "直接下载",
          success: async (res) => {
            if (res.confirm) {
              wx.setClipboardData({
                data: remoteUrl,
                success: () => {
                  wx.showToast({
                    title: "已复制链接",
                    icon: "none",
                  });
                },
              });
            } else {
              try {
                const download = await downloadRemoteFile(remoteUrl);
                if (download.statusCode >= 200 && download.statusCode < 300) {
                  if (fileType === "image") {
                    await new Promise((resolve, reject) => {
                      wx.saveImageToPhotosAlbum({
                        filePath: download.tempFilePath,
                        success: resolve,
                        fail: reject,
                      });
                    });
                    wx.showToast({
                      title: "已保存到相册",
                      icon: "none",
                    });
                  } else {
                    await new Promise((resolve, reject) => {
                      wx.openDocument({
                        filePath: download.tempFilePath,
                        showMenu: true,
                        success: resolve,
                        fail: reject,
                      });
                    });
                  }
                }
              } catch (downloadError) {
                console.error("下载失败:", downloadError);
                wx.showModal({
                  title: "下载失败",
                  content: "文件过大，建议复制链接在浏览器中下载。",
                  confirmText: "复制链接",
                  success: (copyRes) => {
                    if (copyRes.confirm) {
                      wx.setClipboardData({
                        data: remoteUrl,
                        success: () => {
                          wx.showToast({
                            title: "已复制链接",
                            icon: "none",
                          });
                        },
                      });
                    }
                  },
                });
              }
            }
          },
        });
      } else {
        wx.showToast({
          title: "文件暂不可用",
          icon: "none",
        });
      }
    } catch (error) {
      console.error("保存失败:", error);
      if (remoteUrl) {
        wx.showModal({
          title: "保存失败",
          content: "建议复制链接后在浏览器中下载保存。",
          confirmText: "复制链接",
          success: (res) => {
            if (res.confirm) {
              wx.setClipboardData({
                data: remoteUrl,
                success: () => {
                  wx.showToast({
                    title: "已复制链接",
                    icon: "none",
                  });
                },
              });
            }
          },
        });
      } else {
        wx.showToast({
          title: "保存失败，请重试",
          icon: "none",
        });
      }
    }
  },

  copyUniversalCompressResultLink() {
    if (!this.data.universalCompressResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.universalCompressResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  previewConvertResult() {
    const current = this.data.convertResultPath || this.data.convertResultRemoteUrl;
    if (!current) {
      return;
    }

    wx.previewImage({
      current,
      urls: [current],
    });
  },

  async saveConvertResult() {
    let filePath = this.data.convertResultPath;

    try {
      if (!filePath && this.data.convertResultRemoteUrl) {
        const download = await downloadRemoteFile(this.data.convertResultRemoteUrl);
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("CONVERT_FILE_MISSING");
      }

      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject,
        });
      });

      wx.showToast({
        title: "已保存到相册",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "保存失败，请检查相册权限",
        icon: "none",
      });
    }
  },

  copyConvertResultLink() {
    if (!this.data.convertResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.convertResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  async getAudioConvertResultFilePath() {
    let filePath = this.data.audioConvertResultPath;
    if (!filePath && this.data.audioConvertResultRemoteUrl) {
      const download = await downloadRemoteFile(this.data.audioConvertResultRemoteUrl);
      if (download.statusCode >= 200 && download.statusCode < 300) {
        filePath = download.tempFilePath || "";
      }
    }
    return filePath;
  },

  async previewAudioConvertResult() {
    const current = this.data.audioConvertResultPath || this.data.audioConvertResultRemoteUrl;
    if (!current) {
      wx.showToast({
        title: "文件不存在",
        icon: "none",
      });
      return;
    }

    if (this.data.audioConvertResultKind === "audio") {
      let context = this.data.audioConvertAudioContext;
      if (this.data.audioConvertIsPlaying) {
        if (context) {
          context.pause();
        }
        this.setData({ audioConvertIsPlaying: false });
        return;
      }

      if (!context) {
        context = wx.createInnerAudioContext();
        context.onEnded(() => {
          this.setData({ audioConvertIsPlaying: false });
        });
        context.onError((err) => {
          console.error('Audio play error:', err);
          this.setData({ audioConvertIsPlaying: false });
          wx.showToast({
            title: "播放失败",
            icon: "none",
          });
        });
        this.setData({ audioConvertAudioContext: context });
      }

      context.src = current;
      context.play();
      this.setData({ audioConvertIsPlaying: true });
      return;
    }

    // 对于视频，优先尝试打开文档预览，兼容性更好
    try {
      if (this.data.audioConvertResultPath) {
        await new Promise((resolve, reject) => {
          wx.openDocument({
            filePath: this.data.audioConvertResultPath,
            fileType: 'mp4',
            success: resolve,
            fail: reject,
          });
        });
      } else {
        // 如果没有本地路径，直接告诉用户可以在播放器中播放
        wx.showToast({
          title: "可在上方播放器中播放",
          icon: "none",
          duration: 2000,
        });
      }
    } catch (e) {
      console.error('Open document failed:', e);
      // 如果 openDocument 失败，尝试 previewMedia
      if (wx.previewMedia && this.data.audioConvertResultRemoteUrl) {
        try {
          wx.previewMedia({
            sources: [{
              url: this.data.audioConvertResultRemoteUrl,
              type: "video",
            }],
          });
        } catch (previewErr) {
          console.error('Preview media failed:', previewErr);
          wx.showToast({
            title: "可在上方播放器中播放",
            icon: "none",
            duration: 2000,
          });
        }
      } else {
        wx.showToast({
          title: "可在上方播放器中播放",
          icon: "none",
          duration: 2000,
        });
      }
    }
  },

  async saveAudioConvertResult() {
    try {
      const filePath = await this.getAudioConvertResultFilePath();
      if (!filePath) {
        throw new Error("MEDIA_FILE_MISSING");
      }

      if (this.data.audioConvertResultKind === "video") {
        await new Promise((resolve, reject) => {
          wx.saveVideoToPhotosAlbum({
            filePath,
            success: resolve,
            fail: reject,
          });
        });
        wx.showToast({
          title: "已保存到相册",
          icon: "none",
        });
        return;
      }

      await new Promise((resolve, reject) => {
        wx.saveFile({
          tempFilePath: filePath,
          success: resolve,
          fail: reject,
        });
      });

      wx.showToast({
        title: "已保存到手机",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "保存失败，请重试",
        icon: "none",
      });
    }
  },

  copyAudioConvertResultLink() {
    if (!this.data.audioConvertResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.audioConvertResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  async previewPdfToWordResult() {
    // 优先使用本地缓存路径
    let filePath = this.data.pdfToWordResultPath;
    const url = this.data.pdfToWordResultRemoteUrl;

    if (!filePath && !url) {
      wx.showToast({
        title: "预览链接不存在",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "正在加载",
      mask: true,
    });

    try {
      // 如果没有本地路径，先下载
      if (!filePath && url) {
        console.log("[PDF转Word] 无本地缓存，正在下载:", url);
        const downloadRes = await new Promise((resolve, reject) => {
          wx.downloadFile({
            url: url,
            success: (res) => {
              if (res.statusCode === 200) {
                resolve(res);
              } else {
                reject(new Error(`下载失败: ${res.statusCode}`));
              }
            },
            fail: (err) => reject(err),
          });
        });
        filePath = downloadRes.tempFilePath;
        // 更新本地路径缓存
        this.setData({ pdfToWordResultPath: filePath });
      }

      // 打开文档
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: filePath,
          fileType: 'docx',
          showMenu: true,
          success: resolve,
          fail: reject,
        });
      });

      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      console.error("预览失败:", error);
      wx.showModal({
        title: "预览失败",
        content: "请检查网络连接或尝试复制链接在其他应用中打开",
        showCancel: false,
        confirmText: "知道了",
      });
    }
  },

  async downloadPdfToWordResult() {
    // 优先使用本地缓存路径
    let filePath = this.data.pdfToWordResultPath;
    const url = this.data.pdfToWordResultRemoteUrl;

    if (!filePath && !url) {
      wx.showToast({
        title: "下载链接不存在",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "正在打开",
      mask: true,
    });

    try {
      // 如果没有本地路径，先下载
      if (!filePath && url) {
        console.log("[PDF转Word] 无本地缓存，正在下载:", url);
        const downloadRes = await new Promise((resolve, reject) => {
          wx.downloadFile({
            url: url,
            success: (res) => {
              if (res.statusCode === 200) {
                resolve(res);
              } else {
                reject(new Error(`下载失败: ${res.statusCode}`));
              }
            },
            fail: (err) => reject(err),
          });
        });
        filePath = downloadRes.tempFilePath;
        // 更新本地路径缓存
        this.setData({ pdfToWordResultPath: filePath });
      }

      // 打开文档（用户可以在文档预览中选择保存）
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: filePath,
          fileType: 'docx',
          showMenu: true,
          success: resolve,
          fail: reject,
        });
      });

      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      console.error("打开失败:", error);
      wx.showModal({
        title: "打开失败",
        content: "请尝试复制链接在其他应用中打开",
        showCancel: false,
        confirmText: "知道了",
      });
    }
  },

  copyPdfToWordUrl() {
    if (!this.data.pdfToWordResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.pdfToWordResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  async previewPdfMergeResult() {
    // 优先使用本地缓存路径
    let filePath = this.data.pdfMergeResultPath;
    const url = this.data.pdfMergeResultRemoteUrl;

    if (!filePath && !url) {
      wx.showToast({
        title: "预览链接不存在",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "正在加载",
      mask: true,
    });

    try {
      // 如果没有本地路径，先下载
      if (!filePath && url) {
        console.log("[PDF合并] 无本地缓存，正在下载:", url);
        const downloadRes = await new Promise((resolve, reject) => {
          wx.downloadFile({
            url: url,
            success: (res) => {
              if (res.statusCode === 200) {
                resolve(res);
              } else {
                reject(new Error(`下载失败: ${res.statusCode}`));
              }
            },
            fail: (err) => reject(err),
          });
        });
        filePath = downloadRes.tempFilePath;
        // 更新本地路径缓存
        this.setData({ pdfMergeResultPath: filePath });
      }

      // 打开文档
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: filePath,
          fileType: 'pdf',
          showMenu: true,
          success: resolve,
          fail: reject,
        });
      });

      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      console.error("预览失败:", error);
      wx.showModal({
        title: "预览失败",
        content: "请检查网络连接或尝试复制链接在其他应用中打开",
        showCancel: false,
        confirmText: "知道了",
      });
    }
  },

  async downloadPdfMergeResult() {
    // 优先使用本地缓存路径
    let filePath = this.data.pdfMergeResultPath;
    const url = this.data.pdfMergeResultRemoteUrl;

    if (!filePath && !url) {
      wx.showToast({
        title: "下载链接不存在",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "正在打开",
      mask: true,
    });

    try {
      // 如果没有本地路径，先下载
      if (!filePath && url) {
        console.log("[PDF合并] 无本地缓存，正在下载:", url);
        const downloadRes = await new Promise((resolve, reject) => {
          wx.downloadFile({
            url: url,
            success: (res) => {
              if (res.statusCode === 200) {
                resolve(res);
              } else {
                reject(new Error(`下载失败: ${res.statusCode}`));
              }
            },
            fail: (err) => reject(err),
          });
        });
        filePath = downloadRes.tempFilePath;
        // 更新本地路径缓存
        this.setData({ pdfMergeResultPath: filePath });
      }

      // 打开文档（用户可以在文档预览中选择保存）
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: filePath,
          fileType: 'pdf',
          showMenu: true,
          success: resolve,
          fail: reject,
        });
      });

      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      console.error("打开失败:", error);
      wx.showModal({
        title: "打开失败",
        content: "请尝试复制链接在其他应用中打开",
        showCancel: false,
        confirmText: "知道了",
      });
    }
  },

  copyPdfMergeUrl() {
    if (!this.data.pdfMergeResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.pdfMergeResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  async uploadGeneratedOutput(filePath, options = {}) {
    if (!filePath || !hasBackendService()) {
      return null;
    }

    try {
      const fileInfo = await getFileInfo(filePath);
      return await uploadLocalFile({
        path: filePath,
        name: options.name || getFileName(filePath),
        size: fileInfo ? fileInfo.size : 0,
        extension: options.extension || getImageExtension(filePath),
        contentType: options.contentType,
      }, {
        folder: options.folder,
        contentType: options.contentType,
        extension: options.extension,
        baseName: options.baseName || "",
      });
    } catch (error) {
      logger.warn("[cloud-upload] generated output upload failed", {
        filePath,
        message: error && error.message,
      });
      return null;
    }
  },

  navigateWithCreatedTask(result) {
    if (!result.task) {
      wx.showToast({
        title: result.usage.costText,
        icon: "none",
      });
      return;
    }

    this.latestCreatedTaskId = result.task.id;
    this.setData({
      latestCreatedTaskId: result.task.id,
    });

    wx.showToast({
      title: "处理完成，结果已保存",
      icon: "none",
    });
  },

  openLatestTask() {
    const taskId = this.latestCreatedTaskId || this.data.latestCreatedTaskId;
    if (!taskId) {
      return;
    }

    wx.navigateTo({
      url: `/pages/task-detail/index?id=${taskId}`,
    });
  },

  async createRemoteDocumentTask(tool, selections, response, inputName, beforeBytes) {
    this.updateProcessingProgress(88, "正在保存结果...");
    const file = response.file || {};
    const remoteUrl = getPreferredRemoteFileUrl(file);
    const result = createTask(tool, selections, {
      instant: true,
      skipUsage: true,
      resultType: response.resultType || "document",
      inputName,
      outputName: file.name || tool.name,
      beforeBytes,
      afterBytes: file.sizeBytes || null,
      resultHeadline: response.headline,
      resultDetail: response.detail,
      outputPath: response.outputPath || "",
      remoteUrl,
      copyText: remoteUrl,
      metaLines: response.metaLines || [],
      attachments: (response.files || []).map((item) => ({
        name: item.name,
        label: item.label,
        url: getPreferredRemoteFileUrl(item),
        sizeBytes: item.sizeBytes,
      })),
    });

    this.navigateWithCreatedTask(result);
    this.updateProcessingProgress(100, "处理完成");
  },

  async runRemoteOcr() {
    const { tool, selections, imageInput } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "先选择一张图片",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(16, "正在读取图片...");
    const payload = {
      file: await packLocalFile({
        path: imageInput.path,
        name: getFileName(imageInput.path),
        size: imageInput.size,
      }),
      language: selections.language,
      layout: selections.layout,
    };

    const response = await this.requestJsonWithProgress("/api/ocr/image", payload, {
      target: 82,
      status: "正在识别文字...",
      sizeBytes: imageInput.size,
    });
    this.updateProcessingProgress(84, "正在整理文字...");
    const resultText = response.text || "";
    const resultLines = buildOcrLineItems(response.lines, resultText);
    const result = createTask(tool, selections, {
      instant: true,
      skipUsage: true,
      resultType: "text",
      inputName: getFileName(imageInput.path),
      outputName: "OCR 文本结果",
      beforeBytes: imageInput.size,
      resultHeadline: response.headline,
      resultDetail: response.detail,
      resultText: response.text,
      copyText: response.text,
      metaLines: response.metaLines || [],
    });

    if (result.task) {
      this.latestCreatedTaskId = result.task.id;
    }

    this.setData({
      latestCreatedTaskId: result.task ? result.task.id : this.data.latestCreatedTaskId,
      ocrResultReady: true,
      ocrResultText: resultText,
      ocrResultLines: resultLines,
      ocrResultHeadline: response.headline || "文字识别已完成",
      ocrResultDetail: response.detail || `识别 ${resultText.length} 个字符`,
      ocrResultProviderText: response.provider === "baidu" ? "百度 OCR" : "Tesseract",
    });

    wx.showToast({
      title: "识别完成",
      icon: "none",
    });
    this.updateProcessingProgress(100, "识别完成");
  },

  copyOcrLine(event) {
    const text = event.currentTarget.dataset.text || "";
    if (!text) {
      return;
    }

    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({
          title: "已复制",
          icon: "none",
        });
      },
    });
  },

  copyOcrAll() {
    if (!this.data.ocrResultText) {
      return;
    }

    wx.setClipboardData({
      data: this.data.ocrResultText,
      success: () => {
        wx.showToast({
          title: "已复制全部文字",
          icon: "none",
        });
      },
    });
  },

  updateProcessingProgress(progress, status, options = {}) {
    const nextProgress = Math.min(100, Math.max(0, Math.round(progress)));
    const currentDisplay = Number(this.data.processingDisplayProgress || 0);
    this.setData({
      processingProgress: nextProgress,
      processingStatus: status || "",
      processingEstimateFrom: currentDisplay,
      processingEstimateTo: nextProgress,
      processingEstimateStartedAt: Date.now(),
      processingEstimateDurationMs: Math.max(0, Number(options.durationMs || 0)),
    });
    this.startProcessingProgressTicker();
  },

  updateProcessingDisplayProgress(progress, status) {
    const nextProgress = Math.min(100, Math.max(0, Math.round(progress)));
    this.setData({
      processingProgress: nextProgress,
      processingDisplayProgress: nextProgress,
      processingDisplayProgressText: nextProgress,
      processingStatus: status || this.data.processingStatus,
      processingEstimateFrom: nextProgress,
      processingEstimateTo: nextProgress,
      processingEstimateStartedAt: Date.now(),
      processingEstimateDurationMs: 0,
    });
    this.startProcessingProgressTicker();
  },

  async requestJsonWithProgress(pathname, data, options = {}) {
    const target = options.target || 86;
    const status = options.status || "正在处理...";
    const durationMs = options.durationMs || estimateRemoteDurationMs(
      this.data.tool ? this.data.tool.id : "",
      options.sizeBytes || 0
    );

    this.updateProcessingProgress(target, status, { durationMs });
    const response = await requestJson(pathname, data, options.requestOptions || {});
    this.updateProcessingDisplayProgress(target, status);
    return response;
  },

  startProcessingProgressTicker() {
    if (this.processingProgressTimer) {
      return;
    }

    this.processingProgressTimer = setInterval(() => {
      if (!this.data.showProcessingOverlay) {
        this.stopProcessingProgressTicker();
        return;
      }

      const target = Math.min(100, Math.max(0, this.data.processingProgress || 0));
      const current = Number(this.data.processingDisplayProgress || 0);
      const durationMs = Number(this.data.processingEstimateDurationMs || 0);
      let next = current;

      if (target >= 100) {
        next = Math.min(100, current + Math.max(2, Math.ceil((100 - current) * 0.35)));
      } else if (durationMs > 0) {
        const from = Number(this.data.processingEstimateFrom || current);
        const to = Number(this.data.processingEstimateTo || target);
        const elapsed = Date.now() - Number(this.data.processingEstimateStartedAt || Date.now());
        const ratio = Math.min(0.98, Math.max(0, elapsed / durationMs));
        next = Math.max(current, from + (to - from) * ratio);
      } else if (current < target) {
        next = Math.min(target, current + Math.max(1, Math.ceil((target - current) * 0.28)));
      }

      const rounded = Math.min(100, Math.round(next));
      if (Math.abs(next - current) >= 0.1 || rounded !== this.data.processingDisplayProgressText) {
        this.setData({
          processingDisplayProgress: next,
          processingDisplayProgressText: rounded,
        });
      }
    }, 180);
  },

  stopProcessingProgressTicker() {
    if (this.processingProgressTimer) {
      clearInterval(this.processingProgressTimer);
      this.processingProgressTimer = null;
    }
  },

  async runRemotePhotoId() {
    const { tool, selections, imageInput } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "请先选择一张图片",
        icon: "none",
      });
      return;
    }
    
    // 设置整体 5 分钟超时，防止无限卡住
    let isTimeout = false;
    const timeoutId = setTimeout(() => {
      isTimeout = true;
      logger.error("[照片转证件照] 请求超时");
      this.setData({
        isWorking: false,
        photoIdIsProcessing: false,
        showProcessingOverlay: false,
        processingProgress: 0,
        processingStatus: "",
      });
      wx.showModal({
        title: "处理超时",
        content: "处理时间过长，请稍后重试",
        showCancel: false,
      });
    }, 300000);

    try {
      this.updateProcessingProgress(5, "正在准备图片...");
      logger.log("[照片转证件照] 开始处理照片");

      wx.getNetworkType({
        success: function(res) {
          logger.log("[照片转证件照] 网络状态", res.networkType);
        }
      });

      logger.log("[照片转证件照] 构建请求参数:", {
        size: selections.size,
        background: selections.background,
        retouch: selections.retouch,
        imagePath: imageInput.path,
        imageSize: imageInput.size
      });

      this.updateProcessingProgress(15, "正在上传图片...");
      logger.log("[照片转证件照] 开始打包文件");
      
      let packedFile;
      try {
        packedFile = await packLocalFile({
          path: imageInput.path,
          name: getFileName(imageInput.path),
          size: imageInput.size,
        });
        logger.log("[照片转证件照] 文件打包完成，base64 长度:", packedFile.base64?.length || 0);
      } catch (packError) {
        logger.error("[照片转证件照] 文件打包失败:", packError.message, packError);
        throw new Error(`文件打包失败：${packError.message}`);
      }
      
      if (isTimeout) {
        logger.log("[照片转证件照] 已超时，中断处理");
        return;
      }

      logger.log("[照片转证件照] 发送请求到 /api/photo-id");
      let remoteResponse;
      try {
        remoteResponse = await this.requestJsonWithProgress("/api/photo-id", {
          file: packedFile,
          size: selections.size,
          background: selections.background,
          retouch: selections.retouch,
        }, {
          target: 74,
          status: "正在智能抠图...",
          sizeBytes: imageInput.size,
          requestOptions: {
            timeout: 120000, // 减少到 2 分钟
            includeMeta: true,
          },
        });
        logger.log("[照片转证件照] 收到原始响应:", remoteResponse);
      } catch (requestError) {
        logger.error("[照片转证件照] 请求失败:", requestError.message, requestError);
        throw new Error(`请求失败：${requestError.message}`);
      }
      
      const response = remoteResponse && remoteResponse.data ? remoteResponse.data : remoteResponse;

      this.updateProcessingProgress(75, "正在生成证件照...");

      logger.log("[照片转证件照] 收到响应:", response);

      // 检查响应格式
      if (!response) {
        logger.log("[照片转证件照] 收到空响应");
        throw new Error("空响应");
      }
      
      if (!response.ok) {
        logger.log("[照片转证件照] 响应不是 ok:", response);
        throw new Error(response.errorMessage || response.detail || "处理失败");
      }

      // 处理响应数据
      const file = response.file || {};
      logger.log("[照片转证件照] 响应文件数据:", file);

      let outputPath = "";
      let previewPath = "";
      if (file.inlineBase64) {
        try {
          logger.log("[照片转证件照] 开始写入 base64 文件，长度:", file.inlineBase64.length);
          outputPath = await writeBase64File(
            `${wx.env.USER_DATA_PATH}/photo-id-result-${Date.now()}.png`,
            file.inlineBase64
          );
          previewPath = outputPath;
          logger.log("[照片转证件照] 已写入本地预览文件", outputPath);
        } catch (error) {
          logger.error("[照片转证件照] 写入本地预览失败:", error.message, error);
        }
      } else {
        logger.log("[照片转证件照] 没有 inlineBase64 数据");
      }
      const shouldDownloadPreviewEagerly = false;

      if (shouldDownloadPreviewEagerly && file.url) {
        try {
          logger.log("[照片转证件照] 开始下载文件", file.url);
          const download = await downloadRemoteFile(file.url);
          logger.log("[照片转证件照] 下载完成:", {
            statusCode: download.statusCode,
            tempFilePath: download.tempFilePath
          });
          if (download.statusCode >= 200 && download.statusCode < 300) {
            outputPath = download.tempFilePath || "";
            previewPath = download.tempFilePath || previewPath;
            logger.log("[照片转证件照] 下载成功，文件路径", outputPath);
          } else {
            logger.log("[照片转证件照] 下载失败，状态码:", download.statusCode);
          }
        } catch (error) {
          logger.error("[照片转证件照] 下载异常:", error.message);
          // Fall back to remote preview/link only.
        }
      }

      if (!file.url) {
        logger.log("[照片转证件照] 响应中没有文件URL");
      }

      this.updateProcessingProgress(90, "正在保存结果...");

      const nextState = {
        isWorking: false,
        photoIdIsProcessing: false,
        photoIdResultReady: true,
        photoIdResultPath: outputPath || previewPath,
        photoIdResultRemoteUrl: file.url || "",
        photoIdResultName: file.name || `证件照_${selections.background}.png`,
        photoIdResultHeadline: response.headline || "证件照生成成功",
        photoIdResultDetail: response.detail || "已完成证件照的处理，可预览或保存到相册。",
        photoIdResultMetaLines: response.metaLines || [],
        showProcessingOverlay: false,
        processingProgress: 100,
        processingStatus: "处理完成",
      };

      const taskResult = createTask(tool, selections, {
        instant: true,
        skipUsage: true,
        resultType: "image",
        inputName: getFileName(imageInput.path),
        outputName: file.name || `证件照_${selections.background || "背景"}.png`,
        beforeBytes: imageInput.size,
        afterBytes: file.sizeBytes || null,
        resultHeadline: response.headline || "证件照已生成",
        resultDetail: response.detail || "已完成证件照处理，可预览或保存到相册。",
        outputPath: outputPath || "",
        remoteUrl: file.url || "",
        previewPath: previewPath || outputPath || "",
        copyText: file.url || "",
        metaLines: response.metaLines || [],
      });

      if (taskResult.task) {
        this.latestCreatedTaskId = taskResult.task.id;
        nextState.latestCreatedTaskId = taskResult.task.id;
        nextState.relatedTasks = this.getRelatedTasks(tool.id);
        // 增加证件照使用次数
        const stats = incrementPhotoIdUsage();
        nextState.totalUsageCount = stats.totalUsageCount;
      }

      persistPhotoIdSession({
        ...this.data,
        ...nextState,
      });

      logger.log("[照片转证件照] 准备更新状态", nextState);

      // 更新状态
      this.setData(nextState);
      logger.log("[照片转证件照] 状态更新完成");

      // 显示处理完成提示
      wx.showToast({
        title: "处理完成",
        icon: "none",
        duration: 2000
      });
      logger.log("[照片转证件照] 显示处理完成提示");
    } catch (error) {
      logger.error("[照片转证件照] 处理失败:", error.message, error);
      this.setData({
        isWorking: false,
        photoIdIsProcessing: false,
        showProcessingOverlay: false,
        processingProgress: 0,
        processingStatus: "",
      });
      wx.showToast({
        title: error.message || "处理失败，请稍后重试",
        icon: "none",
        duration: 3000
      });
    } finally {
      clearTimeout(timeoutId);
      logger.log("[照片转证件照] 处理流程结束");
    }
  },

  getClearedPhotoIdResult() {
    return {
      photoIdResultReady: false,
      photoIdResultPath: "",
      photoIdResultRemoteUrl: "",
      photoIdResultName: "",
      photoIdResultHeadline: "",
      photoIdResultDetail: "",
      photoIdResultMetaLines: [],
      photoIdIsProcessing: false,
    };
  },

  async checkPhotoCompliance(imageInput) {
    logger.log("[合规性检查] 开始检查图片", imageInput.path);

    const result = {
      passed: true,
      message: "",
    };

    try {
      const { width, height, size } = imageInput;

      if (!width || !height) {
        result.passed = false;
        result.message = "无法获取图片尺寸信息，请重新选择图片。";
        return result;
      }

      if (width < 300 || height < 300) {
        result.passed = false;
        result.message = `图片尺寸过小（${width}x${height}），请上传至少 300x300 像素的图片。`;
        return result;
      }

      if (width > 4096 || height > 4096) {
        result.passed = false;
        result.message = `图片尺寸过大（${width}x${height}），请上传不超过 4096x4096 像素的图片。`;
        return result;
      }

      const aspectRatio = width / height;
      if (aspectRatio < 0.3 || aspectRatio > 3) {
        result.passed = false;
        result.message = "图片比例异常（过于细长或扁平），请选择正常比例的照片。";
        return result;
      }

      if (size && size > 20 * 1024 * 1024) {
        result.passed = false;
        result.message = `图片文件过大（${formatFileSize(size)}），请上传不超过 20MB 的图片。`;
        return result;
      }

      logger.log("[合规性检查] 基础检查通过，尺寸", width, "x", height, "比例:", aspectRatio.toFixed(2));

    } catch (error) {
      logger.error("[合规性检查] 检查过程出错", error);
      result.passed = false;
      result.message = "图片检查过程出错，请重新选择图片。";
    }

    return result;
  },

  previewPhotoIdResult() {
    const current = this.data.photoIdResultPath || this.data.photoIdResultRemoteUrl;
    if (!current) {
      return;
    }

    wx.previewImage({
      current,
      urls: [current],
    });
  },

  async savePhotoIdResult() {
    let filePath = this.data.photoIdResultPath;

    try {
      if (!filePath && this.data.photoIdResultRemoteUrl) {
        const download = await downloadRemoteFile(this.data.photoIdResultRemoteUrl);
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("PHOTO_ID_FILE_MISSING");
      }

      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject,
        });
      });

      wx.showToast({
        title: "已保存到相册",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "保存失败，请检查相册权限",
        icon: "none",
      });
    }
  },

  copyPhotoIdLink() {
    if (!this.data.photoIdResultRemoteUrl) {
      return;
    }

    wx.setClipboardData({
      data: this.data.photoIdResultRemoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  async runRemotePdfMerge() {
    const { tool, selections, backendFiles } = this.data;
    if (backendFiles.length < 2) {
      wx.showToast({
        title: "至少选择 2 份 PDF",
        icon: "none",
      });
      return;
    }

    try {
      this.updateProcessingProgress(18, "正在读取 PDF...");
      const files = [];
      for (let index = 0; index < backendFiles.length; index += 1) {
        files.push(await packLocalFile(backendFiles[index]));
        this.updateProcessingProgress(18 + Math.round(((index + 1) / backendFiles.length) * 24), "正在读取 PDF...");
      }

      const beforeBytes = backendFiles.reduce((sum, file) => sum + (file.size || 0), 0);
      const response = await this.requestJsonWithProgress("/api/pdf/merge", { files }, {
        target: 80,
        status: "正在合并 PDF...",
        sizeBytes: beforeBytes,
      });

      this.updateProcessingProgress(82, "正在保存结果...");
      
      // 创建任务记录
      await this.createRemoteDocumentTask(tool, selections, response, `${backendFiles.length} 份 PDF`, beforeBytes);

      const fileResponse = response.file || {};
      const remoteUrl = fileResponse.downloadUrl || fileResponse.url || fileResponse.fallbackUrl || fileResponse.externalUrl || "";
      let localPath = "";

      // 如果有远程URL，先下载到本地
      if (remoteUrl) {
        try {
          console.log("[PDF合并] 正在下载文件:", remoteUrl);
          const downloadRes = await new Promise((resolve, reject) => {
            wx.downloadFile({
              url: remoteUrl,
              success: (res) => {
                if (res.statusCode === 200) {
                  resolve(res);
                } else {
                  reject(new Error(`下载失败: ${res.statusCode}`));
                }
              },
              fail: (err) => reject(err),
            });
          });
          localPath = downloadRes.tempFilePath;
          console.log("[PDF合并] 文件已下载:", localPath);
        } catch (downloadError) {
          console.warn("[PDF合并] 下载文件失败，仅保留远程链接:", downloadError);
        }
      }

      // 生成文件名
      const fileName = "合并结果.pdf";

      const afterBytes = fileResponse.sizeBytes || null;

      this.setData({
        pdfMergeResultReady: true,
        pdfMergeResultPath: localPath,
        pdfMergeResultRemoteUrl: remoteUrl,
        pdfMergeResultName: fileName,
        pdfMergeResultHeadline: response.headline || "PDF 合并已完成",
        pdfMergeResultDetail: response.detail || "",
        pdfMergeResultMetaLines: response.metaLines || [],
      });

      this.updateProcessingProgress(100, "合并完成");
    } catch (error) {
      console.error("PDF合并失败:", error);
      wx.showToast({
        title: "合并失败，请重试",
        icon: "none",
      });
    }
  },

  async runRemotePdfSplit() {
    const { tool, selections, backendFiles, pageRange } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "先选择一份 PDF",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(24, "正在读取 PDF...");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/pdf/split", {
      file,
      splitMode: selections.splitMode,
      pageRange,
    }, {
      target: 84,
      status: "正在拆分 PDF...",
      sizeBytes: backendFiles[0].size,
    });

    await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);
  },

  async runRemotePdfCompress() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "先选择一份 PDF",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(24, "正在读取 PDF...");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/pdf/compress", {
      file,
      mode: selections.mode,
    }, {
      target: 84,
      status: "正在压缩 PDF...",
      sizeBytes: backendFiles[0].size,
    });

    await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);
  },

  async runRemoteOfficeToPdf() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "先选择一份 Office 文件",
        icon: "none",
      });
      return;
    }

    try {
      this.updateProcessingProgress(24, "正在读取文档...");
      const file = await packLocalFile(backendFiles[0]);
      const response = await this.requestJsonWithProgress("/api/office/to-pdf", {
        file,
        quality: selections.quality,
        pageMode: selections.pageMode,
      }, {
        target: 84,
        status: "正在转换 PDF...",
        sizeBytes: backendFiles[0].size,
      });

      await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);
    } catch (error) {
      console.error("[Office转PDF] 失败:", error);
      this.setData({
        isWorking: false,
        showProcessingOverlay: false,
      });

      let errorMsg = "转换失败，请重试";
      if (error && error.message) {
        if (error.message.includes("OFFICE_CONVERTER_UNAVAILABLE") || error.message.includes("LibreOffice")) {
          errorMsg = "当前服务暂不支持 Office 转 PDF，请联系管理员";
        }
      }

      wx.showToast({
        title: errorMsg,
        icon: "none",
        duration: 2500,
      });
    }
  },

  async runRemotePdfToWord() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "先选择一份 PDF 文件",
        icon: "none",
      });
      return;
    }

    try {
      this.updateProcessingProgress(22, "正在读取 PDF...");
      const file = await packLocalFile(backendFiles[0]);
      const response = await this.requestJsonWithProgress("/api/pdf/to-word", {
        file,
        format: selections.format,
        layout: selections.layout,
      }, {
        target: 80,
        status: "正在转换 Word...",
        sizeBytes: backendFiles[0].size,
      });

      this.updateProcessingProgress(82, "正在保存结果...");
      const taskResult = await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);

      const fileResponse = response.file || {};
      const remoteUrl = fileResponse.downloadUrl || fileResponse.url || fileResponse.fallbackUrl || fileResponse.externalUrl || "";
      let localPath = "";

      // 如果有远程URL，先下载到本地
      if (remoteUrl) {
        try {
          console.log("[PDF转Word] 正在下载文件:", remoteUrl);
          const downloadRes = await new Promise((resolve, reject) => {
            wx.downloadFile({
              url: remoteUrl,
              success: (res) => {
                if (res.statusCode === 200) {
                  resolve(res);
                } else {
                  reject(new Error(`下载失败: ${res.statusCode}`));
                }
              },
              fail: (err) => reject(err),
            });
          });
          localPath = downloadRes.tempFilePath;
          console.log("[PDF转Word] 文件已下载:", localPath);
        } catch (downloadError) {
          console.warn("[PDF转Word] 下载文件失败，仅保留远程链接:", downloadError);
        }
      }

      // 使用原文件名，替换扩展名为 .docx
      const originalName = backendFiles[0].name || "文档";
      const baseName = originalName.replace(/\.pdf$/i, "");
      const fileName = `${baseName}.docx`;

      const afterBytes = fileResponse.sizeBytes || null;
      const beforeBytes = backendFiles[0].size || 0;

      this.setData({
        pdfToWordResultReady: true,
        pdfToWordResultPath: localPath,
        pdfToWordResultRemoteUrl: remoteUrl,
        pdfToWordResultName: fileName,
        pdfToWordResultHeadline: response.headline || "PDF 转 Word 已完成",
        pdfToWordResultDetail: response.detail || "",
        pdfToWordResultMetaLines: response.metaLines || [],
      });

      this.updateProcessingProgress(100, "转换完成");
    } catch (error) {
      console.error("PDF转Word失败:", error);
      wx.showToast({
        title: "转换失败，请重试",
        icon: "none",
      });
    }
  },

  async runRemoteAudioConvert() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "先选择一个音视频文件",
        icon: "none",
      });
      return;
    }

    const fileName = backendFiles[0].name || "media.mp4";
    const ext = getFileExtension(fileName);
    const inputKind = getAudioConvertInputKind(fileName);
    const targetOptions = getAudioConvertTargetOptions(inputKind);
    const target = selections.target || targetOptions[0] || "";
    const supportedExts = AUDIO_CONVERT_AUDIO_EXTS.concat(AUDIO_CONVERT_VIDEO_EXTS);
    const unsupportedExts = ["kgm", "vpr", "mgg", "qmc", "kwm", "xm", "tm", "bkcmp3", "bkcflac", "tkm"];

    if (unsupportedExts.includes(ext)) {
      wx.showModal({
        title: "不支持此格式",
        content: `.${ext} 是加密音乐格式，无法直接转换。\n建议：先在原音乐 APP 中导出为 MP3 等普通格式。`,
        showCancel: false,
        confirmText: "知道了",
      });
      return;
    }

    if (!supportedExts.includes(ext)) {
      const proceed = await new Promise((resolve) => {
        wx.showModal({
          title: "格式可能不支持",
          content: `.${ext} 格式可能无法正常转换。\n确定继续吗？`,
          confirmText: "继续",
          success: (res) => resolve(res.confirm),
        });
      });
      if (!proceed) {
        return;
      }
    }

    if (!target || !targetOptions.includes(target)) {
      wx.showToast({
        title: "请先选择目标格式",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(22, "正在读取音视频...");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/audio/convert", {
      file,
      target,
      quality: selections.quality,
    }, {
      target: 84,
      status: "正在转换音视频...",
      sizeBytes: backendFiles[0].size,
    });

    this.updateProcessingProgress(88, "正在保存结果...");
    const fileResponse = response.file || {};
    const outputName = fileResponse.name || `${fileName.replace(/\.[^.]+$/, "")}.${target.toLowerCase()}`;
    const remoteUrl = fileResponse.downloadUrl || fileResponse.url || fileResponse.fallbackUrl || fileResponse.externalUrl || "";
    const resultKind = getAudioConvertResultKind(outputName, target);
    const finalSelections = {
      ...selections,
      target,
    };
    const result = createTask(tool, finalSelections, {
      instant: true,
      skipUsage: true,
      resultType: "document",
      inputName: backendFiles[0].name,
      outputName,
      beforeBytes: backendFiles[0].size,
      afterBytes: fileResponse.sizeBytes || null,
      resultHeadline: response.headline,
      resultDetail: response.detail,
      remoteUrl,
      previewPath: "",
      copyText: remoteUrl,
      metaLines: response.metaLines || [],
    });

    if (this.data.audioConvertAudioContext) {
      this.data.audioConvertAudioContext.stop();
    }

    this.latestCreatedTaskId = result.task ? result.task.id : this.latestCreatedTaskId;
    this.setData({
      latestCreatedTaskId: result.task ? result.task.id : this.data.latestCreatedTaskId,
      relatedTasks: this.getRelatedTasks(tool.id),
      selections: finalSelections,
      audioConvertResultReady: true,
      audioConvertResultPath: "",
      audioConvertResultRemoteUrl: remoteUrl,
      audioConvertResultName: outputName,
      audioConvertResultHeadline: response.headline || "音视频格式转换已完成",
      audioConvertResultDetail: response.detail || `已转换为 ${target} 格式，可预览或保存。`,
      audioConvertResultMetaLines: response.metaLines || [],
      audioConvertResultKind: resultKind,
      audioConvertIsPlaying: false,
    });
  },

  async runImageCompress() {
    const { imageInput, selections } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "先选择一张图片",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(18, "正在分析图片尺寸...");

    const scaleMap = {
      "清晰优先": 1,
      "均衡": 0.82,
      "体积优先": 0.65,
    };

    const qualityMap = {
      "清晰优先": 0.9,
      "均衡": 0.76,
      "体积优先": 0.56,
    };
    const scale = scaleMap[selections.mode] || 0.82;
    const quality = qualityMap[selections.mode] || 0.76;

    const exportFormat = selections.output === "PNG"
      ? "png"
      : selections.output === "JPG"
        ? "jpg"
        : imageInput.extension === "png"
          ? "png"
          : "jpg";

    const width = Math.max(200, Math.round(imageInput.width * scale));
    const height = Math.max(200, Math.round(imageInput.height * scale));

    this.updateProcessingProgress(42, "正在压缩图片...");
    const tempFile = await this.withCanvas(width, height, (ctx) => {
      ctx.drawImage(imageInput.path, 0, 0, width, height);
    }, {
      fileType: exportFormat,
      quality: exportFormat === "jpg" ? quality : 1,
    });

    this.updateProcessingProgress(72, "正在统计压缩结果...");
    const fileInfo = await getFileInfo(tempFile.tempFilePath);
    const afterBytes = fileInfo ? fileInfo.size : null;
    const savedBytes = afterBytes === null ? null : Math.max(imageInput.size - afterBytes, 0);
    const savedPercent = imageInput.size && savedBytes !== null
      ? Math.round((savedBytes / imageInput.size) * 100)
      : 0;

    this.updateProcessingProgress(88, "正在保存结果...");
    const taskResult = await this.createImageTask({
      inputName: "原图",
      outputName: `压缩结果.${exportFormat}`,
      sourcePath: imageInput.path,
      outputPath: tempFile.tempFilePath,
      beforeBytes: imageInput.size,
      afterBytes,
      resultHeadline: "图片压缩已完成",
      resultDetail: `已按“${selections.mode}”导出 ${exportFormat.toUpperCase()} 文件，可直接保存或继续发送。`,
      metaLines: [
        `原图尺寸 ${imageInput.width} × ${imageInput.height}`,
        `结果尺寸 ${width} × ${height}`,
      ],
    });

    this.updateProcessingProgress(100, "压缩完成");

    const beforeSizeText = formatFileSize(imageInput.size);
    const afterSizeText = formatFileSize(afterBytes);
    const savedSizeText = savedBytes === null
      ? ""
      : `${formatFileSize(savedBytes)}${savedPercent > 0 ? ` · ${savedPercent}%` : ""}`;

    this.setData({
      compressResultReady: true,
      compressResultPath: tempFile.tempFilePath,
      compressResultRemoteUrl: taskResult && taskResult.remoteFile ? taskResult.remoteFile.url : "",
      compressResultName: `压缩结果.${exportFormat}`,
      compressResultHeadline: `${beforeSizeText} -> ${afterSizeText}`,
      compressResultDetail: savedSizeText
        ? `节省 ${savedSizeText}`
        : "",
      compressResultBeforeSizeText: beforeSizeText,
      compressResultAfterSizeText: afterSizeText,
      compressResultSavedText: savedSizeText || "--",
      compressResultMetaLines: [
        `原图尺寸 ${imageInput.width} × ${imageInput.height}`,
        `结果尺寸 ${width} × ${height}`,
        `导出格式 ${exportFormat.toUpperCase()}`,
        `压缩策略 ${selections.mode}`,
      ],
    });
  },

  async runImageConvert() {
    const { imageInput, selections } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "先选择一张图片",
        icon: "none",
      });
      return;
    }

    const qualityMap = {
      "标准": 0.82,
      "高清": 0.92,
      "网页优化": 0.68,
    };

    const exportFormat = selections.target.toLowerCase();
    this.updateProcessingProgress(18, "正在读取图片...");

    // 如果是相同格式，提示用户
    if (imageInput.extension && imageInput.extension.toLowerCase() === exportFormat) {
      wx.showModal({
        title: "提示",
        content: "原图格式已是目标格式，是否继续？",
        confirmText: "继续",
        success: (res) => {
          if (!res.confirm) return;
        }
      });
    }

    // 使用 canvas 绘制，保持图片原样
    const tempFile = await this.withCanvas(imageInput.width, imageInput.height, (ctx) => {
      // 对于 JPG 导出，填充白色背景保持原样，否则透明背景
      if (exportFormat === "jpg") {
        setFillStyle(ctx, "#ffffff");
        ctx.fillRect(0, 0, imageInput.width, imageInput.height);
      }
      // 不做任何尺寸或色彩调整，直接原样绘制
      ctx.drawImage(imageInput.path, 0, 0, imageInput.width, imageInput.height);
    }, {
      fileType: exportFormat,
      quality: exportFormat === "jpg" ? qualityMap[selections.quality] : 1, // PNG 等格式使用 1（最高质量）
    });

    this.updateProcessingProgress(62, "正在导出图片...");
    const fileInfo = await getFileInfo(tempFile.tempFilePath);
    const afterBytes = fileInfo ? fileInfo.size : null;

    this.updateProcessingProgress(82, "正在保存结果...");
    const taskResult = await this.createImageTask({
      inputName: "原图",
      outputName: `格式转换结果.${exportFormat}`,
      sourcePath: imageInput.path,
      outputPath: tempFile.tempFilePath,
      beforeBytes: imageInput.size,
      afterBytes,
      resultHeadline: "图片格式转换已完成",
      resultDetail: `已输出 ${selections.target} 文件，适合直接保存或用于下一步处理。`,
      metaLines: [
        `原图尺寸 ${imageInput.width} × ${imageInput.height}`,
        `目标格式 ${selections.target}`,
      ],
    });

    const fromFormat = (imageInput.extension || "未知").toUpperCase();
    const toFormat = selections.target;
    const beforeSizeText = formatFileSize(imageInput.size);
    const afterSizeText = formatFileSize(afterBytes);

    this.setData({
      convertResultReady: true,
      convertResultPath: tempFile.tempFilePath,
      convertResultRemoteUrl: taskResult && taskResult.remoteFile ? taskResult.remoteFile.url : "",
      convertResultName: `格式转换结果.${exportFormat}`,
      convertResultHeadline: `${fromFormat} -> ${toFormat}`,
      convertResultDetail: `${beforeSizeText} -> ${afterSizeText}`,
      convertResultFromFormat: fromFormat,
      convertResultToFormat: toFormat,
      convertResultMetaLines: [
        `原图尺寸 ${imageInput.width} × ${imageInput.height}`,
        `输出质量 ${selections.quality}`,
        `已保持图片原样导出`,
      ],
    });
    this.updateProcessingProgress(100, "转换完成");
  },

  getResizeTargetSize() {
    const { selections, imageInput, customWidth, customHeight } = this.data;

    if (selections.size === "\u81ea\u5b9a\u4e49") {
      return {
        width: clampDimension(customWidth, imageInput ? imageInput.width : 1600),
        height: clampDimension(customHeight, imageInput ? imageInput.height : 900),
      };
    }

    const sizeMap = {
      "\u4e00\u5bf8": { width: 295, height: 413 },
      "\u5c0f\u4e00\u5bf8": { width: 260, height: 378 },
      "\u4e8c\u5bf8": { width: 413, height: 579 },
      "\u5c0f\u4e8c\u5bf8": { width: 354, height: 472 },
    };
    if (sizeMap[selections.size]) {
      return sizeMap[selections.size];
    }

    const ratioMap = {
      "1:1": 1,
      "4:3": 4 / 3,
      "16:9": 16 / 9,
    };

    const ratio = ratioMap[selections.size] || 1;
    const width = ratio >= 1 ? 1600 : 1200;

    return {
      width,
      height: Math.round(width / ratio),
    };
  },

  getDrawLayout(targetWidth, targetHeight, fitMode) {
    const { imageInput } = this.data;
    const sourceWidth = imageInput.width;
    const sourceHeight = imageInput.height;
    const scale = fitMode === "居中裁剪"
      ? Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
      : Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);

    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;

    return {
      drawWidth,
      drawHeight,
      x: Math.round((targetWidth - drawWidth) / 2),
      y: Math.round((targetHeight - drawHeight) / 2),
    };
  },

  async runImageResize() {
    const { imageInput, selections } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "先选择一张图片",
        icon: "none",
      });
      return;
    }

    const target = this.getResizeTargetSize();
    const layout = this.getDrawLayout(target.width, target.height, selections.fit);
    const exportFormat = imageInput.extension === "png" ? "png" : "jpg";
    const background = selections.fit === "智能留白" ? "#f4efe6" : "#ffffff";

    this.updateProcessingProgress(16, "正在计算尺寸...");

    try {
      this.updateProcessingProgress(38, "正在绘制图片...");
      const tempFile = await this.withCanvas(target.width, target.height, (ctx) => {
        setFillStyle(ctx, background);
        ctx.fillRect(0, 0, target.width, target.height);
        ctx.drawImage(imageInput.path, layout.x, layout.y, layout.drawWidth, layout.drawHeight);
      }, {
        fileType: exportFormat,
        quality: exportFormat === "jpg" ? 0.88 : 1,
      });

      this.updateProcessingProgress(66, "正在导出图片...");
      const fileInfo = await getFileInfo(tempFile.tempFilePath);

      this.setData({
        resizeResultReady: true,
        resizeResultPath: tempFile.tempFilePath,
        resizeResultName: `改尺寸结果.${exportFormat}`,
        resizeResultHeadline: "图片尺寸调整已完成",
        resizeResultDetail: `已按 ${selections.size} 和“${selections.fit}”导出，可继续用于海报、社媒或商品图。`,
        resizeResultMetaLines: [
          `目标尺寸 ${target.width} × ${target.height}`,
          `适配方式 ${selections.fit}`,
        ],
        resizeBeforeWidth: imageInput.width,
        resizeBeforeHeight: imageInput.height,
        resizeAfterWidth: target.width,
        resizeAfterHeight: target.height,
      });

      this.updateProcessingProgress(84, "正在保存结果...");
      const taskResult = await this.createImageTask({
        inputName: "原图",
        outputName: `改尺寸结果.${exportFormat}`,
        sourcePath: imageInput.path,
        outputPath: tempFile.tempFilePath,
        beforeBytes: imageInput.size,
        afterBytes: fileInfo ? fileInfo.size : null,
        resultHeadline: "图片尺寸调整已完成",
        resultDetail: `已按 ${selections.size} 和“${selections.fit}”导出，可继续用于海报、社媒或商品图。`,
        metaLines: [
          `目标尺寸 ${target.width} × ${target.height}`,
          `适配方式 ${selections.fit}`,
        ],
      }, { skipToast: true });

      if (taskResult.remoteFile) {
        this.setData({
          resizeResultRemoteUrl: taskResult.remoteFile.url,
        });
      }
      this.updateProcessingProgress(100, "调整完成");

    } catch (error) {
      this.setData({
        isWorking: false,
        showProcessingOverlay: false,
      });
      wx.showToast({
        title: "处理失败，请重试",
        icon: "none",
      });
    }
  },

  // 万能压缩处理
  async runUniversalCompress() {
    const { tool, selections, imageInput, backendFiles } = this.data;

    // 检查文件输入
    let inputFile = null;
    let fileType = "";
    let fileName = "";
    let beforeBytes = 0;

    // 优先检查图片输入
    if (imageInput) {
      inputFile = imageInput;
      fileType = "image";
      fileName = imageInput.path.split('/').pop() || "image.jpg";
      beforeBytes = imageInput.size || 0;
    }
    // 其次检查后端文件输入
    else if (backendFiles.length > 0) {
      inputFile = backendFiles[0];
      fileName = inputFile.name || "file";
      beforeBytes = inputFile.size || 0;

      // 根据扩展名判断文件类型
      const ext = (fileName.split('.').pop() || "").toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "bmp", "gif"].includes(ext)) {
        fileType = "image";
      } else if (ext === "pdf") {
        fileType = "pdf";
      } else if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) {
        fileType = "office";
      } else if (["mp3", "wav", "flac", "m4a", "aac", "ogg"].includes(ext)) {
        fileType = "audio";
      } else if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"].includes(ext)) {
        fileType = "video";
      } else {
        // 其他文件类型
        fileType = "file";
      }
    }

    if (!inputFile) {
      wx.showToast({
        title: "请先选择文件",
        icon: "none",
      });
      return;
    }

    try {
      let response = null;
      let resultPath = "";
      let resultRemoteUrl = "";
      let useResult = false;

      // 调用后端处理
      this.updateProcessingProgress(18, "正在上传文件...");
      response = await this.processFileCompress(inputFile, selections, fileType);
      resultPath = response.path;
      resultRemoteUrl = response.remoteUrl || "";
      useResult = true;
      this.updateProcessingProgress(92, "正在生成对比...");

      // 计算压缩比例
      const afterBytes = response.afterBytes || 0;
      const savedBytes = Math.max(beforeBytes - afterBytes, 0);
      const savedPercent = beforeBytes > 0 ? Math.round((savedBytes / beforeBytes) * 100) : 0;
      const hasSavings = useResult && savedBytes > 0;

      // 更新结果
      this.setData({
        universalCompressResultReady: true,
        universalCompressResultPath: resultPath,
        universalCompressResultRemoteUrl: resultRemoteUrl,
        universalCompressResultName: response.name || "压缩结果",
        universalCompressResultHeadline: hasSavings ? "压缩成功" : "文件体积未变小",
        universalCompressResultDetail: hasSavings ? "已按照「" + selections.mode + "」策略完成压缩。" : (response.note || "当前文件未发现可进一步压缩的空间。"),
        universalCompressResultBeforeSizeText: formatFileSize(beforeBytes),
        universalCompressResultAfterSizeText: formatFileSize(afterBytes),
        universalCompressResultSavedText: hasSavings ? "节省 " + formatFileSize(savedBytes) + " (" + savedPercent + "%)" : "未节省体积",
        universalCompressResultMetaLines: [],
        universalCompressFileType: fileType,
      });

      if (useResult && fileType === "image") {
        await this.createImageTask({
          inputName: fileName,
          outputName: response.name || "压缩结果",
          sourcePath: fileType === "image" ? inputFile.path : "",
          outputPath: resultPath,
          remoteUrl: resultRemoteUrl,
          beforeBytes,
          afterBytes,
          resultHeadline: hasSavings ? "压缩成功" : "文件体积未变小",
          resultDetail: hasSavings ? "已按照「" + selections.mode + "」策略完成压缩。" : (response.note || "当前文件未发现可进一步压缩的空间。"),
          metaLines: [],
        }, { skipToast: true, skipUpload: true });
      } else if (useResult) {
        const taskResult = createTask(tool, selections, {
          instant: true,
          skipUsage: true,
          resultType: "document",
          inputName: fileName,
          outputName: response.name || "压缩结果",
          beforeBytes,
          afterBytes,
          outputPath: resultPath,
          remoteUrl: resultRemoteUrl,
          copyText: resultRemoteUrl,
          resultHeadline: hasSavings ? "压缩成功" : "文件体积未变小",
          resultDetail: hasSavings ? `已按照「${selections.mode}」策略完成压缩。` : (response.note || "当前文件未发现可进一步压缩的空间。"),
          metaLines: [],
        });
        if (taskResult && taskResult.task) {
          this.navigateWithCreatedTask(taskResult);
        }
      }
    } catch (error) {
      console.error("万能压缩失败:", error);
      this.setData({
        isWorking: false,
        showProcessingOverlay: false,
      });
      const errorMessage = (error && error.message) || "";
      if (error && error.code === "FILE_TOO_LARGE") {
        wx.showModal({
          title: "文件过大",
          content: errorMessage || "文件超过微信小程序上传限制（100MB），请选择更小的文件",
          showCancel: false,
        });
      } else if (error && error.code === "UPLOAD_TIMEOUT") {
        wx.showModal({
          title: "上传超时",
          content: errorMessage || "文件上传超时，请检查网络后重试",
          showCancel: false,
        });
      } else if (error && error.code === "FFMPEG_UNAVAILABLE") {
        wx.showModal({
          title: "暂不支持",
          content: errorMessage || "当前服务未安装 FFmpeg，无法压缩音视频文件。请联系管理员安装 FFmpeg，或选择其他类型的文件",
          showCancel: false,
        });
      } else {
        wx.showToast({
          title: errorMessage || "压缩失败，请重试",
          icon: "none",
          duration: 3000,
        });
      }
    }
  },

  // 处理通用文件压缩
  async processFileCompress(file, selections, fileType) {
    const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
    const fileSize = file.size || 0;

    if (fileSize > MAX_UPLOAD_SIZE) {
      throw {
        message: `文件过大（${formatFileSize(fileSize)}），微信小程序上传限制为 100MB，请选择更小的文件`,
        code: "FILE_TOO_LARGE",
      };
    }

    this.updateProcessingProgress(8, "正在上传文件...");

    const uploadFileName = file.name || getFileName(file.path) || "压缩结果";

    let response;
    try {
      response = await uploadFileForJson(
        "/api/file/compress-upload",
        { path: file.path, name: uploadFileName, size: fileSize },
        { mode: selections.mode },
        {
          timeout: 600000,
          onProgressUpdate: (progress) => {
            const percent = Number(progress.progress || 0);
            this.updateProcessingDisplayProgress(8 + Math.round(percent * 0.72), "正在上传文件...");
          },
        }
      );
    } catch (uploadError) {
      const errCode = (uploadError && uploadError.code) || "";
      const errMsg = (uploadError && uploadError.errMsg) || (uploadError && uploadError.message) || "";

      if (errCode === "FFMPEG_UNAVAILABLE") {
        throw {
          message: errMsg || "当前服务未安装 FFmpeg，无法压缩音视频文件",
          code: "FFMPEG_UNAVAILABLE",
        };
      }
      if (errMsg.indexOf("exceed") > -1 || errMsg.indexOf("too large") > -1 || errMsg.indexOf("文件过大") > -1) {
        throw {
          message: `文件过大（${formatFileSize(fileSize)}），上传失败，请选择更小的文件`,
          code: "FILE_TOO_LARGE",
        };
      }
      if (errMsg.indexOf("timeout") > -1 || errMsg.indexOf("超时") > -1) {
        throw {
          message: `上传超时，文件较大（${formatFileSize(fileSize)}），请检查网络后重试`,
          code: "UPLOAD_TIMEOUT",
        };
      }
      throw uploadError;
    }

    console.log("[压缩下载] API返回完整结果:", JSON.stringify(response).substring(0, 1000));
    this.updateProcessingProgress(82, "正在压缩文件...");

    console.log("[压缩下载] file对象:", JSON.stringify(response.file || {}));
    console.log("[压缩下载] has inlineBase64:", !!(response.file && response.file.inlineBase64));
    console.log("[压缩下载] url:", response.file && response.file.url);
    console.log("[压缩下载] externalUrl:", response.file && response.file.externalUrl);
    console.log("[压缩下载] fallbackUrl:", response.file && response.file.fallbackUrl);
    console.log("[压缩下载] fileType:", fileType);

    if (response.file && response.file.inlineBase64) {
      console.log("[压缩下载] 使用 inlineBase64 处理...");
      const inlineFileName = response.file.name || uploadFileName || "compressed-result";
      
      // 对于图片，直接构建 base64 URL，不写入文件（避免模拟器访问问题）
      let resultPath = null;
      if (fileType === "image") {
        // 检测图片类型，构建正确的 data URL
        const mimeMap = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          gif: "image/gif",
          bmp: "image/bmp"
        };
        const ext = (inlineFileName.split('.').pop() || 'jpg').toLowerCase();
        const mimeType = mimeMap[ext] || 'image/jpeg';
        resultPath = `data:${mimeType};base64,${response.file.inlineBase64}`;
        console.log("[压缩下载] 构建 base64 图片 URL:", resultPath.substring(0, 100) + "...");
      } else {
        // 其他文件仍然写入文件系统
        resultPath = await writeBase64File(
          `${wx.env.USER_DATA_PATH}/compressed-${Date.now()}-${inlineFileName}`,
          response.file.inlineBase64
        );
        console.log("[压缩下载] 写入文件成功:", resultPath);
      }
      
      this.updateProcessingProgress(92, "正在整理结果...");

      return {
        path: resultPath,
        remoteUrl: response.file.downloadUrl || response.file.fallbackUrl || response.file.url || response.file.externalUrl || "",
        name: inlineFileName,
        afterBytes: response.file.sizeBytes || null,
        compressed: !!response.compressed,
        savedBytes: response.savedBytes || 0,
        savedPercent: response.savedPercent || 0,
        note: response.note || response.detail || "",
      };
    }
    
    // 如果是图片类型但没有 inlineBase64，记录警告但仍然尝试
    if (fileType === "image") {
      console.warn("[压缩下载] 图片类型但没有 inlineBase64，可能会失败");
    }

    let downloadUrl = response.file.downloadUrl || response.file.fallbackUrl || response.file.url || response.file.externalUrl || "";

    console.log("[压缩下载] 最终选择的下载URL:", downloadUrl);

    if (!downloadUrl) {
      throw new Error("下载 URL 为空，请检查后端存储配置");
    }

    const downloadRes = await new Promise((resolve, reject) => {
      const task = wx.downloadFile({
        url: downloadUrl,
        success: (res) => {
          console.log("[压缩下载] 下载响应 statusCode:", res.statusCode, "tempFilePath:", res.tempFilePath);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res);
          } else {
            console.error("[压缩下载] 下载失败, URL:", downloadUrl, "statusCode:", res.statusCode);
            reject(new Error(`下载失败: HTTP ${res.statusCode}, URL: ${downloadUrl}`));
          }
        },
        fail: (err) => {
          console.error("[压缩下载] 下载失败(err):", err, "URL:", downloadUrl);
          reject(new Error(`下载失败: ${err.errMsg || err.message}, URL: ${downloadUrl}`));
        },
      });
      if (task && task.onProgressUpdate) {
        task.onProgressUpdate((progress) => {
          const percent = Number(progress.progress || 0);
          this.updateProcessingDisplayProgress(84 + Math.round(percent * 0.08), "正在下载结果...");
        });
      }
    });
    this.updateProcessingProgress(92, "正在整理结果...");

    return {
      path: downloadRes.tempFilePath,
      remoteUrl: downloadUrl,
      name: response.file.name || "压缩结果",
      afterBytes: response.file.sizeBytes || null,
      compressed: !!response.compressed,
      savedBytes: response.savedBytes || 0,
      savedPercent: response.savedPercent || 0,
      note: response.note || response.detail || "",
    };
  },

  async runQrMaker() {
    const { tool, selections, textInput, qrLogoInput } = this.data;
    const content = (textInput || "").trim();

    if (!content) {
      wx.showToast({
        title: "先输入链接或文本",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(18, "正在编码内容...");
    const qr = qrcode(0, qrLogoInput ? "H" : "M");
    qr.addData(content);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const marginMap = {
      "标准": 4,
      "紧凑": 2,
      "留白充足": 6,
    };

    const colorMap = {
      "简洁黑白": "#111111",
      "品牌绿": "#1d5c4b",
      "暖色调": "#8f6f4f",
    };

    const cellSize = 8;
    const margin = marginMap[selections.margin] || 4;
    const size = (moduleCount + margin * 2) * cellSize;
    const fillColor = colorMap[selections.style] || "#111111";

    this.updateProcessingProgress(46, "正在绘制二维码...");
    const tempFile = await this.withCanvas(size, size, (ctx) => {
      setFillStyle(ctx, "#ffffff");
      ctx.fillRect(0, 0, size, size);
      setFillStyle(ctx, fillColor);

      for (let row = 0; row < moduleCount; row += 1) {
        for (let col = 0; col < moduleCount; col += 1) {
          if (!qr.isDark(row, col)) {
            continue;
          }

          ctx.fillRect(
            (col + margin) * cellSize,
            (row + margin) * cellSize,
            cellSize,
            cellSize
          );
        }
      }

      drawQrLogoImage(ctx, qrLogoInput, size);
    }, {
      fileType: "png",
      quality: 1,
    });

    this.updateProcessingProgress(72, "正在导出图片...");
    const fileInfo = await getFileInfo(tempFile.tempFilePath);
    this.updateProcessingProgress(86, "正在保存结果...");
    const remoteFile = await this.uploadGeneratedOutput(tempFile.tempFilePath, {
      name: "二维码.png",
      folder: "client-outputs/qr-maker",
      contentType: "image/png",
      extension: "png",
      baseName: "qr-code",
    });
    const result = createTask(tool, selections, {
      instant: true,
      skipUsage: true,
      resultType: "image",
      inputName: "二维码内容",
      outputName: "二维码.png",
      outputPath: tempFile.tempFilePath,
      remoteUrl: remoteFile ? remoteFile.url : "",
      afterBytes: fileInfo ? fileInfo.size : null,
      resultHeadline: "二维码已生成",
      resultDetail: "已生成可保存图片，适合放进海报、物料和分享页。",
      copyText: content,
      resultText: content,
      metaLines: [
        `风格 ${selections.style}`,
        `边距 ${selections.margin}`,
        `Logo ${qrLogoInput ? "已上传" : "未使用"}`,
        remoteFile ? `云端存储 ${remoteFile.provider === "qiniu" ? "七牛云" : "后端"}` : "云端存储 待同步",
      ],
    });

    if (!result.task) {
      wx.showToast({
        title: result.usage.costText,
        icon: "none",
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/task-detail/index?id=${result.task.id}`,
    });
    this.updateProcessingProgress(100, "生成完成");
  },

  async runUnitConvert() {
    const { tool, selections, numberInput, fromUnit, toUnit } = this.data;
    this.updateProcessingProgress(32, "正在计算...");
    const conversion = convertValue({
      group: selections.group,
      value: numberInput,
      fromUnit,
      toUnit,
      precisionLabel: selections.precision,
    });

    if (!conversion) {
      wx.showToast({
        title: "请输入有效数值",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(78, "正在保存结果...");
    const result = createTask(tool, selections, {
      instant: true,
      skipUsage: true,
      resultType: "text",
      inputName: `${numberInput} ${fromUnit}`,
      outputName: "换算结果",
      resultHeadline: "单位换算已完成",
      resultDetail: conversion.text,
      resultText: conversion.text,
      copyText: conversion.text,
      metaLines: [
        `类型 ${selections.group}`,
        `精度 ${selections.precision}`,
      ],
    });

    if (!result.task) {
      wx.showToast({
        title: result.usage.costText,
        icon: "none",
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/task-detail/index?id=${result.task.id}`,
    });
    this.updateProcessingProgress(100, "换算完成");
  },

  async runImageToPdf() {
    const { tool, selections, imageInputs } = this.data;
    if (!imageInputs.length) {
      wx.showToast({
        title: "先选择至少一张图片",
        icon: "none",
      });
      return;
    }

    const pdfDoc = await PDFDocument.create();
    const pageSizeMap = {
      A4: { width: 595, height: 842 },
      A5: { width: 420, height: 595 },
      "原图自适应": null,
    };

    const paperSize = pageSizeMap[selections.paper];
    const margin = selections.layout === "留白版式" ? 28 : 12;

    this.updateProcessingProgress(14, "正在读取图片...");
    for (let index = 0; index < imageInputs.length; index += 1) {
      const imageItem = imageInputs[index];
      const bytes = await readFileArrayBuffer(imageItem.path);
      const embeddedImage = imageItem.extension === "png"
        ? await pdfDoc.embedPng(bytes)
        : await pdfDoc.embedJpg(bytes);

      const imageWidth = embeddedImage.width;
      const imageHeight = embeddedImage.height;

      if (!paperSize || selections.paper === "原图自适应") {
        const page = pdfDoc.addPage([imageWidth, imageHeight]);
        page.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: imageWidth,
          height: imageHeight,
        });
      } else if (selections.layout === "两图拼页") {
        const shouldCreateNewPage = index % 2 === 0;
        const page = shouldCreateNewPage
          ? pdfDoc.addPage([paperSize.width, paperSize.height])
          : pdfDoc.getPages()[pdfDoc.getPages().length - 1];
        const slotHeight = (paperSize.height - margin * 3) / 2;
        const slotWidth = paperSize.width - margin * 2;
        const scale = Math.min(slotWidth / imageWidth, slotHeight / imageHeight);
        const drawWidth = imageWidth * scale;
        const drawHeight = imageHeight * scale;
        const slotTopIndex = index % 2;
        const x = (paperSize.width - drawWidth) / 2;
        const y = paperSize.height - margin - slotHeight * slotTopIndex - drawHeight - (slotTopIndex === 1 ? margin : 0);

        page.drawImage(embeddedImage, {
          x,
          y,
          width: drawWidth,
          height: drawHeight,
        });
      } else {
        const page = pdfDoc.addPage([paperSize.width, paperSize.height]);
        const availableWidth = paperSize.width - margin * 2;
        const availableHeight = paperSize.height - margin * 2;
        const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight);
        const drawWidth = imageWidth * scale;
        const drawHeight = imageHeight * scale;

        page.drawImage(embeddedImage, {
          x: (paperSize.width - drawWidth) / 2,
          y: (paperSize.height - drawHeight) / 2,
          width: drawWidth,
          height: drawHeight,
        });
      }
      this.updateProcessingProgress(14 + Math.round(((index + 1) / imageInputs.length) * 54), "正在排版图片...");
    }

    this.updateProcessingProgress(76, "正在生成 PDF...");
    const pdfBytes = await pdfDoc.save();
    const outputPath = `${wx.env.USER_DATA_PATH}/image-to-pdf-${Date.now()}.pdf`;
    await writeArrayBufferFile(outputPath, pdfBytes);
    const fileInfo = await getFileInfo(outputPath);
    this.updateProcessingProgress(88, "正在保存结果...");
    const remoteFile = await this.uploadGeneratedOutput(outputPath, {
      name: "图片合集.pdf",
      folder: "client-outputs/image-to-pdf",
      contentType: "application/pdf",
      extension: "pdf",
      baseName: "image-to-pdf",
    });
    const totalInputSize = imageInputs.reduce((sum, item) => sum + (item.size || 0), 0);
    const result = createTask(tool, selections, {
      instant: true,
      skipUsage: true,
      resultType: "document",
      inputName: `${imageInputs.length} 张图片`,
      outputName: "图片合集.pdf",
      outputPath,
      remoteUrl: remoteFile ? remoteFile.url : "",
      beforeBytes: totalInputSize,
      afterBytes: fileInfo ? fileInfo.size : null,
      resultHeadline: "图片转 PDF 已完成",
      resultDetail: `已把 ${imageInputs.length} 张图片整理成单个 PDF，可直接打开查看。`,
      metaLines: [
        `纸张 ${selections.paper}`,
        `布局 ${selections.layout}`,
        remoteFile ? `云端存储 ${remoteFile.provider === "qiniu" ? "七牛云" : "后端"}` : "云端存储 待同步",
      ],
    });

    if (!result.task) {
      wx.showToast({
        title: result.usage.costText,
        icon: "none",
      });
      return;
    }

    // 直接在当前页面展示结果，不跳转
    const resultName = "图片合集.pdf";
    const afterBytes = fileInfo ? fileInfo.size : null;
    const beforeBytes = totalInputSize;
    
    const beforeSizeText = formatFileSize(beforeBytes);
    const afterSizeText = afterBytes ? formatFileSize(afterBytes) : "";

    this.setData({
      imageToPdfResultReady: true,
      imageToPdfResultPath: outputPath,
      imageToPdfResultRemoteUrl: remoteFile ? remoteFile.url : "",
      imageToPdfResultName: resultName,
      imageToPdfResultHeadline: "图片转 PDF 已完成",
      imageToPdfResultDetail: `已把 ${imageInputs.length} 张图片整理成单个 PDF，可直接打开查看。`,
      imageToPdfResultMetaLines: [
        `纸张 ${selections.paper}`,
        `布局 ${selections.layout}`,
        remoteFile ? `云端存储 ${remoteFile.provider === "qiniu" ? "七牛云" : "后端"}` : "云端存储 待同步",
      ],
    });

    this.updateProcessingProgress(100, "生成完成");
  },

  handleSwiperChange(e) {
    const current = e.detail.current;
    this.setData({
      imageToPdfCurrentIndex: current,
    });
  },

  handleThumbClick(e) {
    const index = e.currentTarget.dataset.index;
    const { tool } = this.data;
    if (tool.id === "pdf-merge") {
      this.setData({
        pdfMergeCurrentIndex: index,
      });
    } else if (tool.id === "image-to-pdf") {
      this.setData({
        imageToPdfCurrentIndex: index,
      });
    }
  },

  handleThumbLongPress(e) {
    const index = e.currentTarget.dataset.index;
    const { tool } = this.data;
    if (tool.id === "image-to-pdf") {
      wx.showModal({
        title: "调整图片顺序",
        content: "长按后可拖动调整顺序，点击完成保存。",
        showCancel: false,
        confirmText: "知道了",
        success: () => {
          this.setData({
            imageToPdfSorting: true,
          });
        },
      });
    }
  },

  finishSorting() {
    const { tool } = this.data;
    if (tool.id === "pdf-merge") {
      this.setData({
        pdfMergeSorting: false,
      });
    } else {
      this.setData({
        imageToPdfSorting: false,
      });
    }
  },

  async previewImageToPdfResult() {
    const path = this.data.imageToPdfResultPath;
    if (!path) {
      wx.showToast({
        title: "文件不存在",
        icon: "none",
      });
      return;
    }
    wx.openDocument({
      filePath: path,
      fileType: "pdf",
    });
  },

  async saveImageToPdfResult() {
    const path = this.data.imageToPdfResultPath;
    if (!path) {
      wx.showToast({
        title: "文件不存在",
        icon: "none",
      });
      return;
    }
    wx.openDocument({
      filePath: path,
      fileType: "pdf",
      showMenu: true,
    });
  },

  async copyImageToPdfUrl() {
    const url = this.data.imageToPdfResultRemoteUrl;
    if (!url) {
      wx.showToast({
        title: "链接不存在",
        icon: "none",
      });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({
          title: "链接已复制",
          icon: "success",
        });
      },
    });
  },

  handleDeleteCurrentImage() {
    const index = this.data.imageToPdfCurrentIndex;
    this.deleteImage(index);
  },

  handleDeleteThumbImage(e) {
    const index = e.currentTarget.dataset.index;
    const { tool } = this.data;
    if (tool.id === "pdf-merge") {
      // 删除PDF合并中的文件
      const { pdfMergePreviewFiles, backendFiles } = this.data;
      const newPreviewFiles = pdfMergePreviewFiles.filter((_, i) => i !== index);
      const newBackendFiles = backendFiles.filter((_, i) => i !== index);
      const newIndex = index >= newPreviewFiles.length ? Math.max(0, newPreviewFiles.length - 1) : index;
      this.setData({
        pdfMergePreviewFiles: newPreviewFiles,
        backendFiles: newBackendFiles,
        pdfMergeCurrentIndex: newIndex,
      });
    } else {
      // 照片转PDF删除
      this.deleteImage(index);
    }
  },

  deleteImage(index) {
    if (this.data.imageInputs.length <= 1) {
      wx.showModal({
        title: "提示",
        content: "至少需要保留一张图片",
        showCancel: false,
      });
      return;
    }

    wx.showModal({
      title: "删除图片",
      content: "确定要删除这张图片吗？",
      success: (res) => {
        if (res.confirm) {
          const newInputs = [...this.data.imageInputs];
          newInputs.splice(index, 1);
          
          let newCurrentIndex = this.data.imageToPdfCurrentIndex;
          if (newCurrentIndex >= newInputs.length) {
            newCurrentIndex = newInputs.length - 1;
          }
          if (newCurrentIndex < 0) {
            newCurrentIndex = 0;
          }

          this.setData({
            imageInputs: newInputs,
            imageToPdfCurrentIndex: newCurrentIndex,
          });

          wx.showToast({
            title: "已删除",
            icon: "success",
          });
        }
      },
    });
  },
});
