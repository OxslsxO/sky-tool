const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const sharp = require("sharp");

let ort = null;

try {
  ort = require("onnxruntime-node");
} catch (error) {
  ort = null;
}

const PHOTO_SIZE_MAP = {
  "一寸": {
    width: 295,
    height: 413,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "二寸": {
    width: 413,
    height: 579,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "考试报名": {
    width: 413,
    height: 579,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "签证": {
    width: 354,
    height: 472,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "一寸": {
    width: 295,
    height: 413,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "二寸": {
    width: 413,
    height: 579,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "考试报名": {
    width: 413,
    height: 579,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
  "签证": {
    width: 354,
    height: 472,
    maxWidthRatio: 0.99,
    maxHeightRatio: 0.97,
    bottomInset: 0,
  },
};

const BACKGROUND_COLOR_MAP = {
  "白底": "#ffffff",
  "白色": "#ffffff",
  "白": "#ffffff",
  "蓝底": "#2d6ec9",
  "蓝色": "#2d6ec9",
  "蓝": "#2d6ec9",
  "红底": "#cf5446",
  "红色": "#cf5446",
  "红": "#cf5446",
  "纯白": "#ffffff",
  "淡蓝": "#87ceeb",
  "天蓝": "#2d6ec9",
  "藏蓝": "#1e3a5f",
  "大红": "#cf5446",
  "酒红": "#8b0000",
  "浅灰": "#d3d3d3",
  "淡粉": "#ffb6c1",
  "淡绿": "#90ee90",
  "纯白": "#ffffff",
  "淡蓝": "#87ceeb",
  "天蓝": "#2d6ec9",
  "藏蓝": "#1e3a5f",
  "大红": "#cf5446",
  "酒红": "#8b0000",
  "浅灰": "#d3d3d3",
  "淡粉": "#ffb6c1",
  "淡绿": "#90ee90",
};

const MODEL_CANDIDATES = [{
  key: "birefnet-portrait",
  url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-portrait-epoch_150.onnx",
  fileName: "BiRefNet-portrait-epoch_150.onnx",
  inputSize: 1024,
}];
const MODEL_MEAN = [0.485, 0.456, 0.406];
const MODEL_STD = [0.229, 0.224, 0.225];
const OPAQUE_BOUNDS_THRESHOLD = 40;

const sessionPromises = new Map();
const sessionCache = new Map();

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function shouldUseImglyBackgroundRemoval() {
  // 默认禁用 IMG.LY 方案，因为在部署环境中容易卡死
  const segmenter = String(process.env.PHOTO_ID_SEGMENTER || "onnx").toLowerCase();
  return (
    isTruthyEnv(process.env.PHOTO_ID_ENABLE_IMGLY) &&
    !["legacy", "uniform", "onnx"].includes(segmenter)
  );
}

function getPhotoSpec(sizeLabel) {
  return PHOTO_SIZE_MAP[sizeLabel] || PHOTO_SIZE_MAP["考试报名"];
}

function getBackgroundColor(backgroundLabel) {
  return BACKGROUND_COLOR_MAP[backgroundLabel] || "#ffffff";
}

function getRetouchProfile(label) {
  const map = {
    "自然": { brightness: 1, saturation: 1, sharpen: false, contrast: 1 },
    "轻修": { brightness: 1.01, saturation: 1.02, sharpen: true, contrast: 1.02 },
    "标准": { brightness: 1.02, saturation: 1.04, sharpen: true, contrast: 1.04 },
  };

  return map[label] || map["自然"];
}

async function ensureModelFile(modelsDir, model) {
  // 首先检查项目中的模型文件
  const projectModelPath = path.join(__dirname, "..", "storage", "models", model.fileName);
  console.log(`[photo-id] ensureModelFile: 检查项目模型 ${projectModelPath}`);
  if (fs.existsSync(projectModelPath)) {
    console.log(`[photo-id] ensureModelFile: 使用项目中的模型 ${projectModelPath}`);
    return projectModelPath;
  }

  // 然后检查运行时目录
  const modelPath = path.join(modelsDir, model.fileName);
  console.log(`[photo-id] ensureModelFile: 检查运行时模型 ${modelPath}`);
  if (fs.existsSync(modelPath)) {
    console.log(`[photo-id] ensureModelFile: 使用运行时模型 ${modelPath}`);
    return modelPath;
  }

  // 如果项目模型目录有其他模型，尝试使用它们
  const projectModelsDir = path.join(__dirname, "..", "storage", "models");
  if (fs.existsSync(projectModelsDir)) {
    const files = fs.readdirSync(projectModelsDir);
    if (files.length > 0) {
      const fallbackPath = path.join(projectModelsDir, files[0]);
      console.log(`[photo-id] ensureModelFile: 使用备用模型 ${fallbackPath}`);
      return fallbackPath;
    }
  }

  // 尝试下载（带超时）
  console.log(`[photo-id] ensureModelFile: 模型不存在，尝试下载 ${model.url}`);
  fs.mkdirSync(modelsDir, { recursive: true });

  try {
    const downloadTimeout = 180000; // 3分钟超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), downloadTimeout);

    const response = await fetch(model.url, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = new Error(`Failed to download photo-id model ${model.key}: ${response.status}`);
      error.code = "PHOTO_ID_MODEL_DOWNLOAD_FAILED";
      throw error;
    }

    const tempPath = `${modelPath}.download`;
    if (!response.body) {
      const error = new Error(`Failed to download photo-id model ${model.key}: empty response body`);
      error.code = "PHOTO_ID_MODEL_DOWNLOAD_FAILED";
      throw error;
    }

    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
    fs.renameSync(tempPath, modelPath);
    console.log(`[photo-id] ensureModelFile: 模型下载成功 ${modelPath}`);
    return modelPath;
  } catch (downloadError) {
    console.error(`[photo-id] ensureModelFile: 下载失败`, downloadError);
    // 再次尝试查找项目目录中的任何模型
    if (fs.existsSync(projectModelsDir)) {
      const files = fs.readdirSync(projectModelsDir);
      if (files.length > 0) {
        const fallbackPath = path.join(projectModelsDir, files[0]);
        console.log(`[photo-id] ensureModelFile: 使用备用模型 ${fallbackPath}`);
        return fallbackPath;
      }
    }
    throw downloadError;
  }
}

async function getSession(config) {
  console.log("[photo-id] getSession: 开始");
  if (!ort) {
    console.log("[photo-id] getSession: onnxruntime-node 不可用");
    return null;
  }

  if (process.env.PHOTO_ID_DISABLE_MODEL === 'true') {
    console.log("[photo-id] getSession: 模型被环境变量禁用");
    return null;
  }

  // 🔥 强制清空旧缓存，优先加载新模型
  sessionCache.clear();

  const projectModelsDir = path.join(__dirname, "..", "storage", "models");
  let modelsDir = fs.existsSync(projectModelsDir) && fs.readdirSync(projectModelsDir).length > 0 
    ? projectModelsDir 
    : path.join(config.tempDir, "..", "models");

  // 🔥 强制只尝试 BiRefNet 模型（排除u2net干扰）
  const biRefModel = MODEL_CANDIDATES[0];
  console.log(`[photo-id] getSession: 强制尝试 BiRefNet 模型 ${biRefModel.key}`);

  try {
    const modelPath = await ensureModelFile(modelsDir, biRefModel);
    console.log(`[photo-id] getSession: 模型文件就绪 ${modelPath}`);

    const sessionOptions = {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all', // 🔥 开启全优化，提升大模型推理稳定性
    };
    
    const sessionCreatePromise = ort.InferenceSession.create(modelPath, sessionOptions);
    const timeoutPromise = new Promise((_, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("Model loading timeout")), 120000);
      timeoutId.unref?.();
      sessionCreatePromise.finally(() => clearTimeout(timeoutId));
    });

    const session = await Promise.race([sessionCreatePromise, timeoutPromise]);
    console.log(`[photo-id] getSession: 会话创建成功 ${biRefModel.key}`);

    const sessionResult = { session, model: biRefModel };
    sessionCache.set(biRefModel.key, sessionResult);

    return sessionResult;
  } catch (error) {
    console.error(`[photo-id] getSession: BiRefNet 加载失败`, error.message || error);
    console.warn(`[photo-id] getSession: 模型加载失败，直接返回 null`);
    return null;
  }
}

function getSessionInputNames(session) {
  return session.inputNames || (session.handler && session.handler.inputNames) || [];
}

function getSessionOutputNames(session) {
  return session.outputNames || (session.handler && session.handler.outputNames) || [];
}

function getMetadataEntry(metadataSource, name) {
  if (!metadataSource) {
    return null;
  }

  if (Array.isArray(metadataSource)) {
    return metadataSource.find((item) => item && item.name === name) || metadataSource[0] || null;
  }

  return metadataSource[name] || null;
}

function getInputShape(session, model) {
  const inputNames = getSessionInputNames(session);
  const inputName = inputNames[0];
  const metadata =
    getMetadataEntry(session.inputMetadata, inputName) ||
    getMetadataEntry(session.handler && session.handler.inputMetadata, inputName);
  const dimensions =
    (metadata && Array.isArray(metadata.dimensions) && metadata.dimensions) ||
    (metadata && Array.isArray(metadata.shape) && metadata.shape) ||
    null;

  if (!metadata || !Array.isArray(dimensions) || dimensions.length !== 4) {
    if (model && model.inputSize) {
      return {
        inputName,
        width: model.inputSize,
        height: model.inputSize,
      };
    }

    const error = new Error("Photo-id model input metadata is invalid");
    error.code = "PHOTO_ID_MODEL_INPUT_INVALID";
    throw error;
  }

  const [, , height, width] = dimensions;
  if (!height || !width) {
    const error = new Error("Photo-id model dimensions are missing");
    error.code = "PHOTO_ID_MODEL_INPUT_INVALID";
    throw error;
  }

  return {
    inputName,
    width,
    height,
  };
}

async function normalizeImageForModel(session, model, inputBuffer) {
  const { width, height } = getInputShape(session, model);
  const { data, info } = await sharp(inputBuffer)
    .removeAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = new Float32Array(3 * info.width * info.height);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixelOffset = (y * info.width + x) * info.channels;
      const hwOffset = y * info.width + x;

      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[pixelOffset + channel] / 255;
        tensor[channel * info.width * info.height + hwOffset] =
          (value - MODEL_MEAN[channel]) / MODEL_STD[channel];
      }
    }
  }

  return new ort.Tensor("float32", tensor, [1, 3, info.height, info.width]);
}

function getPrimaryOutputTensor(session, result) {
  const outputNames = getSessionOutputNames(session);
  for (let index = 0; index < outputNames.length; index += 1) {
    const tensor = result[outputNames[index]];
    if (tensor && Array.isArray(tensor.dims) && tensor.dims.length >= 2) {
      return tensor;
    }
  }

  const error = new Error("Photo-id model output is missing");
  error.code = "PHOTO_ID_MODEL_OUTPUT_INVALID";
  throw error;
}

function buildNormalizedAlpha(source, count) {
  let min = Infinity;
  let max = -Infinity;

  for (let index = 0; index < count; index += 1) {
    const value = source[index];
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }

  const range = Math.max(max - min, 1e-6);
  const alpha = Buffer.alloc(count);
  for (let index = 0; index < count; index += 1) {
    const normalized = (source[index] - min) / range;
    alpha[index] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }

  return alpha;
}

function refineAlphaBuffer(alphaBuffer) {
  const refined = Buffer.from(alphaBuffer);
  for (let i = 0; i < refined.length; i++) {
    const val = refined[i];
    // 仅清除纯背景噪点，保留所有发丝
    refined[i] = val < 5 ? 0 : val;
  }
  return refined;
} 

function smoothstep(edge0, edge1, value) {
  if (value <= edge0) {
    return 0;
  }
  if (value >= edge1) {
    return 1;
  }

  const normalized = (value - edge0) / (edge1 - edge0);
  return normalized * normalized * (3 - 2 * normalized);
}

async function resizeSubjectBuffer(inputBuffer, width, height) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * info.channels;
    const alpha = data[offset + 3] / 255;
    data[offset] = Math.round(data[offset] * alpha);
    data[offset + 1] = Math.round(data[offset + 1] * alpha);
    data[offset + 2] = Math.round(data[offset + 2] * alpha);
  }

  const { data: resized, info: resizedInfo } = await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  })
    .resize(width, height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
      fastShrinkOnLoad: false,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let index = 0; index < resizedInfo.width * resizedInfo.height; index += 1) {
    const offset = index * resizedInfo.channels;
    const alpha = resized[offset + 3] / 255;
    if (alpha <= 0) {
      resized[offset] = 0;
      resized[offset + 1] = 0;
      resized[offset + 2] = 0;
      continue;
    }

    resized[offset] = Math.max(0, Math.min(255, Math.round(resized[offset] / alpha)));
    resized[offset + 1] = Math.max(0, Math.min(255, Math.round(resized[offset + 1] / alpha)));
    resized[offset + 2] = Math.max(0, Math.min(255, Math.round(resized[offset + 2] / alpha)));
  }

  return sharp(resized, {
    raw: {
      width: resizedInfo.width,
      height: resizedInfo.height,
      channels: resizedInfo.channels,
    },
  })
    .png()
    .toBuffer();
}

async function applyAlphaMask(inputBuffer, alphaBuffer, width, height) {
  // 创建 alpha 遮罩 - 保留原始 alpha 值
  const rgbaMask = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    rgbaMask[offset] = 255;
    rgbaMask[offset + 1] = 255;
    rgbaMask[offset + 2] = 255;
    rgbaMask[offset + 3] = alphaBuffer[index];
  }

  const maskImage = await sharp(rgbaMask, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  // 直接应用遮罩
  const maskedBuffer = await sharp(inputBuffer)
    .ensureAlpha()
    .composite([
      {
        input: maskImage,
        blend: "dest-in",
      },
    ])
    .png();

  return sharp(await maskedBuffer.toBuffer());
}

function getEdgeSamplePositions(width, height) {
  const positions = [];
  for (let x = 0; x < width; x += 1) {
    positions.push(x);
    if (height > 1) {
      positions.push((height - 1) * width + x);
    }
  }

  for (let y = 1; y < height - 1; y += 1) {
    positions.push(y * width);
    if (width > 1) {
      positions.push(y * width + (width - 1));
    }
  }

  return positions;
}

function getRgbDistanceSquared(data, offset, color) {
  return (
    (data[offset] - color.red) ** 2 +
    (data[offset + 1] - color.green) ** 2 +
    (data[offset + 2] - color.blue) ** 2
  );
}

function estimateSolidBackground(raw, width, height, channels) {
  const positions = getEdgeSamplePositions(width, height);
  if (!positions.length) {
    return null;
  }

  let red = 0;
  let green = 0;
  let blue = 0;
  let sampleCount = 0;

  for (let index = 0; index < positions.length; index += 1) {
    const offset = positions[index] * channels;
    const alpha = channels > 3 ? raw[offset + 3] : 255;
    if (alpha <= 12) {
      continue;
    }

    red += raw[offset];
    green += raw[offset + 1];
    blue += raw[offset + 2];
    sampleCount += 1;
  }

  if (!sampleCount) {
    return null;
  }

  const color = {
    red: red / sampleCount,
    green: green / sampleCount,
    blue: blue / sampleCount,
  };

  const distances = [];
  for (let index = 0; index < positions.length; index += 1) {
    const offset = positions[index] * channels;
    const alpha = channels > 3 ? raw[offset + 3] : 255;
    if (alpha <= 12) {
      continue;
    }

    distances.push(Math.sqrt(getRgbDistanceSquared(raw, offset, color)));
  }

  distances.sort((left, right) => left - right);
  const percentileIndex = Math.max(0, Math.min(distances.length - 1, Math.floor(distances.length * 0.9)));

  return {
    color,
    average: distances.reduce((sum, item) => sum + item, 0) / distances.length,
    p90: distances[percentileIndex],
    sampleCount,
    brightness: (color.red + color.green + color.blue) / 3,
  };
}

async function estimateInputBackgroundColor(inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const estimate = estimateSolidBackground(data, info.width, info.height, info.channels);
  return estimate ? estimate.color : { red: 255, green: 255, blue: 255 };
}

async function featherSubjectEdges(buffer) {
  return sharp(buffer)
    .blur(0.5) // 极轻模糊，自然过渡
    .png()
    .toBuffer();
}

// 5. 禁用所有暴力颜色修复（防止染背景色）
async function finalEdgeRepairAfterComposite(buffer) {
  return buffer; // 直接返回，不修改
}

async function decontaminateSubjectBuffer(subjectBuffer, backgroundColor) {
  console.log("[photo-id] decontaminateSubjectBuffer: 发丝优化版颜色溢出校正");
  const { data, info } = await sharp(subjectBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const bgR = Math.round(backgroundColor.red);
  const bgG = Math.round(backgroundColor.green);
  const bgB = Math.round(backgroundColor.blue);

  for (let index = 0; index < info.width * info.height; index++) {
    const offset = index * channels;
    const alpha = data[offset + 3] / 255;

    // 完全保留发丝半透明，不修改Alpha值
    if (alpha <= 0.01) {
      data[offset] = data[offset+1] = data[offset+2] = data[offset+3] = 0;
      continue;
    }
    if (alpha >= 0.98) continue;

    // 仅校正颜色，不降低Alpha（核心：保留发丝）
    const r = data[offset], g = data[offset+1], b = data[offset+2];
    const fgR = (r - bgR * (1 - alpha)) / alpha;
    const fgG = (g - bgG * (1 - alpha)) / alpha;
    const fgB = (b - bgB * (1 - alpha)) / alpha;

    // 安全裁剪颜色，不修改Alpha
    data[offset] = Math.max(0, Math.min(255, Math.round(fgR)));
    data[offset+1] = Math.max(0, Math.min(255, Math.round(fgG)));
    data[offset+2] = Math.max(0, Math.min(255, Math.round(fgB)));
  }

  // 轻微柔化，贴合新背景
  const { data: softened } = await sharp(data, {
    raw: { width: info.width, height: info.height, channels },
  }).blur(0.2).raw().toBuffer({ resolveWithObject: true });

  return sharp(softened, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function shouldTreatAsBackground(data, offset, estimate, thresholdSquared) {
  const distanceSquared = getRgbDistanceSquared(data, offset, estimate.color);
  if (distanceSquared <= thresholdSquared) {
    return true;
  }

  const brightness = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
  const relaxedThreshold = thresholdSquared * 1.4;
  return distanceSquared <= relaxedThreshold && brightness >= estimate.brightness - 32;
}

function buildTorsoProtectionMask(data, info, estimate, foregroundThreshold) {
  const pixelCount = info.width * info.height;
  const mask = new Uint8Array(pixelCount);
  const foregroundSquared = foregroundThreshold ** 2;
  const upperLimit = Math.floor(info.height * 0.48);
  let left = info.width;
  let right = -1;
  let top = info.height;
  let bottom = -1;
  let centerSum = 0;
  let weightSum = 0;

  for (let y = 0; y < upperLimit; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const position = y * info.width + x;
      const offset = position * info.channels;
      const alpha = info.channels > 3 ? data[offset + 3] : 255;
      if (alpha <= 12 || getRgbDistanceSquared(data, offset, estimate.color) <= foregroundSquared) {
        continue;
      }

      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      centerSum += x;
      weightSum += 1;
    }
  }

  if (weightSum < Math.max(120, pixelCount * 0.002) || right < left || bottom < top) {
    return mask;
  }

  const headWidth = Math.max(1, right - left + 1);
  const headHeight = Math.max(1, bottom - top + 1);
  const centerX = centerSum / weightSum;
  const similarSampleTop = Math.min(info.height - 1, Math.round(bottom + headHeight * 0.45));
  const similarSampleBottom = Math.min(info.height - 1, Math.round(info.height * 0.9));
  const similarSampleHalfWidth = Math.min(info.width * 0.18, headWidth * 0.55);
  const similarSampleLeft = Math.max(0, Math.floor(centerX - similarSampleHalfWidth));
  const similarSampleRight = Math.min(info.width - 1, Math.ceil(centerX + similarSampleHalfWidth));
  const similarThresholdSquared = foregroundThreshold ** 2;
  let similarSampleCount = 0;
  let similarBackgroundLikeCount = 0;

  for (let y = similarSampleTop; y <= similarSampleBottom; y += 1) {
    for (let x = similarSampleLeft; x <= similarSampleRight; x += 1) {
      similarSampleCount += 1;
      const offset = (y * info.width + x) * info.channels;
      if (getRgbDistanceSquared(data, offset, estimate.color) <= similarThresholdSquared) {
        similarBackgroundLikeCount += 1;
      }
    }
  }

  const similarClothingRisk = similarSampleCount
    ? similarBackgroundLikeCount / similarSampleCount
    : 0;
  if (similarClothingRisk < 0.65) {
    return mask;
  }

  const torsoTop = Math.max(
    0,
    Math.min(info.height - 1, Math.round(bottom + headHeight * 0.32))
  );
  const torsoBottom = info.height - 1;
  const torsoHeight = Math.max(1, torsoBottom - torsoTop + 1);
  const topWidth = Math.min(info.width * 0.3, headWidth * 0.62);
  const bottomWidth = Math.min(info.width * 0.9, headWidth * 2.55);

  for (let y = torsoTop; y <= torsoBottom; y += 1) {
    const progress = (y - torsoTop) / torsoHeight;
    const rowWidth = topWidth + (bottomWidth - topWidth) * Math.pow(progress, 1.4);
    const rowLeft = Math.max(0, Math.floor(centerX - rowWidth / 2));
    const rowRight = Math.min(info.width - 1, Math.ceil(centerX + rowWidth / 2));

    for (let x = rowLeft; x <= rowRight; x += 1) {
      mask[y * info.width + x] = 1;
    }
  }

  return mask;
}

async function removeUniformBackground(inputBuffer) {
  console.log("[photo-id] removeUniformBackground: 开始");
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  console.log("[photo-id] removeUniformBackground: 估计背景");
  const estimate = estimateSolidBackground(data, info.width, info.height, info.channels);
  if (!estimate || estimate.p90 > 42 || estimate.average > 30) {
    console.log("[photo-id] removeUniformBackground: 背景估计不符合条件，跳过");
    return null;
  }
  console.log(`[photo-id] removeUniformBackground: 背景估计完成，p90=${estimate.p90}, average=${estimate.average}`);

  const pixelCount = info.width * info.height;
  const hardBgThreshold = Math.max(12, Math.min(30, Math.round(estimate.p90 + 5)));
  const softBgThreshold = Math.max(20, Math.min(44, Math.round(estimate.p90 + 14)));
  const fgThreshold = Math.max(48, Math.min(88, softBgThreshold + 34));
  const hardBgSquared = hardBgThreshold ** 2;
  const softBgSquared = softBgThreshold ** 2;
  const subjectProtectionMask = buildTorsoProtectionMask(data, info, estimate, fgThreshold);
  const connectedBackground = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= info.width || y >= info.height) {
      return;
    }

    const position = y * info.width + x;
    if (connectedBackground[position] || subjectProtectionMask[position]) {
      return;
    }

    const offset = position * info.channels;
    const alpha = info.channels > 3 ? data[offset + 3] : 255;
    const brightness = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    const distanceSquared = getRgbDistanceSquared(data, offset, estimate.color);

    if (
      alpha <= 12 ||
      (
        distanceSquared <= softBgSquared &&
        brightness >= estimate.brightness - 44
      )
    ) {
      connectedBackground[position] = 1;
      queue[tail] = position;
      tail += 1;
    }
  };

  console.log("[photo-id] removeUniformBackground: 开始广度优先搜索");
  for (let x = 0; x < info.width; x += 1) {
    push(x, 0);
    push(x, info.height - 1);
  }

  for (let y = 1; y < info.height - 1; y += 1) {
    push(0, y);
    push(info.width - 1, y);
  }

  while (head < tail) {
    const position = queue[head];
    head += 1;
    const x = position % info.width;
    const y = (position - x) / info.width;

    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  console.log(`[photo-id] removeUniformBackground: BFS 完成，处理了 ${tail} 个像素`);

  const lowerCenterStartX = Math.floor(info.width * 0.32);
  const lowerCenterEndX = Math.ceil(info.width * 0.68);
  const lowerCenterStartY = Math.floor(info.height * 0.45);
  const lowerCenterEndY = Math.ceil(info.height * 0.92);
  let lowerCenterPixels = 0;
  let lowerCenterBackgroundPixels = 0;
  for (let y = lowerCenterStartY; y < lowerCenterEndY; y += 1) {
    for (let x = lowerCenterStartX; x < lowerCenterEndX; x += 1) {
      lowerCenterPixels += 1;
      if (connectedBackground[y * info.width + x]) {
        lowerCenterBackgroundPixels += 1;
      }
    }
  }

  const lowerCenterBackgroundRatio = lowerCenterPixels
    ? lowerCenterBackgroundPixels / lowerCenterPixels
    : 0;
  if (lowerCenterBackgroundRatio > 0.35) {
    console.log(
      `[photo-id] removeUniformBackground: 背景侵入衣服区域 ${(lowerCenterBackgroundRatio * 100).toFixed(1)}%，改用模型抠图`
    );
    return null;
  }

  console.log("[photo-id] removeUniformBackground: 计算 alpha 遮罩");
  let backgroundCount = 0;
  const alpha = Buffer.alloc(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * info.channels;
    const distance = Math.sqrt(getRgbDistanceSquared(data, offset, estimate.color));
    const brightness = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
    const brightnessDelta = Math.abs(brightness - estimate.brightness);
    const likelyBackground =
      connectedBackground[index] &&
      distance <= softBgThreshold &&
      brightness >= estimate.brightness - 44;

    if (likelyBackground) {
      backgroundCount += 1;
    }

    let matte = 1;
    if (connectedBackground[index]) {
      matte = smoothstep(hardBgThreshold, fgThreshold, distance);
    }

    alpha[index] = Math.max(0, Math.min(255, Math.round(matte * 255)));
  }

  const backgroundRatio = backgroundCount / pixelCount;
  console.log(`[photo-id] removeUniformBackground: 背景比例 ${backgroundRatio.toFixed(2)}`);
  if (backgroundRatio < 0.1 || backgroundRatio > 0.94) {
    console.log("[photo-id] removeUniformBackground: 背景比例不符合条件，跳过");
    return null;
  }

  console.log("[photo-id] removeUniformBackground: 应用 alpha 遮罩");
  const softenedAlpha = await sharp(refineAlphaBuffer(alpha), {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1,
    },
  })
    .blur(0.9)
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const result = await applyAlphaMask(inputBuffer, softenedAlpha, info.width, info.height);
  console.log("[photo-id] removeUniformBackground: 完成");
  return result;
}

async function removeBackgroundWithModel(config, inputBuffer) {
  console.log("[photo-id] removeBackgroundWithModel: 开始（BiRefNet专用版）");
  
  let sourceMetadata;
  try {
    sourceMetadata = await sharp(inputBuffer).metadata();
  } catch (error) {
    console.warn("[photo-id] removeBackgroundWithModel: 获取元数据失败", error);
    return null;
  }
  
  // 🔥 降低输入图片尺寸，避免BiRefNet推理超时
  let workBuffer = inputBuffer;
  const MAX_SIZE = 1024; // 和BiRefNet输入尺寸一致
  if (sourceMetadata.width > MAX_SIZE || sourceMetadata.height > MAX_SIZE) {
    console.log(`[photo-id] 图片尺寸过大，缩小到 ${MAX_SIZE}px`);
    workBuffer = await sharp(inputBuffer)
      .resize({ width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();
  }
  
  const sessionBundle = await getSession(config);
  if (!sessionBundle) {
    console.warn("[photo-id] removeBackgroundWithModel: 模型会话不可用");
    return null;
  }
  console.log("[photo-id] removeBackgroundWithModel: 会话获取成功");

  const { session, model } = sessionBundle;
  
  let tensor;
  try {
    console.log("[photo-id] 开始图像标准化（BiRefNet专用）");
    tensor = await normalizeImageForModel(session, model, workBuffer);
  } catch (error) {
    console.error("[photo-id] 图像标准化失败", error);
    return null;
  }

  console.log("[photo-id] 运行模型推理（超时120秒）");
  let result;
  try {
    const runPromise = session.run({ [getInputShape(session, model).inputName]: tensor });
    const timeoutPromise = new Promise((_, reject) => {
      const timeoutId = setTimeout(() => reject(new Error("Model inference timeout")), 120000);
      timeoutId.unref?.();
      runPromise.finally(() => clearTimeout(timeoutId));
    });

    result = await Promise.race([runPromise, timeoutPromise]);
    console.log("[photo-id] 模型推理完成");
  } catch (error) {
    console.error("[photo-id] 模型推理失败", error);
    return null;
  }

  const outputTensor = getPrimaryOutputTensor(session, result);
  const dimensions = outputTensor.dims || [];
  const maskHeight = dimensions[dimensions.length - 2];
  const maskWidth = dimensions[dimensions.length - 1];

  if (!maskHeight || !maskWidth) {
    console.error("[photo-id] 模型输出尺寸无效");
    return null;
  }
  console.log(`[photo-id] 掩码尺寸 ${maskWidth}x${maskHeight}`);

  // 🔥 优化：BiRefNet的掩码处理，保留发丝半透明
  const alpha = buildNormalizedAlpha(outputTensor.data, maskWidth * maskHeight);
  const refinedAlpha = refineAlphaBuffer(alpha);

  const workMetadata = await sharp(workBuffer).metadata();
  const workAlpha = await sharp(refinedAlpha, {
    raw: { width: maskWidth, height: maskHeight, channels: 1 },
  })
    .resize(workMetadata.width, workMetadata.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  console.log("[photo-id] 应用Alpha遮罩");
  const workResult = await applyAlphaMask(workBuffer, workAlpha, workMetadata.width, workMetadata.height);
  
  return workResult;
}

function runImglyWorker(inputPath, outputPath) {
  const workerPath = path.join(__dirname, "..", "imgly-background-worker.js");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, inputPath, outputPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    
    // 大幅减少超时时间，从120秒改为30秒
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error("IMG.LY background removal timed out");
      error.code = "PHOTO_ID_IMGLY_TIMEOUT";
      reject(error);
    }, 30000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const error = new Error(stderr.trim() || `IMG.LY worker exited with code ${code}`);
      error.code = "PHOTO_ID_IMGLY_FAILED";
      reject(error);
    });
  });
}

async function removeBackgroundWithImgly(config, inputBuffer) {
  if (!shouldUseImglyBackgroundRemoval()) {
    return null;
  }

  const tempRoot = config && config.tempDir ? config.tempDir : path.join(__dirname, "..", "storage", "temp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tempRoot, "imgly-"));
  const inputPath = path.join(workDir, "input.png");
  const outputPath = path.join(workDir, "output.png");
  console.log("[photo-id] removeBackgroundWithImgly: start");

  try {
    fs.writeFileSync(inputPath, await sharp(inputBuffer).png().toBuffer());
    await runImglyWorker(inputPath, outputPath);
    const transparentBuffer = fs.readFileSync(outputPath);
    console.log("[photo-id] removeBackgroundWithImgly: done");
    return sharp(transparentBuffer).ensureAlpha();
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// 新增：基于新背景色的边缘净化 - 安全保守版本
async function finalEdgeCleanup(subjectBuffer, newBackgroundColor, sourceBgRgb) {
  console.log("[photo-id] finalEdgeCleanup: 发丝友好版边缘净化");
  const { data, info } = await sharp(subjectBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width, height = info.height, channels = info.channels;
  const srcR = Math.round(sourceBgRgb?.red || sourceBgRgb?.r || 255);
  const srcG = Math.round(sourceBgRgb?.green || sourceBgRgb?.g || 255);
  const srcB = Math.round(sourceBgRgb?.blue || sourceBgRgb?.b || 255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const alpha = data[idx + 3];

      // 👉 优化：仅清除纯背景残留，不碰发丝
      if (alpha <= 0 || alpha >= 200) continue;

      const r = data[idx], g = data[idx+1], b = data[idx+2];
      const distToSrcBg = Math.sqrt((r-srcR)**2 + (g-srcG)**2 + (b-srcB)**2);

      // 仅清除**紧贴背景的残留**，发丝区域跳过
      if (distToSrcBg < 40) {
        data[idx + 3] = Math.max(0, alpha - 30); // 温和降低透明度
      }
    }
  }

  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
async function findOpaqueBounds(image) {
  try {
    const { data, info } = await image
      .clone()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let top = info.height;
    let left = info.width;
    let right = -1;
    let bottom = -1;

    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * info.channels + 3];
        if (alpha <= OPAQUE_BOUNDS_THRESHOLD) {
          continue;
        }

        if (x < left) {
          left = x;
        }
        if (x > right) {
          right = x;
        }
        if (y < top) {
          top = y;
        }
        if (y > bottom) {
          bottom = y;
        }
      }
    }

    if (right < left || bottom < top) {
      // 如果找不到透明区域，使用整个图像
      console.warn("[photo-id] 未找到明确的主体，使用整个图像");
      return { left: 0, top: 0, width: info.width, height: info.height };
    }

    const paddingX = Math.max(2, Math.round((right - left + 1) * 0.015));
    const paddingTop = Math.max(3, Math.round((bottom - top + 1) * 0.015));
    const paddingBottom = Math.max(0, Math.round((bottom - top + 1) * 0.01));

    const safeLeft = Math.max(0, left - paddingX);
    const safeTop = Math.max(0, top - paddingTop);
    const safeRight = Math.min(info.width - 1, right + paddingX);
    const safeBottom = Math.min(info.height - 1, bottom + paddingBottom);

    return {
      left: safeLeft,
      top: safeTop,
      width: Math.max(1, safeRight - safeLeft + 1),
      height: Math.max(1, safeBottom - safeTop + 1),
    };
  } catch (error) {
    console.warn("[photo-id] findOpaqueBounds 出错，使用默认边界", error);
    const metadata = await image.metadata();
    return { left: 0, top: 0, width: metadata.width, height: metadata.height };
  }
}

async function measureOpaqueBandWidth(inputBuffer, startRatio, endRatio, mode = "max") {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const startY = Math.max(0, Math.floor(info.height * startRatio));
  const endY = Math.min(info.height - 1, Math.ceil(info.height * endRatio));
  const widths = [];
  let maxWidth = 0;

  for (let y = startY; y <= endY; y += 1) {
    let left = info.width;
    let right = -1;

    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * info.channels + 3];
      if (alpha <= OPAQUE_BOUNDS_THRESHOLD) {
        continue;
      }

      left = Math.min(left, x);
      right = Math.max(right, x);
    }

    if (right >= left) {
      const width = right - left + 1;
      widths.push(width);
      maxWidth = Math.max(maxWidth, width);
    }
  }

  if (!widths.length) {
    return 0;
  }

  if (mode === "p25") {
    widths.sort((left, right) => left - right);
    return widths[Math.max(0, Math.min(widths.length - 1, Math.floor(widths.length * 0.25)))];
  }

  return maxWidth;
}

async function analyzePortraitRows(image) {
  try {
    const { data, info } = await image
      .clone()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rows = [];
    for (let y = 0; y < info.height; y += 1) {
      let left = info.width;
      let right = -1;

      for (let x = 0; x < info.width; x += 1) {
        const alpha = data[(y * info.width + x) * info.channels + 3];
        if (alpha <= OPAQUE_BOUNDS_THRESHOLD) {
          continue;
        }

        if (x < left) {
          left = x;
        }
        if (x > right) {
          right = x;
        }
      }

      rows.push({
        y,
        left,
        right,
        width: right >= left ? right - left + 1 : 0,
      });
    }

    let top = rows.findIndex((row) => row.width > 0);
    let bottom = (() => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].width > 0) {
          return index;
        }
      }
      return -1;
    })();

    if (top < 0 || bottom < top) {
      // 如果找不到任何不透明区域，默认使用整个图像
      console.warn("[photo-id] 未找到明确主体，使用整个图像范围");
      top = 0;
      bottom = info.height - 1;
    }

    const smoothedWidths = rows.map((_, centerIndex) => {
      let sum = 0;
      let count = 0;

      for (let offset = -4; offset <= 4; offset += 1) {
        const index = centerIndex + offset;
        if (index < 0 || index >= rows.length) {
          continue;
        }
        sum += rows[index].width;
        count += 1;
      }

      return count ? sum / count : rows[centerIndex].width;
    });

    return {
      rows,
      smoothedWidths,
      top,
      bottom,
      height: bottom - top + 1,
    };
  } catch (error) {
    console.warn("[photo-id] analyzePortraitRows 失败，使用默认分析", error);
    const metadata = await image.metadata();
    const rows = [];
    for (let y = 0; y < metadata.height; y += 1) {
      rows.push({
        y,
        left: 0,
        right: metadata.width - 1,
        width: metadata.width,
      });
    }
    const smoothedWidths = rows.map(() => metadata.width);
    return {
      rows,
      smoothedWidths,
      top: 0,
      bottom: metadata.height - 1,
      height: metadata.height,
    };
  }
}

function detectShoulderLine(profile) {
  try {
    const { top, bottom, height, rows, smoothedWidths } = profile;
    const headSearchEnd = Math.min(bottom, top + Math.max(12, Math.round(height * 0.22)));
    let headWidth = 0;
    let maxWidth = 0;

    for (let y = top; y <= bottom; y += 1) {
      const width = smoothedWidths[y] || 0;
      if (width > maxWidth) {
        maxWidth = width;
      }
      if (y <= headSearchEnd && width > headWidth) {
        headWidth = width;
      }
    }

    const searchStart = Math.min(bottom, top + Math.max(8, Math.round(height * 0.12)));
    const threshold = Math.max((headWidth || maxWidth * 0.5) * 1.14, maxWidth * 0.6);

    for (let y = searchStart; y <= bottom; y += 1) {
      const width = smoothedWidths[y] || 0;
      if (width < threshold) {
        continue;
      }

      let stableCount = 0;
      for (let offset = 0; offset < 6; offset += 1) {
        const nextIndex = y + offset;
        if (nextIndex > bottom) {
          break;
        }
        if ((smoothedWidths[nextIndex] || 0) >= threshold * 0.92) {
          stableCount += 1;
        }
      }

      if (stableCount >= 4) {
        return y;
      }
    }

    return Math.min(bottom, top + Math.round(height * 0.35));
  } catch (error) {
    console.warn("[photo-id] detectShoulderLine 失败，使用默认位置", error);
    return Math.min(profile.bottom, profile.top + Math.round(profile.height * 0.35));
  }
}

async function buildPortraitCrop(subject) {
  console.log("[photo-id] buildPortraitCrop: 开始");
  try {
    const subjectBuffer = await subject.png().toBuffer();
    const materializedSubject = sharp(subjectBuffer);
    const metadata = await materializedSubject.metadata();
    const profile = await analyzePortraitRows(materializedSubject);
    const shoulderY = detectShoulderLine(profile);
    const headHeight = Math.max(1, shoulderY - profile.top + 1);
    const headSearchEnd = Math.min(profile.bottom, profile.top + Math.max(12, Math.round(profile.height * 0.22)));
    let headWidth = 0;
    let headCenterSum = 0;
    let headCenterWeight = 0;
    let shoulderLeft = metadata.width;
    let shoulderRight = -1;

    for (let y = profile.top; y <= headSearchEnd; y += 1) {
      const width = profile.smoothedWidths[y] || 0;
      headWidth = Math.max(headWidth, width);
      const row = profile.rows[y];
      if (row && row.width > 0) {
        headCenterSum += ((row.left + row.right) / 2) * row.width;
        headCenterWeight += row.width;
      }
    }

    for (let y = Math.max(profile.top, shoulderY - 4); y <= Math.min(profile.bottom, shoulderY + 6); y += 1) {
      const row = profile.rows[y];
      if (!row || row.width <= 0) {
        continue;
      }
      shoulderLeft = Math.min(shoulderLeft, row.left);
      shoulderRight = Math.max(shoulderRight, row.right);
    }

    if (shoulderRight < shoulderLeft) {
      shoulderLeft = profile.rows[shoulderY]?.left || 0;
      shoulderRight = profile.rows[shoulderY]?.right || metadata.width - 1;
    }

    const shoulderCenter = (shoulderLeft + shoulderRight) / 2;
    const headCenter = headCenterWeight > 0 ? headCenterSum / headCenterWeight : shoulderCenter;
    const portraitCenter = headCenter * 0.72 + shoulderCenter * 0.28;
    const shoulderWidth = Math.max(1, shoulderRight - shoulderLeft + 1);

    const targetPortraitWidth = Math.min(
      metadata.width,
      Math.max(Math.round((headWidth || shoulderWidth) * 2.4), Math.round(shoulderWidth * 1.35))
    );

    const desiredBottom = Math.round(profile.top + headHeight * 1.8);
    const cropBottom = Math.min(
      metadata.height - 1,
      Math.max(
        shoulderY + Math.round(headHeight * 0.5),
        Math.min(profile.bottom, desiredBottom)
      )
    );

    const portraitHeight = cropBottom - profile.top + 1;
    const targetTopPadding = Math.round(portraitHeight * 0.08);
    const cropTop = Math.max(0, profile.top - targetTopPadding);
    const cropLeft = Math.max(0, Math.round(portraitCenter - targetPortraitWidth / 2));
    const safeCropLeft = Math.min(cropLeft, Math.max(0, metadata.width - targetPortraitWidth));

    console.log(`[photo-id] buildPortraitCrop: 头顶留白 ${targetTopPadding}px, 总高度 ${portraitHeight}px`);

    return materializedSubject.extract({
      left: safeCropLeft,
      top: cropTop,
      width: Math.max(1, Math.min(metadata.width, targetPortraitWidth)),
      height: Math.max(1, cropBottom - cropTop + 1),
    });
  } catch (error) {
    console.warn("[photo-id] buildPortraitCrop 复杂裁剪失败，使用简单居中裁剪", error);
    return subject;
  }
}

async function assertMaskQuality(maskedImage, sourceMetadata) {
  try {
    const bounds = await findOpaqueBounds(maskedImage.clone());
    const widthRatio = bounds.width / sourceMetadata.width;
    const heightRatio = bounds.height / sourceMetadata.height;
    const areaRatio = (bounds.width * bounds.height) / (sourceMetadata.width * sourceMetadata.height);

    if (heightRatio < 0.28 || widthRatio < 0.16 || areaRatio < 0.08) {
      console.warn("[photo-id] 主体识别质量较低，但继续尝试处理");
      return;
    }

    if (heightRatio > 0.99 && widthRatio > 0.99) {
      console.warn("[photo-id] 背景可能没有被成功移除，但继续尝试处理");
      return;
    }
  } catch (error) {
    console.warn("[photo-id] assertMaskQuality 检查失败，继续处理", error);
  }
}

async function removeBackground(config, inputBuffer) {
  // 直接跳过所有非AI逻辑
  try {
    return await removeBackgroundWithModel(config, inputBuffer);
  } catch (e) {
    console.error("AI抠图失败", e);
    return sharp(inputBuffer).ensureAlpha().toBuffer();
  }
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 255, g: 255, b: 255 };
}

async function buildPhotoIdImage(config, inputBuffer, options) {
  console.log("[photo-id] 开始生成证件照...");
  const spec = getPhotoSpec(options.size);
  const background = getBackgroundColor(options.background);
  const retouch = getRetouchProfile(options.retouch);

  let sourceBackgroundColor;
  try {
    console.log("[photo-id] 步骤1: 估计输入背景颜色");
    sourceBackgroundColor = await estimateInputBackgroundColor(inputBuffer);
  } catch (error) {
    console.warn("[photo-id] 估计背景颜色失败，使用默认白色", error);
    sourceBackgroundColor = { r: 255, g: 255, b: 255 };
  }

  let transparentSubject;
  try {
    console.log("[photo-id] 步骤2: 移除背景（强制AI模型）");
    transparentSubject = await removeBackground(config, inputBuffer);
  } catch (error) {
    console.warn("[photo-id] 移除背景失败，使用原图", error);
    transparentSubject = sharp(inputBuffer).ensureAlpha();
  }

  // 🔥 新增：检查掩码是否有效，避免全透明/全不透明
  const testMeta = await transparentSubject.metadata();
  if (testMeta.width === 0 || testMeta.height === 0) {
    console.error("[photo-id] 生成的透明图像无效，使用原图");
    transparentSubject = sharp(inputBuffer).ensureAlpha();
  }

  let bounds;
  try {
    console.log("[photo-id] 步骤3: 查找不透明边界");
    bounds = await findOpaqueBounds(transparentSubject);
  } catch (error) {
    console.warn("[photo-id] 查找边界失败，使用整个图像", error);
    const meta = await transparentSubject.metadata();
    bounds = { left: 0, top: 0, width: meta.width, height: meta.height };
  }

  let subject;
  try {
    console.log("[photo-id] 步骤4: 构建人像裁剪");
    subject = await buildPortraitCrop(transparentSubject.extract(bounds));
  } catch (error) {
    console.warn("[photo-id] 人像裁剪失败，使用原图", error);
    subject = transparentSubject.extract(bounds);
  }

  console.log("[photo-id] 步骤5: 转换为PNG");
  let subjectBuffer = await subject.png().toBuffer();

  // 🔥 强制执行发丝优化
  try {
    console.log("[photo-id] 步骤5.5: 发丝羽化（BiRefNet专用）");
    subjectBuffer = await featherSubjectEdges(subjectBuffer, 2.0);
  } catch (error) {
    console.warn("[photo-id] 边缘羽化失败，跳过", error);
  }

  try {
    console.log("[photo-id] 步骤6: 颜色溢出校正");
    subjectBuffer = await decontaminateSubjectBuffer(subjectBuffer, sourceBackgroundColor);
  } catch (error) {
    console.warn("[photo-id] 颜色溢出校正失败，跳过", error);
  }

  // 🔥 后续尺寸调整逻辑保持不变，但修复合成部分
  const preparedSubject = sharp(subjectBuffer);
  const metadata = await preparedSubject.metadata();

  const maxWidth = Math.round(spec.width * spec.maxWidthRatio);
  const bottomInset = Math.max(0, spec.bottomInset || 0);
  const maxHeight = Math.max(1, Math.round(spec.height * spec.maxHeightRatio) - bottomInset);
  const scale = Math.min(maxWidth / metadata.width, maxHeight / metadata.height);
  const targetWidth = Math.max(1, Math.round(metadata.width * scale));
  const targetHeight = Math.max(1, Math.round(metadata.height * scale));

  console.log("[photo-id] 步骤8: 调整主体大小");
  let processedSubject = sharp(
    await resizeSubjectBuffer(subjectBuffer, targetWidth, targetHeight)
  );

  if (retouch.sharpen) {
    processedSubject = processedSubject.sharpen({ sigma: 0.8, m1: 0.5, m2: 1.2 });
  }

  if (retouch.brightness !== 1 || retouch.saturation !== 1) {
    processedSubject = processedSubject.modulate({
      brightness: retouch.brightness,
      saturation: retouch.saturation,
    });
  }

  if (retouch.contrast && retouch.contrast !== 1) {
    processedSubject = processedSubject.linear(retouch.contrast, -(128 * (retouch.contrast - 1)));
  }

  console.log("[photo-id] 步骤9: 处理并转换为PNG");
  subjectBuffer = await processedSubject.png().toBuffer();
  let subjectImage = sharp(subjectBuffer);

  let trimBounds;
  try {
    console.log("[photo-id] 步骤10: 查找裁剪边界");
    trimBounds = await findOpaqueBounds(subjectImage);
  } catch (error) {
    console.warn("[photo-id] 查找裁剪边界失败，使用原图", error);
    trimBounds = { left: 0, top: 0, width: metadata.width, height: metadata.height };
  }

  try {
    console.log("[photo-id] 步骤11: 裁剪并转换为PNG");
    subjectBuffer = await subjectImage.extract(trimBounds).png().toBuffer();
  } catch (error) {
    console.warn("[photo-id] 裁剪失败，跳过", error);
  }
  let subjectMetadata = await sharp(subjectBuffer).metadata();

  // 🔥 修复：合成时强制居中，避免顶部出现蓝色条
  const left = Math.max(0, Math.round((spec.width - subjectMetadata.width) / 2));
  const top = Math.max(0, spec.height - bottomInset - subjectMetadata.height);
  const newBackgroundRgb = hexToRgb(background);

  try {
    console.log("[photo-id] 步骤14: 边缘净化");
    subjectBuffer = await finalEdgeCleanup(subjectBuffer, newBackgroundRgb, sourceBackgroundColor);
  } catch (error) {
    console.warn("[photo-id] 边缘净化失败，跳过", error);
  }

  console.log("[photo-id] 步骤15: 合成最终图像");
  let outputBuffer = await sharp({
    create: {
      width: spec.width,
      height: spec.height,
      channels: 4,
      background,
    },
  })
    .composite([
      {
        input: subjectBuffer,
        left,
        top,
      },
    ])
    .png()
    .toBuffer();

  console.log("[photo-id] 步骤16: 最终边缘修复");
  outputBuffer = await finalEdgeRepairAfterComposite(outputBuffer, newBackgroundRgb, background, sourceBackgroundColor);

  return {
    buffer: outputBuffer,
    width: spec.width,
    height: spec.height,
    subjectWidth: targetWidth,
    subjectHeight: targetHeight,
  };
}


async function warmPhotoIdModel(config) {
  return getSession(config);
}

module.exports = {
  buildPhotoIdImage,
  warmPhotoIdModel,
  getPhotoSpec,
  getBackgroundColor,
};
