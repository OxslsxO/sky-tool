const qrcode = require("../../utils/vendor/qrcode-generator");
const { PDFDocument } = require("../../utils/vendor/pdf-lib");
const { getToolById, getCategoryById } = require("../../data/mock");

const BACKGROUND_COLOR_MAP = {
  "鐧借壊": "#ffffff",
  "钃濊壊": "#2d6ec9",
  "绾㈣壊": "#cf5446",
  "娣¤摑": "#87ceeb",
  "澶╄摑": "#2d6ec9",
  "钘忚摑": "#1e3a5f",
  "澶х孩": "#cf5446",
  "閰掔孩": "#8b0000",
  "娴呯伆": "#d3d3d3",
  "娣＄矇": "#ffb6c1",
  "娣＄豢": "#90ee90",
};

const DEFAULT_BACKGROUND_COLORS = ["鐧借壊", "钃濊壊", "绾㈣壊"];
const AUDIO_CONVERT_AUDIO_FORMATS = ["MP3", "WAV", "FLAC", "OGG", "M4A", "AAC"];
const AUDIO_CONVERT_VIDEO_FORMATS = ["MP4", "MOV", "WEBM"];
const AUDIO_CONVERT_AUDIO_EXTS = ["mp3", "wav", "flac", "ogg", "m4a", "aac"];
const AUDIO_CONVERT_VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv", "wmv", "flv"];
const {
  createTask,
  getBillingPreview,
  toggleFavorite,
  isFavoriteTool,
  touchRecentTool,
  listTasks,
  getPhotoIdStats,
  incrementPhotoIdUsage,
  consumePoints,
  getUserState,
} = require("../../utils/task-store");
const { isClientTool } = require("../../utils/tool-engine");
const { getGroupUnits, convertValue } = require("../../utils/unit-converter");
const { formatFileSize } = require("../../utils/format");
const { hasBackendService } = require("../../services/backend-tools");
const logger = require("../../utils/logger");
const {
  requestJson,
  packLocalFile,
  downloadRemoteFile,
  uploadLocalFile,
} = require("../../services/remote-executor");

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

  if (/^https?:\/\//i.test(prev) && !/[銆傦紒锛??]$/.test(prev)) {
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

  if (prevHasCjk && prev.length <= 28 && next.length <= 14 && (prev.length + next.length) <= 34 && !/[銆傦紒锛??锛?]$/.test(prev)) {
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
    // 鍙瓨鍌ㄥ繀瑕佺殑淇℃伅锛屽噺灏戝瓨鍌ㄦ暟鎹噺
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
  },

  onLoad(options) {
    logger.log("[tool-detail] onLoad", options);
    const tool = getToolById(options.id);

    if (!tool) {
      wx.showToast({
        title: "宸ュ叿涓嶅瓨鍦?",
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
    // 娣诲姞silent閫夐」锛岄伩鍏嶈Е鍙戝悓姝ユ搷浣滃鑷撮〉闈㈠埛鏂?
    touchRecentTool(tool.id, { silent: true });

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
      ...viewState,
      ...(photoIdSession || {}),
      ...(photoIdStats || {}),
    };

    this.setData(nextState);
  },

  onShow() {
    // 馃敟 缁堟瀬鏍规不锛氬畬鍏ㄧ鐢ㄦ墍鏈夎嚜鍔ㄥ埛鏂伴€昏緫
    // 淇濈暀鏈€鍩虹鐨勫垽鏂紝涓嶆墽琛屼换浣曢〉闈㈤噸缁樸€佺姸鎬佹洿鏂?
    const { tool } = this.data;
    if (!tool) {
      return;
    }
    // 绌哄嚱鏁帮紝涓嶅仛浠讳綍鍒锋柊銆佷笉setData銆佷笉閲嶆柊娓叉煋椤甸潰
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
        selections[param.key] = "浣撶Н浼樺厛";
      } else if (tool.id === "universal-compress" && param.key === "mode") {
        selections[param.key] = "浣撶Н浼樺厛";
      } else if (tool.id === "image-convert" && param.key === "quality") {
        selections[param.key] = "楂樻竻";
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
    const customSizeValue = getToolOption(tool, "size", 3);
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

    // 涓囪兘鍘嬬缉鍚屾椂鏀寔鍥剧墖鍜屾枃浠堕€夋嫨
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
      return "鐩存帴鐢熸垚缁撴灉";
    }

    if (backendConfigured) {
      return "涓婁紶骞舵彁浜ゅ鐞?";
    }

    return "鍔熻兘缁存姢涓?";
  },

  getActionHint({ isClientTool: clientTool, backendConfigured }) {
    if (clientTool || backendConfigured) {
      return "";
    }

    return "鎴戜滑姝ｅ湪浼樺寲杩欓」鑳藉姏锛屾殏鏃舵棤娉曚娇鐢紝璇风◢鍚庡啀璇曘€?";
  },

  getPrimaryActionText({ isClientTool: clientTool, backendConfigured }) {
    if (this.data.isWorking) {
      return "澶勭悊涓?..";
    }

    if (clientTool) {
      return "寮€濮嬪鐞?";
    }

    if (backendConfigured) {
      return "鎻愪氦澶勭悊";
    }

    return "鏁鏈熷緟";
  },

  getRelatedTasks(toolId) {
    return listTasks()
      .filter((item) => item.toolId === toolId)
      .slice(0, 3);
  },

  getHelperTitle(toolId) {
    const map = {
      "photo-id": "鏅鸿兘璇佷欢鐓т簯澶勭悊",
      "image-compress": "瀹㈡埛绔嵆鏃跺帇缂?",
      "image-convert": "瀹㈡埛绔嵆鏃惰浆鎹?",
      "resize-crop": "鐢诲竷涓庢瘮渚嬭皟鏁?",
      "image-to-pdf": "鍥剧墖鏁寸悊鎴?PDF",
      "qr-maker": "浜岀淮鐮佸嵆鏃剁敓鎴?",
      "unit-convert": "鍗虫椂鎹㈢畻缁撴灉",
      "audio-convert": "闊宠棰戞牸寮忚浆鎹?",
    };

    return map[toolId] || "浜戝鐞嗚兘鍔?";
  },

  getBackendPickerTitle(toolId) {
    const map = {
      "pdf-merge": "閫夋嫨瑕佸悎骞剁殑 PDF",
      "pdf-split": "閫夋嫨瑕佹媶鍒嗙殑 PDF",
      "pdf-compress": "閫夋嫨瑕佷紭鍖栫殑 PDF",
      "office-to-pdf": "閫夋嫨 Office 鏂囦欢",
      "audio-convert": "閫夋嫨闊宠棰戞枃浠?",
    };

    return map[toolId] || "閫夋嫨鏂囦欢";
  },

  getBackendPickerButtonText(toolId) {
    const map = {
      "pdf-merge": "閫夋嫨 PDF锛堝彲澶氶€夛級",
      "pdf-split": "閫夋嫨 PDF",
      "pdf-compress": "閫夋嫨 PDF",
      "office-to-pdf": "閫夋嫨 Office 鏂囦欢",
      "audio-convert": "閫夋嫨闊宠棰戞枃浠?",
    };

    return map[toolId] || "閫夋嫨鏂囦欢";
  },

  getHelperCopy(toolId) {
    const map = {
      "photo-id": "灏嗚皟鐢ㄥ悗绔嚜鍔ㄦ姞鍥俱€佽鑼冪暀鐧藉苟杈撳嚭璇佷欢鐓э紝搴曡壊鍒囨崲浼氱洿鎺ヨ蛋浜戠澶勭悊銆?",
      "image-compress": "涓嶄緷璧栧悗绔紝鐩存帴鍦ㄥ皬绋嬪簭鍐呭畬鎴愬帇缂╁拰瀵煎嚭銆?",
      "image-convert": "褰撳墠瀹㈡埛绔ǔ瀹氭敮鎸?JPG 涓?PNG 涔嬮棿浜掕浆銆?",
      "resize-crop": "鏀寔灞呬腑瑁佸垏銆佸畬鏁寸缉鏀惧拰鐣欑櫧鐗堝紡锛岄€傚悎绀惧獟涓庡晢鍝佸浘銆?",
      "image-to-pdf": "褰撳墠鐗堟湰鏀寔鎶婁竴缁勫浘鐗囩洿鎺ユ暣鐞嗘垚鍗曚釜 PDF锛岄€傚悎浣滀笟銆佺エ鎹拰璧勬枡鎻愪氦銆?",
      "qr-maker": "杈撳叆閾炬帴鎴栨枃鏈嵆鍙敓鎴愪簩缁寸爜锛屽苟鍙繚瀛樺埌鐩稿唽銆?",
      "unit-convert": "杈撳叆鏁板€煎悗鐢熸垚鍙鍒剁粨鏋滐紝閫傚悎鏃ュ父纰庣墖鍦烘櫙銆?",
      "audio-convert": "鏀寔 MP3銆乄AV銆丗LAC銆丱GG銆丮4A銆丄AC銆丮P4銆丮OV銆乄EBM 绛夐煶瑙嗛鏍煎紡杞崲锛岄€傚悎涓嶅悓璁惧浣跨敤銆?",
    };

    return map[toolId] || "杩欑被鍔熻兘渚濊禆浜戠澶勭悊鏈嶅姟锛屽綋鍓嶄粨搴撳凡缁忛鐣欏墠绔粨鏋勶紝鍚庣画鎺ュ悗绔嵆鍙惎鐢ㄣ€?";
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
        title: "閫夋嫨鍥剧墖澶辫触",
        icon: "none",
      });
    }
  },

  // 涓囪兘鍘嬬缉閫夋嫨鏂囦欢
  async chooseUniversalCompressFile() {
    wx.showActionSheet({
      itemList: ['閫夋嫨鍥剧墖', '閫夋嫨鏂囦欢(PDF/Office绛?'],
      success: async (res) => {
        try {
          this.ignoreOnShowRefreshUntil = Date.now() + 3000;

          const nextState = {};

          if (res.tapIndex === 0) {
            // 閫夋嫨鍥剧墖
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
            // 閫夋嫨鏂囦欢
            const files = await chooseMessageFiles(1, ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
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

          // 娓呴櫎涔嬪墠鐨勭粨鏋?
          Object.assign(nextState, this.getClearedUniversalCompressResult());

          this.setData(nextState);
        } catch (error) {
          this.ignoreOnShowRefreshUntil = 0;
          if (error && error.errMsg && error.errMsg.indexOf("cancel") > -1) {
            return;
          }

          wx.showToast({
            title: "閫夋嫨鏂囦欢澶辫触",
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
        title: "Logo 閫夋嫨澶辫触",
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
      title: favorite ? "宸叉敹钘? : "宸插彇娑堟敹钘?,
      icon: "none",
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
      "photo-id": "璇佷欢鐓у鐞嗕腑",
      "image-compress": "鍥剧墖鍘嬬缉涓?",
      "image-convert": "鍥剧墖杞崲涓?",
      "resize-crop": "鍥剧墖璋冩暣涓?",
      "universal-compress": "鏂囦欢鍘嬬缉涓?",
      "image-to-pdf": "PDF 鐢熸垚涓?",
      "ocr-text": "鏂囧瓧璇嗗埆涓?",
      "pdf-merge": "PDF 鍚堝苟涓?",
      "pdf-split": "PDF 鎷嗗垎涓?",
      "pdf-compress": "PDF 鍘嬬缉涓?",
      "office-to-pdf": "鏂囨。杞崲涓?",
      "pdf-to-word": "Word 杞崲涓?",
      "audio-convert": "闊宠棰戣浆鎹腑",
      "qr-maker": "浜岀淮鐮佺敓鎴愪腑",
      "unit-convert": "鍗曚綅鎹㈢畻涓?",
    };

    return titleMap[tool && tool.id] || "澶勭悊涓?";
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
      processingStatus: options.status || "姝ｅ湪鍑嗗...",
      processingTitle: options.title || this.getProcessingTitle(tool),
      processingKind: tool ? tool.id : "",
    });
    this.startProcessingProgressTicker();
  },

  async handleExecute() {
    logger.log("[澶勭悊鎵ц] 寮€濮嬫墽琛屽鐞?)";

    if (this.data.isWorking) {
      logger.log("[澶勭悊鎵ц] 宸茬粡鍦ㄥ鐞嗕腑锛岃烦杩?)";
      return;
    }

    logger.log("[澶勭悊鎵ц] 妫€鏌ヨ璐逛俊鎭?)";
    const billing = getBillingPreview(this.data.tool);
    logger.log("[澶勭悊鎵ц] 璁¤垂淇℃伅:", billing);

    if (!billing.usable) {
      logger.log("[澶勭悊鎵ц] 璁¤垂涓嶅彲鐢?", billing.costText);
      wx.showToast({
        title: billing.costText,
        icon: "none",
      });
      return;
    }

    const consumeResult = consumePoints(this.data.tool);
    if (!consumeResult.success) {
      wx.showToast({
        title: consumeResult.billing.costText,
        icon: "none",
      });
      return;
    }

    this.setData({
      billing: getBillingPreview(this.data.tool),
    });

    logger.log("[澶勭悊鎵ц] 妫€鏌ュ伐鍏风被鍨嬪拰鍚堣鎬?)";
    const { tool, imageInput } = this.data;

    if (tool.id === "photo-id" && imageInput) {
      logger.log("[澶勭悊鎵ц] 鎵ц璇佷欢鐓у悎瑙勬€ф鏌?)";
      const complianceCheck = await this.checkPhotoCompliance(imageInput);
      if (!complianceCheck.passed) {
        logger.log("[澶勭悊鎵ц] 鍚堣鎬ф鏌ユ湭閫氳繃:", complianceCheck.message);
        wx.showModal({
          title: "鍥剧墖妫€鏌ユ彁绀?",
          content: complianceCheck.message,
          showCancel: false,
          confirmText: "鐭ラ亾浜?",
        });
        return;
      }
      logger.log("[澶勭悊鎵ц] 鍚堣鎬ф鏌ラ€氳繃");
    }

    logger.log("[澶勭悊鎵ц] 寮€濮嬭缃鐞嗙姸鎬?)";
    this.showProcessingPanel(tool, {
      progress: tool && tool.id === "image-compress" ? 8 : 6,
      status: tool && tool.id === "image-compress" ? "姝ｅ湪璇诲彇鍘熷浘..." : "姝ｅ湪鍒濆鍖?..",
    });
    logger.log("[澶勭悊鎵ц] 澶勭悊鐘舵€佽缃畬鎴?)";

    let executionSucceeded = false;
    try {
      const { tool } = this.data;
      logger.log("[澶勭悊鎵ц] 褰撳墠宸ュ叿:", tool.id);

      if (this.data.isBackendTool && !this.data.backendConfigured) {
        logger.log("[澶勭悊鎵ц] 鍚庣宸ュ叿鏈厤缃?)";
        wx.showToast({
          title: "鍔熻兘缁存姢涓紝璇风◢鍚庡啀璇?",
          icon: "none",
        });
        this.setData({
          isWorking: false,
          photoIdIsProcessing: false,
        });
      } else if (this.data.isBackendTool) {
        logger.log("[澶勭悊鎵ц] 鎵ц鍚庣宸ュ叿");
        await this.runBackendTool();
        logger.log("[澶勭悊鎵ц] 鍚庣宸ュ叿鎵ц瀹屾垚");
      } else if (tool.id === "image-compress") {
        logger.log("[澶勭悊鎵ц] 鎵ц鍥剧墖鍘嬬缉");
        await this.runImageCompress();
      } else if (tool.id === "image-convert") {
        logger.log("[澶勭悊鎵ц] 鎵ц鍥剧墖杞崲");
        await this.runImageConvert();
      } else if (tool.id === "resize-crop") {
        logger.log("[澶勭悊鎵ц] 鎵ц鍥剧墖璋冩暣");
        await this.runImageResize();
      } else if (tool.id === "universal-compress") {
        logger.log("[澶勭悊鎵ц] 鎵ц涓囪兘鍘嬬缉");
        await this.runUniversalCompress();
      } else if (tool.id === "image-to-pdf") {
        logger.log("[澶勭悊鎵ц] 鎵ц鍥剧墖杞琍DF");
        await this.runImageToPdf();
      } else if (tool.id === "qr-maker") {
        logger.log("[澶勭悊鎵ц] 鎵ц浜岀淮鐮佺敓鎴?)";
        await this.runQrMaker();
      } else if (tool.id === "unit-convert") {
        logger.log("[澶勭悊鎵ц] 鎵ц鍗曚綅杞崲");
        await this.runUnitConvert();
      }
      executionSucceeded = true;
    } catch (error) {
      logger.error("[澶勭悊鎵ц] 鎵ц澶辫触:", error.message);
      this.setData({
        isWorking: false,
        photoIdIsProcessing: false,
      });

      wx.showToast({
        title: error && (error.message || error.code) ? (error.message || error.code) : "澶勭悊澶辫触锛岃绋嶅悗閲嶈瘯",
        icon: "none",
      });
    }
    finally {
      logger.log("[澶勭悊鎵ц] 杩涘叆finally鍧?)";
      if (executionSucceeded && this.data.showProcessingOverlay) {
        this.updateProcessingProgress(100, "澶勭悊瀹屾垚");
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
      logger.log("[澶勭悊鎵ц] 閲嶇疆澶勭悊鐘舵€?)";
      this.ignoreOnShowRefreshUntil = true;
      logger.log("[澶勭悊鎵ц] 璁剧疆椤甸潰閿佸畾鏍囧織");
      if (this.data.photoIdResultReady) {
        persistPhotoIdSession(this.data);
      }
      logger.log("[澶勭悊鎵ц] 澶勭悊娴佺▼缁撴潫");
    }
  },

  async chooseBackendFiles() {
    try {
      this.ignoreOnShowRefreshUntil = Date.now() + 3000;
      const { tool } = this.data;
      const count = tool.id === "pdf-merge" ? 9 : 1;
      const extensionMap = {
        "pdf-merge": ["pdf"],
        "pdf-split": ["pdf"],
        "pdf-compress": ["pdf"],
        "office-to-pdf": ["doc", "docx", "xls", "xlsx", "ppt", "pptx"],
        "pdf-to-word": ["pdf"],
        "audio-convert": ["mp3", "wav", "flac", "ogg", "m4a", "aac", "mp4", "mov", "webm", "avi", "mkv", "wmv", "flv"],
      };

      const files = await chooseMessageFiles(count, extensionMap[tool.id] || []);

      const nextState = {
        backendFiles: files.map((file) => ({
          path: file.path,
          name: file.name || getFileName(file.path),
          size: file.size || 0,
          sizeText: formatFileSize(file.size || 0),
        })),
      };

      if (tool.id === "pdf-to-word") {
        Object.assign(nextState, this.getClearedPdfToWordResult());
      }

      if (tool.id === "audio-convert") {
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

      this.setData(nextState);
    } catch (error) {
      this.ignoreOnShowRefreshUntil = 0;
      if (error && error.errMsg && error.errMsg.indexOf("cancel") > -1) {
        return;
      }

      wx.showToast({
        title: "閫夋嫨鏂囦欢澶辫触",
        icon: "none",
      });
    }
  },

  async runBackendTool() {
    if (!this.data.backendConfigured) {
      wx.showToast({
        title: "鍔熻兘缁存姢涓紝璇风◢鍚庡啀璇?",
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
      resultType: "image",
      ...taskOptions,
      remoteUrl: remoteFile ? remoteFile.url : taskOptions.remoteUrl,
      metaLines: [
        ...(taskOptions.metaLines || []),
        remoteFile ? `浜戠瀛樺偍 ${remoteFile.provider === "qiniu" ? "涓冪墰浜? : "鍚庣"}` : "浜戠瀛樺偍 寰呭悓姝?,
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
        title: "澶勭悊瀹屾垚锛岀粨鏋滃凡淇濆瓨",
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
        title: "宸蹭繚瀛樺埌鐩稿唽",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "淇濆瓨澶辫触锛岃妫€鏌ョ浉鍐屾潈闄?",
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
          title: "宸插鍒朵笅杞介摼鎺?",
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
        title: "宸蹭繚瀛樺埌鐩稿唽",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "淇濆瓨澶辫触锛岃妫€鏌ョ浉鍐屾潈闄?",
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
          title: "宸插鍒朵笅杞介摼鎺?",
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

    // 濡傛灉鏄浘鐗囷紝浣跨敤鍥剧墖棰勮
    if (this.data.universalCompressFileType === "image") {
      wx.previewImage({
        current,
        urls: [current],
      });
    } else {
      // 鍏朵粬鏂囦欢鐩存帴鎵撳紑
      wx.openDocument({
        filePath: current,
        showMenu: true,
      });
    }
  },

  async saveUniversalCompressResult() {
    let filePath = this.data.universalCompressResultPath;

    try {
      if (!filePath && this.data.universalCompressResultRemoteUrl) {
        const download = await downloadRemoteFile(this.data.universalCompressResultRemoteUrl);
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("UNIVERSAL_COMPRESS_FILE_MISSING");
      }

      // 濡傛灉鏄浘鐗囷紝淇濆瓨鍒扮浉鍐?
      if (this.data.universalCompressFileType === "image") {
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath,
            success: resolve,
            fail: reject,
          });
        });
        wx.showToast({
          title: "宸蹭繚瀛樺埌鐩稿唽",
          icon: "none",
        });
      } else {
        // 鍏朵粬鏂囦欢閫氳繃鏂囨。鏂瑰紡鎵撳紑锛岃鐢ㄦ埛鑷繁淇濆瓨
        await new Promise((resolve, reject) => {
          wx.openDocument({
            filePath,
            showMenu: true,
            success: resolve,
            fail: reject,
          });
        });
      }
    } catch (error) {
      wx.showToast({
        title: "淇濆瓨澶辫触锛岃閲嶈瘯",
        icon: "none",
      });
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
          title: "宸插鍒朵笅杞介摼鎺?",
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
        title: "宸蹭繚瀛樺埌鐩稿唽",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "淇濆瓨澶辫触锛岃妫€鏌ョ浉鍐屾潈闄?",
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
          title: "宸插鍒朵笅杞介摼鎺?",
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
        context.onError(() => {
          this.setData({ audioConvertIsPlaying: false });
          wx.showToast({
            title: "鎾斁澶辫触",
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

    if (wx.previewMedia) {
      wx.previewMedia({
        sources: [{
          url: current,
          type: "video",
        }],
      });
    } else {
      wx.showToast({
        title: "鍙湪涓婃柟鎾斁棰勮",
        icon: "none",
      });
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
          title: "宸蹭繚瀛樺埌鐩稿唽",
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
        title: "宸蹭繚瀛樺埌鎵嬫満",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "淇濆瓨澶辫触锛岃閲嶈瘯",
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
          title: "宸插鍒朵笅杞介摼鎺?",
          icon: "none",
        });
      },
    });
  },

  async previewPdfToWordResult() {
    const url = this.data.pdfToWordResultRemoteUrl;
    if (!url) {
      wx.showToast({
        title: "棰勮閾炬帴涓嶅瓨鍦?",
        icon: "none",
      });
      return;
    }

    // 妫€鏌ユ槸鍚︽湁鍚庣鏈嶅姟
    if (!hasBackendService()) {
      wx.showToast({
        title: "鍚庣鏈嶅姟鏈厤缃?",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "姝ｅ湪鍔犺浇",
      mask: true,
    });

    try {
      // 鍏堜笅杞芥枃浠?
      const downloadRes = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: url,
          success: (res) => {
            if (res.statusCode === 200) {
              resolve(res);
            } else {
              reject(new Error(`涓嬭浇澶辫触: ${res.statusCode}`));
            }
          },
          fail: (err) => reject(err),
        });
      });

      // 鎵撳紑鏂囨。
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: downloadRes.tempFilePath,
          fileType: 'docx',
          showMenu: true,
          success: resolve,
          fail: reject,
        });
      });

      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      console.error("棰勮澶辫触:", error);
      wx.showModal({
        title: "棰勮澶辫触",
        content: "璇锋鏌ョ綉缁滆繛鎺ユ垨灏濊瘯澶嶅埗閾炬帴鍦ㄥ叾浠栧簲鐢ㄤ腑鎵撳紑",
        showCancel: false,
        confirmText: "鐭ラ亾浜?",
      });
    }
  },

  async downloadPdfToWordResult() {
    const url = this.data.pdfToWordResultRemoteUrl;
    if (!url) {
      wx.showToast({
        title: "涓嬭浇閾炬帴涓嶅瓨鍦?",
        icon: "none",
      });
      return;
    }

    // 妫€鏌ユ槸鍚︽湁鍚庣鏈嶅姟
    if (!hasBackendService()) {
      wx.showToast({
        title: "鍚庣鏈嶅姟鏈厤缃?",
        icon: "none",
      });
      return;
    }

    wx.showLoading({
      title: "姝ｅ湪鎵撳紑",
      mask: true,
    });

    try {
      // 鍏堜笅杞芥枃浠?
      const downloadRes = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: url,
          success: (res) => {
            if (res.statusCode === 200) {
              resolve(res);
            } else {
              reject(new Error(`涓嬭浇澶辫触: ${res.statusCode}`));
            }
          },
          fail: (err) => reject(err),
        });
      });

      // 鎵撳紑鏂囨。锛堢敤鎴峰彲浠ュ湪鏂囨。棰勮涓€夋嫨淇濆瓨锛?
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: downloadRes.tempFilePath,
          fileType: 'docx',
          showMenu: true,
          success: resolve,
          fail: reject,
        });
      });

      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      console.error("鎵撳紑澶辫触:", error);
      wx.showModal({
        title: "鎵撳紑澶辫触",
        content: "璇峰皾璇曞鍒堕摼鎺ュ湪鍏朵粬搴旂敤涓墦寮€",
        showCancel: false,
        confirmText: "鐭ラ亾浜?",
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
          title: "宸插鍒朵笅杞介摼鎺?",
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
      title: "澶勭悊瀹屾垚锛岀粨鏋滃凡淇濆瓨",
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
    this.updateProcessingProgress(88, "姝ｅ湪淇濆瓨缁撴灉...");
    const file = response.file || {};
    const result = createTask(tool, selections, {
      instant: true,
      resultType: response.resultType || "document",
      inputName,
      outputName: file.name || tool.name,
      beforeBytes,
      afterBytes: file.sizeBytes || null,
      resultHeadline: response.headline,
      resultDetail: response.detail,
      remoteUrl: file.url || "",
      copyText: file.url || "",
      metaLines: response.metaLines || [],
      attachments: (response.files || []).map((item) => ({
        name: item.name,
        label: item.label,
        url: item.url,
        sizeBytes: item.sizeBytes,
      })),
    });

    this.navigateWithCreatedTask(result);
    this.updateProcessingProgress(100, "澶勭悊瀹屾垚");
  },

  async runRemoteOcr() {
    const { tool, selections, imageInput } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€寮犲浘鐗?",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(16, "姝ｅ湪璇诲彇鍥剧墖...");
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
      status: "姝ｅ湪璇嗗埆鏂囧瓧...",
      sizeBytes: imageInput.size,
    });
    this.updateProcessingProgress(84, "姝ｅ湪鏁寸悊鏂囧瓧...");
    const resultText = response.text || "";
    const resultLines = buildOcrLineItems(response.lines, resultText);
    const result = createTask(tool, selections, {
      instant: true,
      resultType: "text",
      inputName: getFileName(imageInput.path),
      outputName: "OCR 鏂囨湰缁撴灉",
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
      ocrResultHeadline: response.headline || "鏂囧瓧璇嗗埆宸插畬鎴?",
      ocrResultDetail: response.detail || `璇嗗埆鍑?${resultText.length} 涓瓧绗`,
      ocrResultProviderText: response.provider === "baidu" ? "鐧惧害 OCR" : "Tesseract",
    });

    wx.showToast({
      title: "璇嗗埆瀹屾垚",
      icon: "none",
    });
    this.updateProcessingProgress(100, "璇嗗埆瀹屾垚");
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
          title: "宸插鍒?",
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
          title: "宸插鍒跺叏閮ㄦ枃瀛?",
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
    const status = options.status || "姝ｅ湪澶勭悊...";
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
        title: "璇峰厛閫夋嫨涓€寮犲浘鐗?",
        icon: "none",
      });
      return;
    }

    try {
      this.updateProcessingProgress(5, "姝ｅ湪鍑嗗鍥剧墖...");
      logger.log("[鐓х墖杞瘉浠剁収] 寮€濮嬪鐞嗙収鐗?)";

      wx.getNetworkType({
        success: function(res) {
          logger.log("[鐓х墖杞瘉浠剁収] 缃戠粶鐘舵€?", res.networkType);
        }
      });

      logger.log("[鐓х墖杞瘉浠剁収] 鏋勫缓璇锋眰鍙傛暟:", {
        size: selections.size,
        background: selections.background,
        retouch: selections.retouch,
        imagePath: imageInput.path,
        imageSize: imageInput.size
      });

      this.updateProcessingProgress(15, "姝ｅ湪涓婁紶鍥剧墖...");
      logger.log("[鐓х墖杞瘉浠剁収] 寮€濮嬫墦鍖呮枃浠?)";
      const packedFile = await packLocalFile({
        path: imageInput.path,
        name: getFileName(imageInput.path),
        size: imageInput.size,
      });
      logger.log("[鐓х墖杞瘉浠剁収] 鏂囦欢鎵撳寘瀹屾垚");

      logger.log("[鐓х墖杞瘉浠剁収] 鍙戦€佽姹傚埌 /api/photo-id");
      const remoteResponse = await this.requestJsonWithProgress("/api/photo-id", {
        file: packedFile,
        size: selections.size,
        background: selections.background,
        retouch: selections.retouch,
      }, {
        target: 74,
        status: "姝ｅ湪鏅鸿兘鎶犲浘...",
        sizeBytes: imageInput.size,
        requestOptions: {
          timeout: 180000,
          includeMeta: true,
        },
      });
      const response = remoteResponse && remoteResponse.data ? remoteResponse.data : remoteResponse;

      this.updateProcessingProgress(75, "姝ｅ湪鐢熸垚璇佷欢鐓?..");

      logger.log("[鐓х墖杞瘉浠剁収] 鏀跺埌鍝嶅簲:", response);

      // 妫€鏌ュ搷搴旀牸寮?
      if (!response) {
        logger.log("[鐓х墖杞瘉浠剁収] 鏀跺埌绌哄搷搴?)";
        throw new Error("绌哄搷搴?)";
      }

      // 澶勭悊鍝嶅簲鏁版嵁
      const file = response.file || {};
      logger.log("[鐓х墖杞瘉浠剁収] 鍝嶅簲鏂囦欢鏁版嵁:", file);

      let outputPath = "";
      let previewPath = "";
      if (file.inlineBase64) {
        try {
          outputPath = await writeBase64File(
            `${wx.env.USER_DATA_PATH}/photo-id-result-${Date.now()}.png`,
            file.inlineBase64
          );
          previewPath = outputPath;
          logger.log("[鐓х墖杞瘉浠剁収] 宸插啓鍏ユ湰鍦伴瑙堟枃浠?", outputPath);
        } catch (error) {
          logger.error("[鐓х墖杞瘉浠剁収] 鍐欏叆鏈湴棰勮澶辫触:", error.message);
        }
      }
      const shouldDownloadPreviewEagerly = false;

      if (shouldDownloadPreviewEagerly && file.url) {
        try {
          logger.log("[鐓х墖杞瘉浠剁収] 寮€濮嬩笅杞芥枃浠?", file.url);
          const download = await downloadRemoteFile(file.url);
          logger.log("[鐓х墖杞瘉浠剁収] 涓嬭浇瀹屾垚:", {
            statusCode: download.statusCode,
            tempFilePath: download.tempFilePath
          });
          if (download.statusCode >= 200 && download.statusCode < 300) {
            outputPath = download.tempFilePath || "";
            previewPath = download.tempFilePath || previewPath;
            logger.log("[鐓х墖杞瘉浠剁収] 涓嬭浇鎴愬姛锛屾枃浠惰矾寰?", outputPath);
          } else {
            logger.log("[鐓х墖杞瘉浠剁収] 涓嬭浇澶辫触锛岀姸鎬佺爜:", download.statusCode);
          }
        } catch (error) {
          logger.error("[鐓х墖杞瘉浠剁収] 涓嬭浇寮傚父:", error.message);
          // Fall back to remote preview/link only.
        }
      }

      if (!file.url) {
        logger.log("[鐓х墖杞瘉浠剁収] 鍝嶅簲涓病鏈夋枃浠禪RL");
      }

      this.updateProcessingProgress(90, "姝ｅ湪淇濆瓨缁撴灉...");

      const nextState = {
        isWorking: false,
        photoIdIsProcessing: false,
        photoIdResultReady: true,
        photoIdResultPath: outputPath || previewPath,
        photoIdResultRemoteUrl: file.url || "",
        photoIdResultName: file.name || `璇佷欢鐓${selections.background}.png`,
        photoIdResultHeadline: response.headline || "璇佷欢鐓х敓鎴愭垚鍔?",
        photoIdResultDetail: response.detail || "宸插畬鎴愯瘉浠剁収鐨勫鐞嗭紝鍙瑙堟垨淇濆瓨鍒扮浉鍐?",
        photoIdResultMetaLines: response.metaLines || [],
        showProcessingOverlay: false,
        processingProgress: 100,
        processingStatus: "澶勭悊瀹屾垚",
      };

      const taskResult = createTask(tool, selections, {
        instant: true,
        skipUsage: true,
        resultType: "image",
        inputName: getFileName(imageInput.path),
        outputName: file.name || `璇佷欢鐓${selections.background || "鑳屾櫙"}.png`,
        beforeBytes: imageInput.size,
        afterBytes: file.sizeBytes || null,
        resultHeadline: response.headline || "璇佷欢鐓у凡鐢熸垚",
        resultDetail: response.detail || "宸插畬鎴愯瘉浠剁収澶勭悊锛屽彲棰勮鎴栦繚瀛樺埌鐩稿唽銆?",
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
        // 澧炲姞璇佷欢鐓т娇鐢ㄦ鏁?
        const stats = incrementPhotoIdUsage();
        nextState.totalUsageCount = stats.totalUsageCount;
      }

      persistPhotoIdSession({
        ...this.data,
        ...nextState,
      });

      logger.log("[鐓х墖杞瘉浠剁収] 鍑嗗鏇存柊鐘舵€?", nextState);

      // 鏇存柊鐘舵€?
      this.setData(nextState);
      logger.log("[鐓х墖杞瘉浠剁収] 鐘舵€佹洿鏂板畬鎴?)";

      // 鏄剧ず澶勭悊瀹屾垚鎻愮ず
      wx.showToast({
        title: "澶勭悊瀹屾垚",
        icon: "none",
        duration: 2000
      });
      logger.log("[鐓х墖杞瘉浠剁収] 鏄剧ず澶勭悊瀹屾垚鎻愮ず");
    } catch (error) {
      logger.error("[鐓х墖杞瘉浠剁収] 澶勭悊澶辫触:", error.message);
      this.setData({
        isWorking: false,
        photoIdIsProcessing: false,
        showProcessingOverlay: false,
        processingProgress: 0,
        processingStatus: "",
      });
      wx.showToast({
        title: "澶勭悊澶辫触锛岃绋嶅悗閲嶈瘯",
        icon: "none",
        duration: 2000
      });
    } finally {
      logger.log("[鐓х墖杞瘉浠剁収] 澶勭悊娴佺▼缁撴潫");
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
    logger.log("[鍚堣鎬ф鏌 寮€濮嬫鏌ュ浘鐗?", imageInput.path);

    const result = {
      passed: true,
      message: "",
    };

    try {
      const { width, height, size } = imageInput;

      if (!width || !height) {
        result.passed = false;
        result.message = "鏃犳硶鑾峰彇鍥剧墖灏哄淇℃伅锛岃閲嶆柊閫夋嫨鍥剧墖銆?";
        return result;
      }

      if (width < 300 || height < 300) {
        result.passed = false;
        result.message = `鍥剧墖灏哄杩囧皬锛?{width}脳${height}锛夛紝璇蜂笂浼犺嚦灏?300脳300 鍍忕礌鐨勫浘鐗囥€俙`;
        return result;
      }

      if (width > 4096 || height > 4096) {
        result.passed = false;
        result.message = `鍥剧墖灏哄杩囧ぇ锛?{width}脳${height}锛夛紝璇蜂笂浼犱笉瓒呰繃 4096脳4096 鍍忕礌鐨勫浘鐗囥€俙`;
        return result;
      }

      const aspectRatio = width / height;
      if (aspectRatio < 0.3 || aspectRatio > 3) {
        result.passed = false;
        result.message = "鍥剧墖姣斾緥寮傚父锛堣繃浜庣粏闀挎垨鎵佸钩锛夛紝璇烽€夋嫨姝ｅ父姣斾緥鐨勭収鐗囥€?";
        return result;
      }

      if (size && size > 20 * 1024 * 1024) {
        result.passed = false;
        result.message = `鍥剧墖鏂囦欢杩囧ぇ锛?{formatFileSize(size)}锛夛紝璇蜂笂浼犱笉瓒呰繃 20MB 鐨勫浘鐗囥€俙`;
        return result;
      }

      logger.log("[鍚堣鎬ф鏌 鍩虹妫€鏌ラ€氳繃锛屽昂瀵?", width, "x", height, "姣斾緥:", aspectRatio.toFixed(2));

    } catch (error) {
      logger.error("[鍚堣鎬ф鏌 妫€鏌ヨ繃绋嬪嚭閿?", error);
      result.passed = false;
      result.message = "鍥剧墖妫€鏌ヨ繃绋嬪嚭閿欙紝璇烽噸鏂伴€夋嫨鍥剧墖銆?";
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
        title: "宸蹭繚瀛樺埌鐩稿唽",
        icon: "none",
      });
    } catch (error) {
      wx.showToast({
        title: "淇濆瓨澶辫触锛岃妫€鏌ョ浉鍐屾潈闄?",
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
          title: "宸插鍒朵笅杞介摼鎺?",
          icon: "none",
        });
      },
    });
  },

  async runRemotePdfMerge() {
    const { tool, selections, backendFiles } = this.data;
    if (backendFiles.length < 2) {
      wx.showToast({
        title: "鑷冲皯閫夋嫨 2 涓?PDF",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(18, "姝ｅ湪璇诲彇 PDF...");
    const files = [];
    for (let index = 0; index < backendFiles.length; index += 1) {
      files.push(await packLocalFile(backendFiles[index]));
      this.updateProcessingProgress(18 + Math.round(((index + 1) / backendFiles.length) * 24), "姝ｅ湪璇诲彇 PDF...");
    }

    const beforeBytes = backendFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    const response = await this.requestJsonWithProgress("/api/pdf/merge", { files }, {
      target: 84,
      status: "姝ｅ湪鍚堝苟 PDF...",
      sizeBytes: beforeBytes,
    });
    await this.createRemoteDocumentTask(tool, selections, response, `${backendFiles.length} 浠?PDF`, beforeBytes);
  },

  async runRemotePdfSplit() {
    const { tool, selections, backendFiles, pageRange } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€涓?PDF",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(24, "姝ｅ湪璇诲彇 PDF...");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/pdf/split", {
      file,
      splitMode: selections.splitMode,
      pageRange,
    }, {
      target: 84,
      status: "姝ｅ湪鎷嗗垎 PDF...",
      sizeBytes: backendFiles[0].size,
    });

    await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);
  },

  async runRemotePdfCompress() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€涓?PDF",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(24, "姝ｅ湪璇诲彇 PDF...");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/pdf/compress", {
      file,
      mode: selections.mode,
    }, {
      target: 84,
      status: "姝ｅ湪鍘嬬缉 PDF...",
      sizeBytes: backendFiles[0].size,
    });

    await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);
  },

  async runRemoteOfficeToPdf() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€涓?Office 鏂囦欢",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(24, "姝ｅ湪璇诲彇鏂囨。...");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/office/to-pdf", {
      file,
      quality: selections.quality,
      pageMode: selections.pageMode,
    }, {
      target: 84,
      status: "姝ｅ湪杞崲 PDF...",
      sizeBytes: backendFiles[0].size,
    });

    await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);
  },

  async runRemotePdfToWord() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€涓?PDF 鏂囦欢",
        icon: "none",
      });
      return;
    }

    try {
      this.updateProcessingProgress(22, "姝ｅ湪璇诲彇 PDF...");
      const file = await packLocalFile(backendFiles[0]);
      const response = await this.requestJsonWithProgress("/api/pdf/to-word", {
        file,
        format: selections.format,
        layout: selections.layout,
      }, {
        target: 80,
        status: "姝ｅ湪杞崲 Word...",
        sizeBytes: backendFiles[0].size,
      });

      this.updateProcessingProgress(82, "姝ｅ湪淇濆瓨缁撴灉...");
      const taskResult = await this.createRemoteDocumentTask(tool, selections, response, backendFiles[0].name, backendFiles[0].size);

      const fileResponse = response.file || {};
      const remoteUrl = fileResponse.url || "";

      // 浣跨敤鍘熸枃浠跺悕锛屾浛鎹㈡墿灞曞悕涓?.docx
      const originalName = backendFiles[0].name || "鏂囨。";
      const baseName = originalName.replace(/\.pdf$/i, "");
      const fileName = `${baseName}.docx`;

      const afterBytes = fileResponse.sizeBytes || null;
      const beforeBytes = backendFiles[0].size || 0;

      const beforeSizeText = formatFileSize(beforeBytes);
      const afterSizeText = afterBytes ? formatFileSize(afterBytes) : "";

      this.setData({
        pdfToWordResultReady: true,
        pdfToWordResultPath: "",
        pdfToWordResultRemoteUrl: remoteUrl,
        pdfToWordResultName: fileName,
        pdfToWordResultHeadline: response.headline || "PDF杞琖ord宸插畬鎴?",
        pdfToWordResultDetail: response.detail || "",
        pdfToWordResultMetaLines: response.metaLines || [],
      });

      this.updateProcessingProgress(100, "杞崲瀹屾垚");
    } catch (error) {
      console.error("PDF杞琖ord澶辫触:", error);
      wx.showToast({
        title: "杞崲澶辫触锛岃閲嶈瘯",
        icon: "none",
      });
    }
  },

  async runRemoteAudioConvert() {
    const { tool, selections, backendFiles } = this.data;
    if (!backendFiles.length) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€涓煶瑙嗛鏂囦欢",
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
    const unsupportedExts = ["ncm", "kgm", "vpr", "mgg", "qmc", "kwm", "xm", "tm", "bkcmp3", "bkcflac", "tkm"];

    if (unsupportedExts.includes(ext)) {
      wx.showModal({
        title: "涓嶆敮鎸佹鏍煎紡",
        content: `.${ext} 鏄姞瀵嗛煶涔愭牸寮忥紝鏃犳硶鐩存帴杞崲銆俓n寤鸿锛氬厛鍦ㄥ師闊充箰 APP 涓鍑轰负 MP3 绛夋櫘閫氭牸寮忋€俙`,
        showCancel: false,
        confirmText: "鐭ラ亾浜?",
      });
      return;
    }

    if (!supportedExts.includes(ext)) {
      const proceed = await new Promise((resolve) => {
        wx.showModal({
          title: "鏍煎紡鍙兘涓嶆敮鎸?",
          content: `.${ext} 鏍煎紡鍙兘鏃犳硶姝ｅ父杞崲銆俓n纭畾缁х画鍚楋紵`,
          confirmText: "缁х画",
          success: (res) => resolve(res.confirm),
        });
      });
      if (!proceed) {
        return;
      }
    }

    if (!target || !targetOptions.includes(target)) {
      wx.showToast({
        title: "璇峰厛閫夋嫨鐩爣鏍煎紡",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(22, "姝ｅ湪璇诲彇闊宠棰?..");
    const file = await packLocalFile(backendFiles[0]);
    const response = await this.requestJsonWithProgress("/api/audio/convert", {
      file,
      target,
      quality: selections.quality,
    }, {
      target: 84,
      status: "姝ｅ湪杞崲闊宠棰?..",
      sizeBytes: backendFiles[0].size,
    });

    this.updateProcessingProgress(88, "姝ｅ湪淇濆瓨缁撴灉...");
    const fileResponse = response.file || {};
    const outputName = fileResponse.name || `${fileName.replace(/\.[^.]+$/, "")}.${target.toLowerCase()}`;
    const remoteUrl = fileResponse.url || "";
    const resultKind = getAudioConvertResultKind(outputName, target);
    const finalSelections = {
      ...selections,
      target,
    };
    const result = createTask(tool, finalSelections, {
      instant: true,
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
      audioConvertResultHeadline: response.headline || "闊宠棰戞牸寮忚浆鎹㈠凡瀹屾垚",
      audioConvertResultDetail: response.detail || `宸茶浆鎹负 ${target} 鏍煎紡锛屽彲棰勮鎴栦繚瀛樸€俙`,
      audioConvertResultMetaLines: response.metaLines || [],
      audioConvertResultKind: resultKind,
      audioConvertIsPlaying: false,
    });
  },

  async runImageCompress() {
    const { imageInput, selections } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€寮犲浘鐗?",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(18, "姝ｅ湪鍒嗘瀽鍥剧墖灏哄...");

    const scaleMap = {
      娓呮櫚浼樺厛: 1,
      鍧囪　: 0.82,
      浣撶Н浼樺厛: 0.65,
    };

    const qualityMap = {
      娓呮櫚浼樺厛: 0.9,
      鍧囪　: 0.76,
      浣撶Н浼樺厛: 0.56,
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

    this.updateProcessingProgress(42, "姝ｅ湪鍘嬬缉鍥剧墖...");
    const tempFile = await this.withCanvas(width, height, (ctx) => {
      ctx.drawImage(imageInput.path, 0, 0, width, height);
    }, {
      fileType: exportFormat,
      quality: exportFormat === "jpg" ? quality : 1,
    });

    this.updateProcessingProgress(72, "姝ｅ湪缁熻鍘嬬缉缁撴灉...");
    const fileInfo = await getFileInfo(tempFile.tempFilePath);
    const afterBytes = fileInfo ? fileInfo.size : null;
    const savedBytes = afterBytes === null ? null : Math.max(imageInput.size - afterBytes, 0);
    const savedPercent = imageInput.size && savedBytes !== null
      ? Math.round((savedBytes / imageInput.size) * 100)
      : 0;

    this.updateProcessingProgress(88, "姝ｅ湪淇濆瓨缁撴灉...");
    const taskResult = await this.createImageTask({
      inputName: "鍘熷浘",
      outputName: `鍘嬬缉缁撴灉.${exportFormat}`,
      sourcePath: imageInput.path,
      outputPath: tempFile.tempFilePath,
      beforeBytes: imageInput.size,
      afterBytes,
      resultHeadline: "鍥剧墖鍘嬬缉宸插畬鎴?",
      resultDetail: `宸叉寜鈥?{selections.mode}鈥濆鍑?${exportFormat.toUpperCase()} 鏂囦欢锛屽彲鐩存帴淇濆瓨鎴栫户缁彂閫併€俙`,
      metaLines: [
        `鍘熷浘灏哄 ${imageInput.width} 脳 ${imageInput.height}`,
        `缁撴灉灏哄 ${width} 脳 ${height}`,
      ],
    });

    this.updateProcessingProgress(100, "鍘嬬缉瀹屾垚");

    const beforeSizeText = formatFileSize(imageInput.size);
    const afterSizeText = formatFileSize(afterBytes);
    const savedSizeText = savedBytes === null
      ? ""
      : `${formatFileSize(savedBytes)}${savedPercent > 0 ? ` 路 ${savedPercent}%` : ""}`;

    this.setData({
      compressResultReady: true,
      compressResultPath: tempFile.tempFilePath,
      compressResultRemoteUrl: taskResult && taskResult.remoteFile ? taskResult.remoteFile.url : "",
      compressResultName: `鍘嬬缉缁撴灉.${exportFormat}`,
      compressResultHeadline: `${beforeSizeText} 鈫?${afterSizeText}`,
      compressResultDetail: savedSizeText
        ? `鑺傜渷 ${savedSizeText}`
        : "",
      compressResultBeforeSizeText: beforeSizeText,
      compressResultAfterSizeText: afterSizeText,
      compressResultSavedText: savedSizeText || "--",
      compressResultMetaLines: [
        `鍘熷浘灏哄 ${imageInput.width} 脳 ${imageInput.height}`,
        `缁撴灉灏哄 ${width} 脳 ${height}`,
        `瀵煎嚭鏍煎紡 ${exportFormat.toUpperCase()}`,
        `鍘嬬缉绛栫暐 ${selections.mode}`,
      ],
    });
  },

  async runImageConvert() {
    const { imageInput, selections } = this.data;
    if (!imageInput) {
      wx.showToast({
        title: "鍏堥€夋嫨涓€寮犲浘鐗?",
        icon: "none",
      });
      return;
    }

    const qualityMap = {
      鏍囧噯: 0.82,
      楂樻竻: 0.92,
      缃戦〉浼樺寲: 0.68,
    };

    const exportFormat = selections.target.toLowerCase();
    this.updateProcessingProgress(18, "姝ｅ湪璇诲彇鍥剧墖...");

    const tempFile = await this.withCanvas(imageInput.width, imageInput.height, (ctx) => {
      if (exportFormat === "jpg") {
        setFillStyle(ctx, "#ffffff");
        ctx.fillRect(0, 0, imageInput.width, imageInput.height);
      }
      ctx.drawImage(imageInput.path, 0, 0, imageInput.width, imageInput.height);
    }, {
      fileType: exportFormat,
      quality: exportFormat === "jpg" ? qualityMap[selections.quality] : 1,
    });

    this.updateProcessingProgress(62, "姝ｅ湪瀵煎嚭鍥剧墖...");
    const fileInfo = await getFileInfo(tempFile.tempFilePath);
    const afterBytes = fileInfo ? fileInfo.size : null;

    this.updateProcessingProgress(82, "姝ｅ湪淇濆瓨缁撴灉...");
    const taskResult = await this.createImageTask({
      inputName: "鍘熷浘",
      outputName: `鏍煎紡杞崲缁撴灉.${exportFormat}`,
      sourcePath: imageInput.path,
      outputPath: tempFile.tempFilePath,
      beforeBytes: imageInput.size,
      afterBytes,
      resultHeadline: "鍥剧墖鏍煎紡杞崲宸插畬鎴?",
      resultDetail: `宸茶緭鍑?${selections.target} 鏂囦欢锛岄€傚悎鐩存帴淇濆瓨鎴栫敤浜庝笅涓€姝ュ鐞嗐€俙`,
      metaLines: [
        `鍘熷浘灏哄 ${imageInput.width} 脳 ${imageInput.height}`,
        `鐩爣鏍煎紡 ${selections.target}`,
      ],
    });

    const fromFormat = (imageInput.extension || "鏈煡").toUpperCase();
    const toFormat = selections.target;
    const beforeSizeText = formatFileSize(imageInput.size);
    const afterSizeText = formatFileSize(afterBytes);

    this.setData({
      convertResultReady: true,
      convertResultPath: tempFile.tempFilePath,
      convertResultRemoteUrl: taskResult && taskResult.remoteFile ? taskResult.remoteFile.url : "",
      convertResultName: `鏍煎紡杞崲缁撴灉.${exportFormat}`,
      convertResultHeadline: `${fromFormat} 鈫?${toFormat}`,
      convertResultDetail: `${beforeSizeText} 鈫?${afterSizeText}`,
      convertResultFromFormat: fromFormat,
      convertResultToFormat: toFormat,
      convertResultMetaLines: [
        `鍘熷浘灏哄 ${imageInput.width} 脳 ${imageInput.height}`,
        `杈撳嚭璐ㄩ噺 ${selections.quality}`,
      ],
    });
    this.updateProcessingProgress(100, "杞崲瀹屾垚");
  },

  getResizeTargetSize() {
    const { selections, imageInput, customWidth, customHeight } = this.data;

    if (selections.size === "鑷畾涔?) {"
      return {
        width: clampDimension(customWidth, imageInput ? imageInput.width : 1600),
        height: clampDimension(customHeight, imageInput ? imageInput.height : 900),
      };
    }

    const sizeMap = {
      "涓€瀵?: { width: 295, height: 413 }",
      "灏忎竴瀵?: { width: 260, height: 378 }",
      "浜屽": { width: 413, height: 579 },
      "灏忎簩瀵?: { width: 354, height: 472 }",
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
    const scale = fitMode === "灞呬腑瑁佸壀"
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
        title: "鍏堥€夋嫨涓€寮犲浘鐗?",
        icon: "none",
      });
      return;
    }

    const target = this.getResizeTargetSize();
    const layout = this.getDrawLayout(target.width, target.height, selections.fit);
    const exportFormat = imageInput.extension === "png" ? "png" : "jpg";
    const background = selections.fit === "鏅鸿兘鐣欑櫧" ? "#f4efe6" : "#ffffff";

    this.updateProcessingProgress(16, "姝ｅ湪璁＄畻灏哄...");

    try {
      this.updateProcessingProgress(38, "姝ｅ湪缁樺埗鍥剧墖...");
      const tempFile = await this.withCanvas(target.width, target.height, (ctx) => {
        setFillStyle(ctx, background);
        ctx.fillRect(0, 0, target.width, target.height);
        ctx.drawImage(imageInput.path, layout.x, layout.y, layout.drawWidth, layout.drawHeight);
      }, {
        fileType: exportFormat,
        quality: exportFormat === "jpg" ? 0.88 : 1,
      });

      this.updateProcessingProgress(66, "姝ｅ湪瀵煎嚭鍥剧墖...");
      const fileInfo = await getFileInfo(tempFile.tempFilePath);

      this.setData({
        resizeResultReady: true,
        resizeResultPath: tempFile.tempFilePath,
        resizeResultName: `鏀瑰昂瀵哥粨鏋?${exportFormat}`,
        resizeResultHeadline: "鍥剧墖灏哄璋冩暣宸插畬鎴?",
        resizeResultDetail: `宸叉寜 ${selections.size} 鍜屸€?{selections.fit}鈥濆鍑猴紝鍙户缁敤浜庢捣鎶ャ€佺ぞ濯掓垨鍟嗗搧鍥俱€俙`,
        resizeResultMetaLines: [
          `鐩爣灏哄 ${target.width} 脳 ${target.height}`,
          `閫傞厤鏂瑰紡 ${selections.fit}`,
        ],
        resizeBeforeWidth: imageInput.width,
        resizeBeforeHeight: imageInput.height,
        resizeAfterWidth: target.width,
        resizeAfterHeight: target.height,
      });

      this.updateProcessingProgress(84, "姝ｅ湪淇濆瓨缁撴灉...");
      const taskResult = await this.createImageTask({
        inputName: "鍘熷浘",
        outputName: `鏀瑰昂瀵哥粨鏋?${exportFormat}`,
        sourcePath: imageInput.path,
        outputPath: tempFile.tempFilePath,
        beforeBytes: imageInput.size,
        afterBytes: fileInfo ? fileInfo.size : null,
        resultHeadline: "鍥剧墖灏哄璋冩暣宸插畬鎴?",
        resultDetail: `宸叉寜 ${selections.size} 鍜屸€?{selections.fit}鈥濆鍑猴紝鍙户缁敤浜庢捣鎶ャ€佺ぞ濯掓垨鍟嗗搧鍥俱€俙`,
        metaLines: [
          `鐩爣灏哄 ${target.width} 脳 ${target.height}`,
          `閫傞厤鏂瑰紡 ${selections.fit}`,
        ],
      }, { skipToast: true });

      if (taskResult.remoteFile) {
        this.setData({
          resizeResultRemoteUrl: taskResult.remoteFile.url,
        });
      }
      this.updateProcessingProgress(100, "璋冩暣瀹屾垚");

    } catch (error) {
      this.setData({
        isWorking: false,
        showProcessingOverlay: false,
      });
      wx.showToast({
        title: "澶勭悊澶辫触锛岃閲嶈瘯",
        icon: "none",
      });
    }
  },

  // 涓囪兘鍘嬬缉澶勭悊
  async runUniversalCompress() {
    const { tool, selections, imageInput, backendFiles } = this.data;

    // 妫€鏌ユ枃浠惰緭鍏?
    let inputFile = null;
    let fileType = "";
    let fileName = "";
    let beforeBytes = 0;

    // 浼樺厛妫€鏌ュ浘鐗囪緭鍏?
    if (imageInput) {
      inputFile = imageInput;
      fileType = "image";
      fileName = imageInput.path.split('/').pop() || "image.jpg";
      beforeBytes = imageInput.size || 0;
    }
    // 鍏舵妫€鏌ュ悗绔枃浠惰緭鍏?
    else if (backendFiles.length > 0) {
      inputFile = backendFiles[0];
      fileName = inputFile.name || "file";
      beforeBytes = inputFile.size || 0;

      // 鏍规嵁鎵╁睍鍚嶅垽鏂枃浠剁被鍨?
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
        // 鍏朵粬鏂囦欢绫诲瀷
        fileType = "file";
      }
    }

    if (!inputFile) {
      wx.showToast({
        title: "璇峰厛閫夋嫨鏂囦欢",
        icon: "none",
      });
      return;
    }

    try {
      let response = null;
      let resultPath = "";
      let resultRemoteUrl = "";
      let useResult = false;

      // 浼樺厛灏濊瘯浣跨敤閫氱敤鏂囦欢鍘嬬缉API
      try {
        response = await this.processFileCompress(inputFile, selections, fileType);
        resultPath = response.path;
        resultRemoteUrl = response.remoteUrl || "";
        useResult = true;
        this.updateProcessingProgress(96, "姝ｅ湪鐢熸垚瀵规瘮...");
      } catch (error) {
        console.error("鏂囦欢鍘嬬缉澶辫触:", error);
        useResult = false;
        response = {
          path: inputFile.path,
          remoteUrl: "",
          name: inputFile.name || "鍘嬬缉缁撴灉",
          afterBytes: inputFile.size || 0,
        };
        resultPath = inputFile.path;

        // 鏇村弸濂界殑閿欒鎻愮ず
        const errorMsg = error.message || error.errMsg || "";
        if (errorMsg.includes("閰嶇疆") || errorMsg.includes("BACKEND_NOT_CONFIGURED")) {
          wx.showModal({
            title: "闇€瑕侀厤缃悗绔湇鍔?",
            content: "鍘嬬缉鍔熻兘闇€瑕佸悗绔湇鍔℃敮鎸侊紝璇峰厛鍦ㄨ缃腑閰嶇疆鍚庣鏈嶅姟鍦板潃銆?",
            showCancel: false,
          });
        } else if (errorMsg.includes("涓嬭浇")) {
          wx.showModal({
            title: "涓嬭浇澶辫触",
            content: `鏂囦欢涓嬭浇澶辫触锛岃妫€鏌ョ綉缁滆繛鎺ユ垨鍚庣鏈嶅姟銆俓n閿欒淇℃伅: ${errorMsg}`,
            showCancel: false,
          });
        } else {
          wx.showModal({
            title: "鍘嬬缉澶辫触",
            content: `澶勭悊杩囩▼涓嚭閿欙紝璇烽噸璇曟垨妫€鏌ュ悗绔湇鍔°€俓n閿欒淇℃伅: ${errorMsg}`,
            showCancel: false,
          });
        }
      }

      // 璁＄畻鍘嬬缉姣斾緥
      const afterBytes = response.afterBytes || 0;
      const savedBytes = Math.max(beforeBytes - afterBytes, 0);
      const savedPercent = beforeBytes > 0 ? Math.round((savedBytes / beforeBytes) * 100) : 0;
      const hasSavings = useResult && savedBytes > 0;

      // 鏇存柊缁撴灉
      this.setData({
        universalCompressResultReady: true,
        universalCompressResultPath: resultPath,
        universalCompressResultRemoteUrl: resultRemoteUrl,
        universalCompressResultName: response.name || "鍘嬬缉缁撴灉",
        universalCompressResultHeadline: hasSavings ? "鍘嬬缉鎴愬姛锛? : "鏂囦欢浣撶Н鏈彉灏?,
        universalCompressResultDetail: hasSavings ? "宸叉寜鐓с€? + selections.mode + "銆嶇瓥鐣ュ畬鎴愬帇缂┿€? : (response.note || "褰撳墠鏂囦欢鏈彂鐜板彲杩涗竴姝ュ帇缂╃殑绌洪棿銆?)",
        universalCompressResultBeforeSizeText: formatFileSize(beforeBytes),
        universalCompressResultAfterSizeText: formatFileSize(afterBytes),
        universalCompressResultSavedText: hasSavings ? "鑺傜渷 " + formatFileSize(savedBytes) + " (" + savedPercent + "%)" : "鏈妭鐪佷綋绉?",
        universalCompressResultMetaLines: [],
        universalCompressFileType: fileType,
      });

      // 浠呭湪鍚庣澶勭悊鎴愬姛鏃跺垱寤轰换鍔¤褰曪紝璁板綍閲屽尯鍒嗘槸鍚︾湡鐨勫彉灏?      if (useResult) {
        await this.createImageTask({
          inputName: fileName,
          outputName: response.name || "鍘嬬缉缁撴灉",
          sourcePath: fileType === "image" ? inputFile.path : "",
          outputPath: resultPath,
          remoteUrl: resultRemoteUrl,
          beforeBytes,
          afterBytes,
          resultHeadline: hasSavings ? "鍘嬬缉鎴愬姛锛? : "鏂囦欢浣撶Н鏈彉灏?,
          resultDetail: hasSavings ? "宸叉寜鐓с€? + selections.mode + "銆嶇瓥鐣ュ畬鎴愬帇缂┿€? : (response.note || "褰撳墠鏂囦欢鏈彂鐜板彲杩涗竴姝ュ帇缂╃殑绌洪棿銆?)",
          metaLines: [],
        }, { skipToast: true });
      }

      this.updateProcessingProgress(100, "澶勭悊瀹屾垚");
    } catch (error) {
      console.error("涓囪兘鍘嬬缉澶辫触:", error);
      this.setData({
        isWorking: false,
        showProcessingOverlay: false,
      });
      wx.showToast({
        title: "鍘嬬缉澶辫触锛岃閲嶈瘯",
        icon: "none",
      });
    }
  },

  // 澶勭悊閫氱敤鏂囦欢鍘嬬缉
  async processFileCompress(file, selections, fileType) {
    // 璋冪敤鍚庣閫氱敤鏂囦欢鍘嬬缉API
    this.updateProcessingProgress(12, "姝ｅ湪璇诲彇鏂囦欢...");
    const packedFile = await packLocalFile(file);
    packedFile.name = packedFile.name || getFileName(file.path) || "鍘嬬缉缁撴灉";
    const response = await this.requestJsonWithProgress("/api/file/compress", {
      file: packedFile,
      mode: selections.mode,
    }, {
      target: 82,
      status: "姝ｅ湪鍘嬬缉鏂囦欢...",
      sizeBytes: file.size || 0,
    });

    console.log("鍘嬬缉API杩斿洖缁撴灉:", response);
    this.updateProcessingProgress(84, "姝ｅ湪鍙栧洖缁撴灉...");

    // 濡傛灉娌℃湁file.url锛屾鏌ユ槸鍚︽湁externalUrl鎴栧叾浠栧瓧娈?
    let downloadUrl = response.file.fallbackUrl || response.file.url || response.file.externalUrl || "";

    console.log("灏濊瘯涓嬭浇鐨刄RL:", downloadUrl);

    if (!downloadUrl) {
      throw new Error("涓嬭浇URL涓虹┖锛岃妫€鏌ュ悗绔瓨鍌ㄩ厤缃?)";
    }

    // 涓嬭浇缁撴灉鏂囦欢
    const downloadRes = await new Promise((resolve, reject) => {
      const task = wx.downloadFile({
        url: downloadUrl,
        success: (res) => {
          console.log("涓嬭浇鍝嶅簲:", res);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res);
          } else {
            reject(new Error(`涓嬭浇澶辫触: HTTP ${res.statusCode}`));
          }
        },
        fail: (err) => {
          console.error("涓嬭浇澶辫触:", err);
          reject(new Error(`涓嬭浇澶辫触: ${err.errMsg || err.message}`));
        },
      });
      if (task && task.onProgressUpdate) {
        task.onProgressUpdate((progress) => {
          const percent = Number(progress.progress || 0);
          this.updateProcessingDisplayProgress(84 + Math.round(percent * 0.08), "姝ｅ湪涓嬭浇缁撴灉...");
        });
      }
    });
    this.updateProcessingProgress(92, "姝ｅ湪鏁寸悊缁撴灉...");

    return {
      path: downloadRes.tempFilePath,
      remoteUrl: downloadUrl,
      name: response.file.name || "鍘嬬缉缁撴灉",
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
        title: "鍏堣緭鍏ラ摼鎺ユ垨鏂囨湰",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(18, "姝ｅ湪缂栫爜鍐呭...");
    const qr = qrcode(0, qrLogoInput ? "H" : "M");
    qr.addData(content);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const marginMap = {
      鏍囧噯: 4,
      绱у噾: 2,
      鐣欑櫧鍏呰冻: 6,
    };

    const colorMap = {
      绠€娲侀粦鐧? "#111111",
      鍝佺墝缁? "#1d5c4b",
      鏆栬壊璋? "#8f6f4f",
    };

    const cellSize = 8;
    const margin = marginMap[selections.margin] || 4;
    const size = (moduleCount + margin * 2) * cellSize;
    const fillColor = colorMap[selections.style] || "#111111";

    this.updateProcessingProgress(46, "姝ｅ湪缁樺埗浜岀淮鐮?..");
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

    this.updateProcessingProgress(72, "姝ｅ湪瀵煎嚭鍥剧墖...");
    const fileInfo = await getFileInfo(tempFile.tempFilePath);
    this.updateProcessingProgress(86, "姝ｅ湪淇濆瓨缁撴灉...");
    const remoteFile = await this.uploadGeneratedOutput(tempFile.tempFilePath, {
      name: "浜岀淮鐮?png",
      folder: "client-outputs/qr-maker",
      contentType: "image/png",
      extension: "png",
      baseName: "qr-code",
    });
    const result = createTask(tool, selections, {
      instant: true,
      resultType: "image",
      inputName: "浜岀淮鐮佸唴瀹?",
      outputName: "浜岀淮鐮?png",
      outputPath: tempFile.tempFilePath,
      remoteUrl: remoteFile ? remoteFile.url : "",
      afterBytes: fileInfo ? fileInfo.size : null,
      resultHeadline: "浜岀淮鐮佸凡鐢熸垚",
      resultDetail: "宸茬敓鎴愬彲淇濆瓨鍥剧墖锛岄€傚悎鏀捐繘娴锋姤銆佺墿鏂欏拰鍒嗕韩椤点€?",
      copyText: content,
      resultText: content,
      metaLines: [
        `椋庢牸 ${selections.style}`,
        `杈硅窛 ${selections.margin}`,
        `Logo ${qrLogoInput ? "宸蹭笂浼? : "鏈娇鐢?}`,
        remoteFile ? `浜戠瀛樺偍 ${remoteFile.provider === "qiniu" ? "涓冪墰浜? : "鍚庣"}` : "浜戠瀛樺偍 寰呭悓姝?,
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
    this.updateProcessingProgress(100, "鐢熸垚瀹屾垚");
  },

  async runUnitConvert() {
    const { tool, selections, numberInput, fromUnit, toUnit } = this.data;
    this.updateProcessingProgress(32, "姝ｅ湪璁＄畻...");
    const conversion = convertValue({
      group: selections.group,
      value: numberInput,
      fromUnit,
      toUnit,
      precisionLabel: selections.precision,
    });

    if (!conversion) {
      wx.showToast({
        title: "璇疯緭鍏ユ湁鏁堟暟鍊?",
        icon: "none",
      });
      return;
    }

    this.updateProcessingProgress(78, "姝ｅ湪淇濆瓨缁撴灉...");
    const result = createTask(tool, selections, {
      instant: true,
      resultType: "text",
      inputName: `${numberInput} ${fromUnit}`,
      outputName: "鎹㈢畻缁撴灉",
      resultHeadline: "鍗曚綅鎹㈢畻宸插畬鎴?",
      resultDetail: conversion.text,
      resultText: conversion.text,
      copyText: conversion.text,
      metaLines: [
        `绫诲瀷 ${selections.group}`,
        `绮惧害 ${selections.precision}`,
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
    this.updateProcessingProgress(100, "鎹㈢畻瀹屾垚");
  },

  async runImageToPdf() {
    const { tool, selections, imageInputs } = this.data;
    if (!imageInputs.length) {
      wx.showToast({
        title: "鍏堥€夋嫨鑷冲皯涓€寮犲浘鐗?",
        icon: "none",
      });
      return;
    }

    const pdfDoc = await PDFDocument.create();
    const pageSizeMap = {
      A4: { width: 595, height: 842 },
      A5: { width: 420, height: 595 },
      鍘熷浘鑷€傚簲: null,
    };

    const paperSize = pageSizeMap[selections.paper];
    const margin = selections.layout === "鐣欑櫧鐗堝紡" ? 28 : 12;

    this.updateProcessingProgress(14, "姝ｅ湪璇诲彇鍥剧墖...");
    for (let index = 0; index < imageInputs.length; index += 1) {
      const imageItem = imageInputs[index];
      const bytes = await readFileArrayBuffer(imageItem.path);
      const embeddedImage = imageItem.extension === "png"
        ? await pdfDoc.embedPng(bytes)
        : await pdfDoc.embedJpg(bytes);

      const imageWidth = embeddedImage.width;
      const imageHeight = embeddedImage.height;

      if (!paperSize || selections.paper === "鍘熷浘鑷€傚簲") {
        const page = pdfDoc.addPage([imageWidth, imageHeight]);
        page.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: imageWidth,
          height: imageHeight,
        });
      } else if (selections.layout === "涓ゅ浘鎷奸〉") {
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
      this.updateProcessingProgress(14 + Math.round(((index + 1) / imageInputs.length) * 54), "姝ｅ湪鎺掔増鍥剧墖...");
    }

    this.updateProcessingProgress(76, "姝ｅ湪鐢熸垚 PDF...");
    const pdfBytes = await pdfDoc.save();
    const outputPath = `${wx.env.USER_DATA_PATH}/image-to-pdf-${Date.now()}.pdf`;
    await writeArrayBufferFile(outputPath, pdfBytes);
    const fileInfo = await getFileInfo(outputPath);
    this.updateProcessingProgress(88, "姝ｅ湪淇濆瓨缁撴灉...");
    const remoteFile = await this.uploadGeneratedOutput(outputPath, {
      name: "鍥剧墖鍚堥泦.pdf",
      folder: "client-outputs/image-to-pdf",
      contentType: "application/pdf",
      extension: "pdf",
      baseName: "image-to-pdf",
    });
    const totalInputSize = imageInputs.reduce((sum, item) => sum + (item.size || 0), 0);
    const result = createTask(tool, selections, {
      instant: true,
      resultType: "document",
      inputName: `${imageInputs.length} 寮犲浘鐗嘸`,
      outputName: "鍥剧墖鍚堥泦.pdf",
      outputPath,
      remoteUrl: remoteFile ? remoteFile.url : "",
      beforeBytes: totalInputSize,
      afterBytes: fileInfo ? fileInfo.size : null,
      resultHeadline: "鍥剧墖杞?PDF 宸插畬鎴?",
      resultDetail: `宸叉妸 ${imageInputs.length} 寮犲浘鐗囨暣鐞嗘垚鍗曚釜 PDF锛屽彲鐩存帴鎵撳紑鏌ョ湅銆俙`,
      metaLines: [
        `绾稿紶 ${selections.paper}`,
        `甯冨眬 ${selections.layout}`,
        remoteFile ? `浜戠瀛樺偍 ${remoteFile.provider === "qiniu" ? "涓冪墰浜? : "鍚庣"}` : "浜戠瀛樺偍 寰呭悓姝?,
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
    this.updateProcessingProgress(100, "鐢熸垚瀹屾垚");
  },
});
