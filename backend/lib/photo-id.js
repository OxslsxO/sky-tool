const fs = require("fs");
const path = require("path");
const os = require("os");
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
};

const BACKGROUND_COLOR_MAP = {
  "白底": "#ffffff",
  "白色": "#ffffff",
  "白": "#ffffff",
  "纯白": "#ffffff",
  "蓝底": "#2d6ec9",
  "蓝色": "#2d6ec9",
  "蓝": "#2d6ec9",
  "淡蓝": "#87ceeb",
  "天蓝": "#2d6ec9",
  "藏蓝": "#1e3a5f",
  "红底": "#cf5446",
  "红色": "#cf5446",
  "红": "#cf5446",
  "大红": "#cf5446",
  "酒红": "#8b0000",
  "浅灰": "#d3d3d3",
  "淡粉": "#ffb6c1",
  "淡绿": "#90ee90",
};

const MODEL_CANDIDATES = [
  {
    key: "birefnet-portrait",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-portrait-epoch_150.onnx",
    fileName: "BiRefNet-portrait-epoch_150.onnx",
    inputSize: 1024,
  },
  {
    key: "u2net-human-seg",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx",
    fileName: "u2net_human_seg.onnx",
    inputSize: 320,
  }
];
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

  // 检查是否强制禁用模型（用于内存受限环境如 Render）
  if (process.env.PHOTO_ID_DISABLE_MODEL === 'true') {
    console.log("[photo-id] getSession: 模型被环境变量禁用");
    return null;
  }

  // 优先使用项目内的模型目录（Docker 构建时下载的）
  const projectModelsDir = path.join(__dirname, "..", "storage", "models");
  console.log(`[photo-id] getSession: 检查项目模型目录 ${projectModelsDir}`);
  
  // 只有项目内没有模型时才使用运行时目录
  let modelsDir;
  if (fs.existsSync(projectModelsDir)) {
    const files = fs.readdirSync(projectModelsDir);
    if (files.length > 0) {
      modelsDir = projectModelsDir;
      console.log(`[photo-id] getSession: 使用项目模型目录 ${modelsDir}`);
    }
  }
  
  if (!modelsDir) {
    modelsDir = path.join(config.tempDir, "..", "models");
    console.log(`[photo-id] getSession: 使用运行时模型目录 ${modelsDir}`);
  }

  // 检查缓存
  for (let index = 0; index < MODEL_CANDIDATES.length; index += 1) {
    const model = MODEL_CANDIDATES[index];
    const cacheKey = model.key;
    if (sessionCache.has(cacheKey)) {
      console.log(`[photo-id] getSession: 使用缓存的会话 ${model.key}`);
      return sessionCache.get(cacheKey);
    }
  }

  for (let index = 0; index < MODEL_CANDIDATES.length; index += 1) {
    const model = MODEL_CANDIDATES[index];
    console.log(`[photo-id] getSession: 尝试模型 ${model.key}`);

    try {
      // 确保模型文件存在
      const modelPath = await ensureModelFile(modelsDir, model);
      console.log(`[photo-id] getSession: 模型文件就绪 ${modelPath}`);

      // 创建带有超时的会话
      console.log(`[photo-id] getSession: 创建会话 ${model.key}`);
      
      // 使用更长的超时时间和更保守的内存设置
      const cpuCount = (os.cpus() || []).length || 1;
      const sessionOptions = {
        executionProviders: ['cpu'],
        intraOpNumThreads: Math.min(4, cpuCount),
        interOpNumThreads: Math.min(2, cpuCount),
        graphOptimizationLevel: 'extended',
      };
      
      const sessionCreatePromise = ort.InferenceSession.create(modelPath, sessionOptions);
      
      // 60秒超时（Render 等环境可能需要更长时间）
      const timeoutPromise = new Promise((_, reject) => {
        const timeoutId = setTimeout(() => reject(new Error(`Model ${model.key} loading timeout`)), 60000);
        timeoutId.unref?.();
        sessionCreatePromise.finally(() => clearTimeout(timeoutId));
      });

      const session = await Promise.race([sessionCreatePromise, timeoutPromise]);
      console.log(`[photo-id] getSession: 会话创建成功 ${model.key}`);

      const sessionResult = { session, model };
      sessionCache.set(model.key, sessionResult);

      return sessionResult;
    } catch (error) {
      console.error(`[photo-id] getSession: 模型 ${model.key} 失败`, error.message || error);
      if (index === MODEL_CANDIDATES.length - 1) {
        console.warn(`[photo-id] getSession: 所有模型都失败，返回 null 降级处理`);
        return null;
      }
      console.log(`[photo-id] getSession: 尝试下一个模型`);
    }
  }

  console.log("[photo-id] getSession: 没有可用的模型");
  return null;
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

  const pixelCount = info.width * info.height;
  const tensor = new Float32Array(3 * pixelCount);
  const rMean = MODEL_MEAN[0], gMean = MODEL_MEAN[1], bMean = MODEL_MEAN[2];
  const rStd = MODEL_STD[0], gStd = MODEL_STD[1], bStd = MODEL_STD[2];
  const rOffset = 0, gOffset = pixelCount, bOffset = pixelCount * 2;

  for (let i = 0; i < pixelCount; i += 1) {
    const srcOffset = i * 3;
    tensor[rOffset + i] = (data[srcOffset] / 255 - rMean) / rStd;
    tensor[gOffset + i] = (data[srcOffset + 1] / 255 - gMean) / gStd;
    tensor[bOffset + i] = (data[srcOffset + 2] / 255 - bMean) / bStd;
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

function buildNormalizedAlpha(source, count, isBiRefNet = false) {
  const alpha = Buffer.alloc(count);
  
  if (isBiRefNet) {
    for (let index = 0; index < count; index += 1) {
      const value = Math.max(0, Math.min(1, source[index]));
      alpha[index] = Math.round(value * 255);
    }
  } else {
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < count; index += 1) {
      const value = source[index];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const range = Math.max(max - min, 1e-6);
    for (let index = 0; index < count; index += 1) {
      const normalized = (source[index] - min) / range;
      alpha[index] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    }
  }

  return alpha;
}

function refineAlphaBuffer(alphaBuffer, isBiRefNet = false) {
  const refined = Buffer.alloc(alphaBuffer.length);

  for (let index = 0; index < alphaBuffer.length; index += 1) {
    const value = alphaBuffer[index] / 255;
    let next = value;

    if (isBiRefNet) {
      // BiRefNet 更温和：保留更多边缘细节
      if (value <= 0.05) {
        next = 0;
      } else if (value >= 0.95) {
        next = 1;
      } else {
        // 更平滑的过渡
        next = value;
      }
    } else {
      // u2net 保持原有激进处理
      if (value <= 0.1) {
        next = 0;
      } else if (value >= 0.9) {
        next = 1;
      } else {
        const normalized = (value - 0.1) / 0.8;
        next = normalized * normalized * (3 - 2 * normalized);
      }
    }

    refined[index] = Math.max(0, Math.min(255, Math.round(next * 255)));
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

async function resizeSubjectBuffer(inputBuffer, width, height, options) {
  const fit = (options && options.fit) || "contain";
  return sharp(inputBuffer)
    .ensureAlpha()
    .resize(width, height, {
      fit,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
      fastShrinkOnLoad: false,
    })
    .png()
    .toBuffer();
}

async function applyAlphaMask(inputBuffer, alphaBuffer, width, height) {
  const rgbaMask = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    rgbaMask[offset] = 255;
    rgbaMask[offset + 1] = 255;
    rgbaMask[offset + 2] = 255;
    rgbaMask[offset + 3] = alphaBuffer[index];
  }

  const compositeBuffer = await sharp(inputBuffer)
    .ensureAlpha()
    .composite([{
      input: rgbaMask,
      raw: { width, height, channels: 4 },
      blend: "dest-in",
    }])
    .png()
    .toBuffer();

  return sharp(compositeBuffer);
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

async function decontaminateSubjectBuffer(subjectBuffer, backgroundColor) {
  console.log("[photo-id] decontaminateSubjectBuffer: 强力清除白边");
  const { data, info } = await sharp(subjectBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;

  // 暴力去除白色背景污染，直接抹除边缘白边
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * channels;
    const alpha = data[offset + 3] / 255;

    // 完全透明像素直接清空，不留白色
    if (alpha <= 0.1) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
      continue;
    }

    // 收紧Alpha，消除半透明白边
    const tightenedAlpha = smoothstep(0.2, 0.9, alpha);
    if (tightenedAlpha <= 0) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 0;
      continue;
    }

    // 彻底清除背景白色/纯色污染
    for (let channel = 0; channel < 3; channel += 1) {
      const source = data[offset + channel];
      const bg = channel === 0 ? backgroundColor.red : channel === 1 ? backgroundColor.green : backgroundColor.blue;
      // 100%去除背景色，不留白色缝隙
      const recovered = (source - bg * (1 - tightenedAlpha)) / Math.max(tightenedAlpha, 1e-3);
      data[offset + channel] = Math.max(0, Math.min(255, Math.round(recovered)));
    }

    data[offset + 3] = Math.round(tightenedAlpha * 255);
  }

  // 轻微模糊边缘，让过渡自然，无白边
  const { data: softened } = await sharp(data, {
    raw: { width: info.width, height: info.height, channels },
  }).blur(0.3).raw().toBuffer({ resolveWithObject: true });

  return sharp(softened, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
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
  console.log("[photo-id] removeBackgroundWithModel: 开始");
  
  // 先获取图片信息
  let sourceMetadata;
  try {
    sourceMetadata = await sharp(inputBuffer).metadata();
  } catch (error) {
    console.warn("[photo-id] removeBackgroundWithModel: 获取图片元数据失败", error.message || error);
    return null;
  }
  
  // ⚠️ 关键优化：先大幅缩小图片尺寸，减少内存使用！
  let workBuffer = inputBuffer;
  let workScale = 1;
  const MAX_SIZE = parseInt(process.env.PHOTO_ID_MAX_SIZE || '800', 10); // 从环境变量读取，默认 800px
  if (sourceMetadata.width > MAX_SIZE || sourceMetadata.height > MAX_SIZE) {
    console.log(`[photo-id] removeBackgroundWithModel: 图片尺寸 ${sourceMetadata.width}x${sourceMetadata.height} 太大，先缩小到 ${MAX_SIZE}px 内`);
    workScale = Math.min(MAX_SIZE / sourceMetadata.width, MAX_SIZE / sourceMetadata.height);
    workBuffer = await sharp(inputBuffer)
      .resize({ width: Math.round(sourceMetadata.width * workScale), height: Math.round(sourceMetadata.height * workScale), fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();
    console.log(`[photo-id] removeBackgroundWithModel: 图片已缩小，缩放比例 ${workScale.toFixed(3)}`);
  }
  
  console.log("[photo-id] removeBackgroundWithModel: 获取会话");
  let sessionBundle;
  try {
    sessionBundle = await getSession(config);
  } catch (error) {
    console.error("[photo-id] removeBackgroundWithModel: 获取会话失败", error.message || error);
    return null;
  }
  
  if (!sessionBundle) {
    console.warn("[photo-id] removeBackgroundWithModel: 模型不可用，返回 null");
    return null;
  }
  console.log("[photo-id] removeBackgroundWithModel: 会话获取成功");

  const { session, model } = sessionBundle;
  console.log(`[photo-id] 🔄 当前使用的模型: ${model.key}`);
  
  let tensor;
  try {
    console.log("[photo-id] removeBackgroundWithModel: 标准化图像");
    tensor = await normalizeImageForModel(session, model, workBuffer); // 使用缩小后的图片
  } catch (error) {
    console.error("[photo-id] removeBackgroundWithModel: 图像标准化失败", error.message || error);
    return null;
  }

  console.log("[photo-id] removeBackgroundWithModel: 运行模型推理");
  
  let result;
  try {
    // 添加推理超时 - 在 Render 等内存受限环境中可能需要更长时间
    const runPromise = session.run({ [getInputShape(session, model).inputName]: tensor });
    const timeoutPromise = new Promise((_, reject) => {
      const runTimeoutId = setTimeout(() => reject(new Error("Model inference timeout")), 120000);
      runTimeoutId.unref?.();
      runPromise.finally(() => clearTimeout(runTimeoutId));
    });

    result = await Promise.race([runPromise, timeoutPromise]);
    console.log("[photo-id] removeBackgroundWithModel: 模型推理完成");
  } catch (error) {
    console.error("[photo-id] removeBackgroundWithModel: 模型推理失败", error.message || error);
    return null;
  }

  const outputTensor = getPrimaryOutputTensor(session, result);
  const dimensions = outputTensor.dims || [];
  const maskHeight = dimensions[dimensions.length - 2];
  const maskWidth = dimensions[dimensions.length - 1];

  if (!maskHeight || !maskWidth) {
    const error = new Error("Photo-id model output dimensions are invalid");
    error.code = "PHOTO_ID_MODEL_OUTPUT_INVALID";
    throw error;
  }
  console.log(`[photo-id] removeBackgroundWithModel: 掩码尺寸 ${maskWidth}x${maskHeight}`);

  console.log("[photo-id] removeBackgroundWithModel: 处理 alpha 掩码");
  const isBiRefNet = model.key.includes('birefnet');
  
  const alpha = buildNormalizedAlpha(outputTensor.data, maskWidth * maskHeight, isBiRefNet);
  const refinedAlpha = refineAlphaBuffer(alpha, isBiRefNet);

  const originalAlpha = await sharp(refinedAlpha, {
    raw: { width: maskWidth, height: maskHeight, channels: 1 },
  })
    .resize(sourceMetadata.width, sourceMetadata.height, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  console.log("[photo-id] removeBackgroundWithModel: 在原始图片上应用 alpha 遮罩");
  const finalResult = await applyAlphaMask(inputBuffer, originalAlpha, sourceMetadata.width, sourceMetadata.height);
  console.log("[photo-id] removeBackgroundWithModel: 完成");
  return finalResult;
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
async function finalEdgeCleanup(subjectBuffer, newBackgroundColor) {
  console.log("[photo-id] finalEdgeCleanup: 兜底清除白边");
  const { data, info } = await sharp(subjectBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  // 暴力处理：所有半透明+白色像素，直接替换为前景色
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const alpha = data[idx + 3];

      // 只处理半透明像素（白边集中区）
      if (alpha > 0 && alpha < 255) {
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // 检测白色/浅灰色（证件照白边核心）
        const isWhiteEdge = r > 150 && g > 150 && b > 150;
        let touchesTransparentEdge = false;
        for (let dy = -1; dy <= 1 && !touchesTransparentEdge; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }

            const neighborX = x + dx;
            const neighborY = y + dy;
            if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) {
              continue;
            }

            const neighborAlpha = data[(neighborY * width + neighborX) * channels + 3];
            if (neighborAlpha <= 64) {
              touchesTransparentEdge = true;
              break;
            }
          }
        }

        if (isWhiteEdge && touchesTransparentEdge) {
          // 直接把白色改成人物肤色，彻底消灭白边
          data[idx] = Math.max(120, r - 40);
          data[idx + 1] = Math.max(100, g - 50);
          data[idx + 2] = Math.max(90, b - 50);
        }
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

    console.log(`[photo-id] 🔍 检测到的主体边界: top=${top}, bottom=${bottom}, left=${left}, right=${right}, height=${bottom-top+1}, width=${right-left+1}`);

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

    console.log(`[photo-id] 📐 裁切调试: profile.top=${profile.top}, profile.bottom=${profile.bottom}, profile.height=${profile.height}, shoulderY=${shoulderY}, headHeight=${headHeight}`);

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

    const targetPortraitWidth = metadata.width;

    const desiredBottom = Math.round(profile.top + headHeight * 4.0);
    const cropBottom = Math.min(
      metadata.height - 1,
      Math.max(
        shoulderY + Math.round(headHeight * 0.9),
        Math.min(profile.bottom, desiredBottom)
      )
    );

    console.log(`[photo-id] 📐 裁切调试: desiredBottom=${desiredBottom}, shoulderY+headHeight*0.9=${shoulderY + Math.round(headHeight * 0.9)}, cropBottom=${cropBottom}`);

    const portraitHeight = cropBottom - profile.top + 1;
    const targetTopPadding = Math.round(portraitHeight * 0.12);
    const cropTop = Math.max(0, profile.top - targetTopPadding);
    const cropLeft = Math.max(0, Math.round(portraitCenter - targetPortraitWidth / 2));
    const safeCropLeft = Math.min(cropLeft, Math.max(0, metadata.width - targetPortraitWidth));

    console.log(`[photo-id] buildPortraitCrop: 头顶留白 ${targetTopPadding}px, 总高度 ${portraitHeight}px, 裁切区域: top=${cropTop}, bottom=${cropBottom}, left=${safeCropLeft}, width=${Math.max(1, Math.min(metadata.width, targetPortraitWidth))}`);

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
  console.log("[photo-id] removeBackground: 开始");
  const sourceMetadata = await sharp(inputBuffer).metadata();
  
  // 首先尝试 IMG.LY 背景移除
  try {
    const imglyResult = await removeBackgroundWithImgly(config, inputBuffer);
    if (imglyResult) {
      console.log("[photo-id] removeBackground: IMG.LY AI background removal succeeded");
      await assertMaskQuality(imglyResult.clone(), sourceMetadata);
      return imglyResult;
    }
  } catch (error) {
    console.warn(
      "[photo-id] IMG.LY AI background removal failed, falling back",
      error && error.message ? error.message : error
    );
  }
  
  console.log(`[photo-id] removeBackground: 源图像尺寸 ${sourceMetadata.width}x${sourceMetadata.height}`);

  // 优先尝试模型移除背景（处理头发边缘更好）
  try {
    console.log("[photo-id] removeBackground: 使用模型移除背景");
    const modelResult = await removeBackgroundWithModel(config, inputBuffer);
    if (modelResult) {
      console.log("[photo-id] removeBackground: 模型处理完成");
      await assertMaskQuality(modelResult.clone(), sourceMetadata);
      console.log("[photo-id] removeBackground: 完成");
      return modelResult;
    }
  } catch (error) {
    console.error(
      "[photo-id] 模型移除背景失败，尝试统一背景",
      error && error.message ? error.message : error
    );
  }

  // 尝试统一背景移除
  try {
    console.log("[photo-id] removeBackground: 尝试移除统一背景");
    const uniformBackgroundResult = await removeUniformBackground(inputBuffer);
    if (uniformBackgroundResult) {
      console.log("[photo-id] removeBackground: 统一背景移除成功");
      await assertMaskQuality(uniformBackgroundResult.clone(), sourceMetadata);
      return uniformBackgroundResult;
    }
  } catch (error) {
    console.warn(
      "[photo-id] 统一背景移除失败",
      error && error.message ? error.message : error
    );
  }
  
  // 所有方法都失败，返回原图，至少不卡住
  console.warn("[photo-id] 所有背景移除方法失败，返回原图（无背景移除）");
  return sharp(inputBuffer).ensureAlpha();
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
    console.log("[photo-id] 步骤2: 移除背景");
    transparentSubject = await removeBackground(config, inputBuffer);
  } catch (error) {
    console.warn("[photo-id] 移除背景失败，使用原图", error);
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

  try {
    console.log("[photo-id] 步骤6: 净化主体");
    subjectBuffer = await decontaminateSubjectBuffer(subjectBuffer, sourceBackgroundColor);
  } catch (error) {
    console.warn("[photo-id] 净化失败，跳过", error);
  }

  console.log("[photo-id] 步骤7: 获取元数据");
  const preparedSubject = sharp(subjectBuffer);
  const metadata = await preparedSubject.metadata();
  console.log(`[photo-id] 📏 初始主体尺寸: width=${metadata.width}, height=${metadata.height}`);
  console.log(`[photo-id] 📏 目标尺寸: width=${spec.width}, height=${spec.height}`);

  const bottomInset = Math.max(0, spec.bottomInset || 0);

  let trimBounds;
  try {
    console.log("[photo-id] 步骤7a: 查找裁剪边界");
    trimBounds = await findOpaqueBounds(preparedSubject);
    trimBounds.top = 0;
    trimBounds.height = metadata.height;
  } catch (error) {
    console.warn("[photo-id] 查找裁剪边界失败，使用原图", error);
    trimBounds = { left: 0, top: 0, width: metadata.width, height: metadata.height };
  }

  try {
    console.log("[photo-id] 步骤7b: 裁剪左右透明边（保留顶部）");
    subjectBuffer = await sharp(subjectBuffer).extract(trimBounds).png().toBuffer();
  } catch (error) {
    console.warn("[photo-id] 裁剪失败，跳过", error);
  }

  const trimmedMetadata = await sharp(subjectBuffer).metadata();
  console.log(`[photo-id] 📏 裁切后尺寸: width=${trimmedMetadata.width}, height=${trimmedMetadata.height}`);

  let headHeight = Math.round(trimmedMetadata.height * 0.3);
  let headTopInImage = 0;
  let headCenterX = trimmedMetadata.width / 2;
  try {
    const profile = await analyzePortraitRows(sharp(subjectBuffer));
    const shoulderY = detectShoulderLine(profile);
    headHeight = Math.max(1, shoulderY - profile.top + 1);
    headTopInImage = profile.top;
    const headSearchEnd = Math.min(profile.bottom, profile.top + Math.max(12, Math.round(profile.height * 0.22)));
    let hcxSum = 0;
    let hcxWeight = 0;
    for (let y = profile.top; y <= headSearchEnd; y += 1) {
      const row = profile.rows[y];
      if (row && row.width > 0) {
        hcxSum += ((row.left + row.right) / 2) * row.width;
        hcxWeight += row.width;
      }
    }
    if (hcxWeight > 0) {
      headCenterX = hcxSum / hcxWeight;
    }
    console.log(`[photo-id] 📐 估计头高: ${headHeight}px, 头顶位置: ${headTopInImage}px, 头部中心X: ${headCenterX.toFixed(1)}px (shoulderY=${shoulderY})`);
  } catch (error) {
    console.warn("[photo-id] 估计头高失败，使用默认值", error);
  }

  const targetHeadTopInCanvas = Math.round(spec.height * 0.15);
  const maxHeadRatio = 0.5;
  const targetHeadHeight = Math.round(spec.height * maxHeadRatio);
  const scaleByWidth = spec.width / trimmedMetadata.width;
  const maxScaleByHead = targetHeadHeight / headHeight;
  const scaleByHeight = (spec.height - targetHeadTopInCanvas) / Math.max(1, trimmedMetadata.height - headTopInImage);
  const idealScale = Math.max(scaleByWidth, Math.min(scaleByWidth * 1.05, maxScaleByHead));
  const scale = Math.max(idealScale, scaleByHeight);
  const targetWidth = Math.max(1, Math.round(trimmedMetadata.width * scale));
  const targetHeight = Math.max(1, Math.round(trimmedMetadata.height * scale));
  const headTopScaled = Math.round(headTopInImage * scale);
  const headCenterXScaled = Math.round(headCenterX * scale);

  console.log(`[photo-id] 📐 缩放: scale=${scale.toFixed(3)}(width=${scaleByWidth.toFixed(3)},headCap=${maxScaleByHead.toFixed(3)},heightMin=${scaleByHeight.toFixed(3)}), target=${targetWidth}x${targetHeight}, 头高上限=${targetHeadHeight}px(${(maxHeadRatio * 100).toFixed(0)}%)`);
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
  let subjectMetadata = await sharp(subjectBuffer).metadata();

  if (subjectMetadata.width > spec.width) {
    const idealCropLeft = Math.round(headCenterXScaled - spec.width / 2);
    const cropLeft = Math.max(0, Math.min(idealCropLeft, subjectMetadata.width - spec.width));
    console.log(`[photo-id] 📐 水平裁切: headCenterXScaled=${headCenterXScaled}, idealCropLeft=${idealCropLeft}, cropLeft=${cropLeft}`);
    subjectBuffer = await sharp(subjectBuffer)
      .extract({ left: cropLeft, top: 0, width: spec.width, height: subjectMetadata.height })
      .png()
      .toBuffer();
    subjectMetadata = await sharp(subjectBuffer).metadata();
  }

  const subjectTopInCanvas = targetHeadTopInCanvas - headTopScaled;

  let cropTopOffset = 0;
  if (subjectTopInCanvas < 0) {
    cropTopOffset = Math.min(-subjectTopInCanvas, subjectMetadata.height - 1);
  }

  const visibleTop = spec.height - Math.max(0, subjectTopInCanvas + cropTopOffset);
  const maxVisibleHeight = Math.min(subjectMetadata.height - cropTopOffset, visibleTop);

  if (cropTopOffset > 0 || maxVisibleHeight < subjectMetadata.height) {
    const extractTop = Math.max(0, cropTopOffset);
    const extractHeight = Math.max(1, Math.min(maxVisibleHeight, subjectMetadata.height - extractTop));
    console.log(`[photo-id] 📐 垂直裁切: cropTopOffset=${cropTopOffset}, extractTop=${extractTop}, extractHeight=${extractHeight}`);
    subjectBuffer = await sharp(subjectBuffer)
      .extract({ left: 0, top: extractTop, width: subjectMetadata.width, height: extractHeight })
      .png()
      .toBuffer();
    subjectMetadata = await sharp(subjectBuffer).metadata();
  }

  const left = Math.max(0, Math.round((spec.width - subjectMetadata.width) / 2));
  const top = Math.max(0, subjectTopInCanvas + cropTopOffset);
  const newBackgroundRgb = hexToRgb(background);
  console.log(`[photo-id] 📏 最终合成前: subjectWidth=${subjectMetadata.width}, targetWidth=${spec.width}, left=${left}`);

  try {
    console.log("[photo-id] 步骤14: 边缘净化 (finalEdgeCleanup)");
    subjectBuffer = await finalEdgeCleanup(subjectBuffer, newBackgroundRgb);
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
  outputBuffer = await finalEdgeRepairAfterComposite(outputBuffer, newBackgroundRgb, background);

  return {
    buffer: outputBuffer,
    width: spec.width,
    height: spec.height,
    subjectWidth: targetWidth,
    subjectHeight: targetHeight,
  };
}

// 合成后的最终边缘修复 - 添加边缘模糊来消除白色缝隙
async function finalEdgeRepairAfterComposite(imageBuffer, bgRgb, bgHex) {
  console.log("[photo-id] finalEdgeRepairAfterComposite: 开始（清晰度优化模式）");

  // 减少模糊程度，保持清晰度
  const slightlyBlurred = await sharp(imageBuffer)
    .blur(1.0) // 减少模糊，保持清晰度
    .png()
    .toBuffer();

  const { data: originalData, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: blurredData } = await sharp(slightlyBlurred)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  const resultData = new Uint8Array(originalData.length);
  resultData.set(originalData);

  let edgePixelCount = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * channels;

      const r = originalData[idx];
      const g = originalData[idx + 1];
      const b = originalData[idx + 2];

      const distToBg = Math.abs(r - bgRgb.r) + Math.abs(g - bgRgb.g) + Math.abs(b - bgRgb.b);

      let isEdge = false;
      for (let dy = -1; dy <= 1 && !isEdge; dy++) {
        for (let dx = -1; dx <= 1 && !isEdge; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nIdx = ((y + dy) * width + (x + dx)) * channels;
          const nr = originalData[nIdx];
          const ng = originalData[nIdx + 1];
          const nb = originalData[nIdx + 2];
          const colorDiff = Math.abs(r - nr) + Math.abs(g - ng) + Math.abs(b - nb);
          if (colorDiff > 20) { // 原25 → 改为20，更敏感的边缘检测
            isEdge = true;
          }
        }
      }

      const isWhiteish = (r > 200 && g > 200 && b > 200);

      if (isEdge && ((distToBg > 15 && distToBg < 180) || (isWhiteish && distToBg > 15))) {
        edgePixelCount++;

        let blend = 0;
        if (isWhiteish) {
          blend = 0.6; // 减少混合，保持更多原始清晰度
        } else if (distToBg < 80) {
          blend = 0.4; // 减少混合
        } else {
          blend = 0.25; // 减少混合
        }

        resultData[idx] = Math.round(originalData[idx] * (1 - blend) + blurredData[idx] * blend);
        resultData[idx + 1] = Math.round(originalData[idx + 1] * (1 - blend) + blurredData[idx + 1] * blend);
        resultData[idx + 2] = Math.round(originalData[idx + 2] * (1 - blend) + blurredData[idx + 2] * blend);
      }
    }
  }

  console.log(`[photo-id] finalEdgeRepairAfterComposite: 混合了 ${edgePixelCount} 个边缘像素`);

  const result = await sharp(resultData, {
    raw: { width, height, channels: 4 }
  }).png().toBuffer();

  return result;
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
