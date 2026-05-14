const { getToolById, getToolsByIds } = require("../data/mock");
const {
  formatRelativeTime,
  formatMegabytes,
  formatDateTime,
  bytesToMegabytesValue,
} = require("./format");
const { buildLoggedOutUserPatch } = require("./auth-session");

const STORAGE_KEYS = {
  tasks: "sky_tools_tasks",
  favorites: "sky_tools_favorites",
  recent: "sky_tools_recent",
  user: "sky_tools_user",
  syncDirty: "sky_tools_sync_dirty",
  photoIdStats: "sky_tools_photo_id_stats",
  pointsRecords: "sky_tools_points_records",
  orders: "sky_tools_orders",
  dailyFreeUsage: "sky_tools_daily_free",
};

const DEFAULT_USER = {
  nickname: "微信用户",
  points: 100,
  userId: "",
  deviceId: "",
  authMode: "guest",
  avatarUrl: "",
  lastSyncedAt: "",
  syncStatus: "local",
  createdAt: "",
  updatedAt: "",
};

function readStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    return value;
  } catch (e) {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    console.error("写入存储失败:", e);
  }
}

function makeLocalId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function markSyncDirty() {
  writeStorage(STORAGE_KEYS.syncDirty, nowIso());
  triggerBackgroundSync();
}

function clearSyncDirty() {
  wx.removeStorageSync(STORAGE_KEYS.syncDirty);
}

function clearUserScopedStorage() {
  [
    STORAGE_KEYS.tasks,
    STORAGE_KEYS.favorites,
    STORAGE_KEYS.recent,
    STORAGE_KEYS.photoIdStats,
    STORAGE_KEYS.pointsRecords,
    STORAGE_KEYS.orders,
    STORAGE_KEYS.dailyFreeUsage,
    STORAGE_KEYS.syncDirty,
  ].forEach((key) => {
    try {
      wx.removeStorageSync(key);
    } catch (error) {
      console.error("清理用户本地状态失败:", key, error);
    }
  });
}

function hasDirtySyncState() {
  return !!wx.getStorageSync(STORAGE_KEYS.syncDirty);
}

function getSyncDirtyStamp() {
  return wx.getStorageSync(STORAGE_KEYS.syncDirty) || "";
}

function normalizeRecords(records, limit) {
  const recordMap = new Map();

  (records || []).forEach((record) => {
    if (!record || !record.id) {
      return;
    }

    const previous = recordMap.get(record.id);
    const previousUpdatedAt = Number(
      previous && (previous.updatedAt || previous.createdAt)
        ? previous.updatedAt || previous.createdAt
        : 0
    );
    const nextUpdatedAt = Number(record.updatedAt || record.createdAt || 0);

    if (!previous || nextUpdatedAt >= previousUpdatedAt) {
      recordMap.set(record.id, {
        ...record,
        createdAt: record.createdAt || Date.now(),
        updatedAt: record.updatedAt || record.createdAt || Date.now(),
      });
    }
  });

  return Array.from(recordMap.values())
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    .slice(0, limit);
}

function normalizeUserState(user) {
  if (!user) {
    const newUser = { ...DEFAULT_USER };
    newUser.deviceId = makeLocalId("device");
    newUser.createdAt = nowIso();
    newUser.updatedAt = newUser.createdAt;
    return newUser;
  }

  const next = { ...user };

  if (!next.deviceId) {
    next.deviceId = makeLocalId("device");
  }

  if (!next.createdAt) {
    next.createdAt = nowIso();
  }

  if (!next.updatedAt) {
    next.updatedAt = next.createdAt;
  }

  return next;
}

function stampTask(task) {
  const createdAt = task && task.createdAt ? task.createdAt : Date.now();
  return {
    ...task,
    createdAt,
    updatedAt: task && task.updatedAt ? task.updatedAt : createdAt,
  };
}

function setFavorites(favorites, options = {}) {
  const next = Array.from(new Set((favorites || []).filter(Boolean))).slice(0, 12);
  writeStorage(STORAGE_KEYS.favorites, next);

  if (!options.silent) {
    markSyncDirty();
  }

  return next;
}

function setRecentToolIds(toolIds, options = {}) {
  const next = Array.from(new Set((toolIds || []).filter(Boolean))).slice(0, 8);
  writeStorage(STORAGE_KEYS.recent, next);

  if (!options.silent) {
    markSyncDirty();
  }

  return next;
}

let _syncTimer = null;

function triggerBackgroundSync() {
  if (_syncTimer) {
    clearTimeout(_syncTimer);
  }

  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    try {
      const { syncCloudState } = require("./sync-manager");
      const { hasBackendService } = require("../services/backend-tools");
      const user = getUserState();
      if (!hasBackendService() || !user || !user.userId) {
        return;
      }
      syncCloudState({ force: true }).catch(() => {});
    } catch {
      // sync-manager may not be available
    }
  }, 3000);
}

function seedUserState() {
  const current = readStorage(STORAGE_KEYS.user, null);
  if (current) {
    return normalizeUserState(current);
  }

  const newUser = normalizeUserState(null);
  writeStorage(STORAGE_KEYS.user, newUser);
  return newUser;
}

function getUserState() {
  const current = readStorage(STORAGE_KEYS.user, null);
  return normalizeUserState(current);
}

function updateUserState(patch, options = {}) {
  const current = readStorage(STORAGE_KEYS.user, null);
  const base = normalizeUserState(current);
  
  const next = {
    ...base,
    ...patch,
    updatedAt: nowIso(),
  };

  writeStorage(STORAGE_KEYS.user, next);

  if (!options.silent) {
    markSyncDirty();
  }

  return next;
}

function logoutCurrentUser() {
  const currentUser = normalizeUserState(readStorage(STORAGE_KEYS.user, null));
  clearUserScopedStorage();

  const loggedOutUser = normalizeUserState({
    ...buildLoggedOutUserPatch(),
    deviceId: currentUser.deviceId,
    createdAt: currentUser.createdAt,
  });

  writeStorage(STORAGE_KEYS.user, loggedOutUser);
  return loggedOutUser;
}

function getFavorites() {
  return readStorage(STORAGE_KEYS.favorites, []);
}

function isFavoriteTool(toolId) {
  return getFavorites().includes(toolId);
}

function toggleFavorite(toolId) {
  const favorites = getFavorites();
  const exists = favorites.includes(toolId);
  const next = exists
    ? favorites.filter((item) => item !== toolId)
    : [toolId].concat(favorites);

  setFavorites(next);
  return !exists;
}

function listFavoriteTools() {
  return getToolsByIds(getFavorites());
}

function getRecentToolIds() {
  return readStorage(STORAGE_KEYS.recent, []);
}

function touchRecentTool(toolId, options = {}) {
  const next = [toolId]
    .concat(getRecentToolIds().filter((item) => item !== toolId))
    .slice(0, 8);

  setRecentToolIds(next, options);
}

function getRecentTools() {
  return getToolsByIds(getRecentToolIds());
}

function getRawTasks() {
  return refreshStoredTasks();
}

function saveTasks(tasks, options = {}) {
  const stampedTasks = (tasks || []).map(stampTask);
  const next = cleanExpiredTasks(stampedTasks);
  writeStorage(STORAGE_KEYS.tasks, next);

  if (!options.silent) {
    markSyncDirty();
  }

  return next;
}

function getTaskSortTime(task) {
  return Number(task && (task.updatedAt || task.createdAt)) || 0;
}

function mergeTaskLists(localTasks, remoteTasks) {
  const taskMap = new Map();

  [].concat(localTasks || [], remoteTasks || []).forEach((task) => {
    if (!task || !task.id) {
      return;
    }

    const stampedTask = stampTask(task);
    const previous = taskMap.get(stampedTask.id);
    if (!previous || getTaskSortTime(stampedTask) >= getTaskSortTime(previous)) {
      taskMap.set(stampedTask.id, stampedTask);
    }
  });

  return Array.from(taskMap.values())
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
    .slice(0, 100);
}

const TASK_RETENTION_DAYS = 7;
const TASK_RETENTION_MS = TASK_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function cleanExpiredTasks(tasks) {
  const now = Date.now();
  const validTasks = tasks.filter(task => 
    now - task.createdAt <= TASK_RETENTION_MS
  );
  
  return validTasks;
}

function refreshStoredTasks() {
  const tasks = readStorage(STORAGE_KEYS.tasks, []).map(stampTask);
  let changed = false;

  // 先清理过期任务
  const nonExpiredTasks = cleanExpiredTasks(tasks);
  if (nonExpiredTasks.length !== tasks.length) {
    changed = true;
  }

  const next = nonExpiredTasks.map((task) => {
    if (
      task.status === "processing" &&
      task.duration &&
      Date.now() - task.createdAt >= task.duration
    ) {
      changed = true;
      return {
        ...task,
        status: "success",
        updatedAt: Date.now(),
      };
    }

    return task;
  });

  if (changed) {
    saveTasks(next);
    return next;
  }

  return next;
}

function getTodayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function getDailyFreeUsage() {
  const todayKey = getTodayKey();
  const data = readStorage(STORAGE_KEYS.dailyFreeUsage, { date: '', tools: {} });

  if (data.date !== todayKey) {
    const newData = {
      date: todayKey,
      tools: {},
    };
    writeStorage(STORAGE_KEYS.dailyFreeUsage, newData);
    return newData;
  }

  return data;
}

function canUseFreeQuota(toolId) {
  const dailyUsage = getDailyFreeUsage();
  const toolUsage = dailyUsage.tools[toolId];
  return !toolUsage || toolUsage.count < 1;
}

function getBillingPreview(tool) {
  // 积分要求为 0 的工具直接免费
  if (tool.points === 0) {
    return {
      usable: true,
      mode: 'free',
      text: '免费使用',
      costText: '免费',
    };
  }

  try {
    const membership = require('../services/membership');
    const priority = membership.getUsagePriority(tool);
    
    if (priority.priority === 'free') {
      return {
        usable: true,
        mode: 'free',
        text: '本次使用今日免费次数（每个工具每日限1次）',
        costText: '今日有1次免费',
      };
    }

    if (priority.priority === 'points') {
      const user = getUserState();
      return {
        usable: true,
        mode: 'points',
        text: `本次将消耗 ${tool.points} 积分，当前余额 ${user.points} 积分`,
        costText: `${tool.points} 积分`,
      };
    }

    return {
      usable: false,
      mode: 'locked',
      text: priority.text || '积分不足，请购买积分包',
      costText: `${tool.points} 积分`,
      needUpgrade: true,
    };
  } catch {
    // 备用逻辑：检查免费次数
    const hasFreeQuota = canUseFreeQuota(tool.id);
    
    if (hasFreeQuota) {
      return {
        usable: true,
        mode: 'free',
        text: '本次使用今日免费次数（每个工具每日限1次）',
        costText: '今日有1次免费',
      };
    }

    const user = getUserState();
    if (user.points >= tool.points) {
      return {
        usable: true,
        mode: 'points',
        text: `本次将消耗 ${tool.points} 积分，当前余额 ${user.points} 积分`,
        costText: `${tool.points} 积分`,
      };
    }
    return {
      usable: false,
      mode: 'locked',
      text: '积分不足，请先开通会员或购买积分包',
      costText: `${tool.points} 积分`,
      needUpgrade: true,
    };
  }
}

function commitUsage(tool) {
  try {
    const membership = require('../services/membership');
    const result = membership.commitToolUsage(tool);
    
    if (!result.success) {
      return { usable: false, mode: 'locked', text: result.reason };
    }

    return { usable: true, mode: result.mode, text: result.text };
  } catch {
    const preview = getBillingPreview(tool);

    if (!preview.usable) {
      return preview;
    }

    if (preview.mode === 'free') {
      const dailyUsage = getDailyFreeUsage();
      if (!dailyUsage.tools) {
        dailyUsage.tools = {};
      }
      if (!dailyUsage.tools[tool.id]) {
        dailyUsage.tools[tool.id] = { count: 0 };
      }
      dailyUsage.tools[tool.id].count += 1;
      dailyUsage.tools[tool.id].lastUsedAt = Date.now();
      writeStorage(STORAGE_KEYS.dailyFreeUsage, dailyUsage);
      addPointsRecord({
        type: 'free',
        title: `${tool.name}（免费体验）`,
        change: 0,
      });
      return { usable: true, mode: 'free', text: '使用免费次数成功' };
    }

    if (preview.mode === 'points') {
      const user = getUserState();
      updateUserState({
        points: Math.max(user.points - tool.points, 0),
      });
      addPointsRecord({
        type: 'consume',
        title: tool.name,
        change: -tool.points,
      });
      return { usable: true, mode: 'points', text: `消耗${tool.points}积分成功` };
    }

    return preview;
  }
}

function toMegabytes(value, bytes) {
  if (value !== undefined && value !== null) {
    return value;
  }

  if (bytes !== undefined && bytes !== null) {
    return bytesToMegabytesValue(bytes);
  }

  return null;
}

function buildTaskPayload(tool, selections) {
  const now = Date.now();
  const presets = {
    "photo-id": {
      inputName: "自拍原图.jpg",
      outputName: "报名照_蓝底.png",
      beforeSize: 4.6,
      afterSize: 1.2,
      duration: 7000,
      headline: "证件照已进入标准化处理",
      detail: "会自动校准边距与底色，并生成电子版与冲印版。",
    },
    "image-compress": {
      inputName: "商品主图.png",
      outputName: "商品主图_压缩版.png",
      beforeSize: 6.4,
      afterSize: 1.9,
      duration: 5200,
      headline: "图片已进入压缩队列",
      detail: "处理完成后会展示体积变化和清晰度建议。",
    },
    "image-convert": {
      inputName: "设计稿.webp",
      outputName: "设计稿_转换后.jpg",
      beforeSize: 2.8,
      afterSize: 2.1,
      duration: 4200,
      headline: "格式转换已提交",
      detail: "目标格式会根据你的选择进行导出，并提示可能的特性变化。",
    },
    "resize-crop": {
      inputName: "海报原图.png",
      outputName: "海报_16x9.png",
      beforeSize: 5.2,
      afterSize: 3.6,
      duration: 4600,
      headline: "尺寸适配已开始",
      detail: "会按目标比例处理主体区域和画布留白。",
    },
    "image-to-pdf": {
      inputName: "票据合集.jpg",
      outputName: "票据整理.pdf",
      beforeSize: 3.8,
      afterSize: 2.7,
      duration: 6600,
      headline: "图片正在合成为 PDF",
      detail: "会统一页面规格和边距，方便后续提交。",
    },
    "pdf-compress": {
      inputName: "项目材料.pdf",
      outputName: "项目材料_压缩版.pdf",
      beforeSize: 14.8,
      afterSize: 6.2,
      duration: 7800,
      headline: "PDF 正在压缩",
      detail: "处理完成后会标明体积收益与适合的使用场景。",
    },
    "pdf-merge": {
      inputName: "报名资料.pdf",
      outputName: "报名资料_合并版.pdf",
      beforeSize: 5.6,
      afterSize: 5.8,
      duration: 5400,
      headline: "PDF 合并任务已提交",
      detail: "会按设定顺序整合为一个文件，适合继续压缩或发送。",
    },
    "pdf-split": {
      inputName: "课程讲义.pdf",
      outputName: "课程讲义_拆分包.zip",
      beforeSize: 12.2,
      afterSize: 12.4,
      duration: 5600,
      headline: "PDF 拆分处理中",
      detail: "会按页码范围输出多个独立 PDF 文件。",
    },
    "office-to-pdf": {
      inputName: "方案终稿.docx",
      outputName: "方案终稿.pdf",
      beforeSize: 8.6,
      afterSize: 4.1,
      duration: 9800,
      headline: "Office 文件正在导出 PDF",
      detail: "会优先保持版式稳定，适合正式发送和归档。",
    },
    "ocr-text": {
      inputName: "会议截图.png",
      outputName: "会议文字.txt",
      beforeSize: 2.4,
      afterSize: 0.2,
      duration: 6300,
      headline: "OCR 识别已开始",
      detail: "识别完成后可复制文字，并查看版面兼容建议。",
    },
    "qr-maker": {
      inputName: "活动链接",
      outputName: "活动二维码.png",
      beforeSize: 0.1,
      afterSize: 0.3,
      duration: 2600,
      headline: "二维码生成中",
      detail: "会按风格和边距配置导出可直接使用的二维码图片。",
    },
    "unit-convert": {
      inputName: "长度换算",
      outputName: "换算结果",
      beforeSize: 0.1,
      afterSize: 0.1,
      duration: 1800,
      headline: "换算结果已准备",
      detail: "这类轻量工具处理很快，适合高频使用和收藏。",
    },
    "audio-convert": {
      inputName: "原音视频.mp4",
      outputName: "转换后文件.mp4",
      beforeSize: 8.2,
      afterSize: 12.4,
      duration: 6000,
      headline: "音视频格式转换中",
      detail: "会按目标格式和质量设置进行转换，适合不同设备使用。",
    },
  };

  const preset = presets[tool.id];

  return {
    id: `task_${now}`,
    toolId: tool.id,
    selections,
    createdAt: now,
    status: "processing",
    duration: preset.duration,
    inputName: preset.inputName,
    outputName: preset.outputName,
    beforeSize: preset.beforeSize,
    afterSize: preset.afterSize,
    resultHeadline: preset.headline,
    resultDetail: preset.detail,
    resultType: "async",
    outputPath: "",
    remoteUrl: "",
    previewPath: "",
    copyText: "",
    metaLines: [],
    attachments: [],
  };
}

function buildCompletedTaskPayload(tool, selections, options) {
  const now = Date.now();

  return {
    id: `task_${now}`,
    toolId: tool.id,
    selections,
    createdAt: now,
    status: options.status || "success",
    duration: options.duration || 0,
    inputName: options.inputName || "即时输入",
    outputName: options.outputName || tool.name,
    beforeSize: toMegabytes(options.beforeSize, options.beforeBytes),
    afterSize: toMegabytes(options.afterSize, options.afterBytes),
    resultHeadline: options.resultHeadline || `${tool.name} 已完成`,
    resultDetail: options.resultDetail || "",
    resultType: options.resultType || "text",
    resultText: options.resultText || "",
    copyText: options.copyText || options.resultText || "",
    outputPath: options.outputPath || "",
    remoteUrl: options.remoteUrl || "",
    previewPath: options.previewPath || options.outputPath || options.remoteUrl || "",
    sourcePath: options.sourcePath || "",
    sourcePreviewPath: options.sourcePreviewPath || options.sourcePath || "",
    metaLines: options.metaLines || [],
    attachments: options.attachments || [],
    requiresBackend: !!options.requiresBackend,
    backendUnavailable: !!options.backendUnavailable,
  };
}

function buildStatusText(status) {
  return {
    processing: "处理中",
    success: "已完成",
    failed: "处理失败",
    expired: "已过期",
  }[status] || "处理中";
}

function buildTaskResult(task, tool) {
  const resultMap = {
    "photo-id": "已生成基础版证件照，适合继续下载或重新调整底色。",
    "image-compress": "压缩收益较明显，适合直接发送或继续转 PDF。",
    "image-convert": "已输出目标格式，透明背景和压缩表现会同步提醒。",
    "resize-crop": "已适配目标画布，适合继续加字或放入海报模板。",
    "image-to-pdf": "图片已整理成单个 PDF，更方便提交和归档。",
    "pdf-compress": "体积已降低，适合邮箱发送与系统上传场景。",
    "pdf-merge": "多份文档已合并成一份，页序按设定保留。",
    "pdf-split": "长文档已拆成多个文件，便于分发和局部上传。",
    "office-to-pdf": "文档已导出为 PDF，版式更适合正式分享。",
    "ocr-text": "识别出约 1268 字，可继续复制和校对。",
    "qr-maker": "二维码已生成，适合直接保存到相册或继续排版。",
    "unit-convert": "换算结果已生成，并附常见近似值供参考。",
    "audio-convert": "音视频格式已转换，适合不同设备和场景使用。",
  };

  if (tool && tool.id && resultMap[tool.id]) {
    return resultMap[tool.id];
  }
  return task.resultDetail || task.resultText || "处理完成";
}

function isRemotePath(pathname) {
  return /^https?:\/\//i.test(String(pathname || ""));
}

function getPreviewPath(task) {
  if (task.resultType === "image" && task.outputPath && isRemotePath(task.previewPath)) {
    return task.outputPath;
  }

  return task.previewPath || task.outputPath || task.remoteUrl || "";
}

function normalizeTask(task) {
  const tool = getToolById(task.toolId);
  const now = Date.now();
  let status = task.status;
  let progress = 100;

  // 检查任务是否过期
  if (now - task.createdAt > TASK_RETENTION_MS) {
    status = "expired";
    progress = 100;
  } else if (task.status === "processing") {
    const elapsed = now - task.createdAt;
    progress = Math.min(100, Math.max(12, Math.round((elapsed / task.duration) * 100)));
    status = elapsed >= task.duration ? "success" : "processing";
  } else if (task.status === "failed") {
    status = "failed";
    progress = 100;
  }

  const savedSize = task.beforeSize && task.afterSize
    ? Math.max(task.beforeSize - task.afterSize, 0)
    : 0;
  const previewPath = getPreviewPath(task);

  // 只返回页面显示需要的字段，减少数据传输量
  return {
    id: task.id,
    toolId: task.toolId,
    tool: tool ? { name: tool.name, accent: tool.accent } : null, // 只保留工具的必要信息
    status,
    progress,
    statusText: buildStatusText(status),
    createdLabel: formatRelativeTime(task.createdAt),
    createdAtText: formatDateTime(task.createdAt),
    resultHeadline: task.resultHeadline,
    finalDetail: status === "success"
      ? (task.resultDetail || task.resultText || buildTaskResult(task, tool))
      : task.resultDetail,
    beforeSizeText: formatMegabytes(task.beforeSize),
    afterSizeText: formatMegabytes(task.afterSize),
    savedSizeText: formatMegabytes(savedSize),
    previewPath,
    // 保留完整信息用于任务详情页
    ...task,
  };
}

function listTasks() {
  return getRawTasks()
    .map(normalizeTask)
    .sort((left, right) => right.createdAt - left.createdAt);
}

function getTaskById(taskId) {
  const task = getRawTasks().find((item) => item.id === taskId);
  return task ? normalizeTask(task) : null;
}

function saveTaskEntry(task) {
  const tasks = [task].concat(getRawTasks());
  saveTasks(tasks.slice(0, 40));
  touchRecentTool(task.toolId);
  const normalizedTask = normalizeTask(task);
  return normalizedTask;
}

function createTask(tool, selections, options = {}) {
  const usage = options.skipUsage
    ? {
        usable: true,
        mode: "skipped",
        text: "",
        costText: "",
      }
    : commitUsage(tool);

  if (!usage.usable) {
    return {
      task: null,
      usage,
    };
  }

  const task = options.instant
    ? buildCompletedTaskPayload(tool, selections, options)
    : buildTaskPayload(tool, selections);

  return {
    task: saveTaskEntry(task),
    usage,
  };
}

function seedMockTasks() {
  if (getRawTasks().length) {
    return;
  }

  const now = Date.now();
  const seedTasks = [
    {
      id: "task_seed_1",
      toolId: "pdf-compress",
      selections: { mode: "均衡" },
      createdAt: now - 2 * 60 * 60 * 1000,
      status: "success",
      duration: 6000,
      inputName: "项目资料.pdf",
      outputName: "项目资料_压缩版.pdf",
      beforeSize: 15.2,
      afterSize: 6.8,
      resultHeadline: "PDF 压缩已完成",
      resultDetail: "体积明显下降，更适合发送和归档。",
      resultType: "async",
      outputPath: "",
      remoteUrl: "",
      previewPath: "",
      copyText: "",
      metaLines: [],
      attachments: [],
    },
    {
      id: "task_seed_2",
      toolId: "ocr-text",
      selections: { language: "中英混合", layout: "正文优先" },
      createdAt: now - 90 * 1000,
      status: "processing",
      duration: 5800,
      inputName: "会议纪要截图.png",
      outputName: "会议纪要.txt",
      beforeSize: 2.1,
      afterSize: 0.2,
      resultHeadline: "OCR 正在处理",
      resultDetail: "识别完成后可直接复制文本。",
      resultType: "async",
      outputPath: "",
      remoteUrl: "",
      previewPath: "",
      copyText: "",
      metaLines: [],
      attachments: [],
    },
    {
      id: "task_seed_3",
      toolId: "photo-id",
      selections: { size: "考试报名", background: "蓝底", retouch: "自然" },
      createdAt: now - 4 * 60 * 60 * 1000,
      status: "success",
      duration: 5200,
      inputName: "自拍照片.jpg",
      outputName: "报名照.png",
      beforeSize: 3.9,
      afterSize: 1.1,
      resultHeadline: "证件照生成完成",
      resultDetail: "标准蓝底照片已生成，可直接下载使用。",
      resultType: "async",
      outputPath: "",
      remoteUrl: "",
      previewPath: "",
      copyText: "",
      metaLines: [],
      attachments: [],
    },
  ];

  saveTasks(seedTasks);
  writeStorage(STORAGE_KEYS.recent, ["photo-id", "universal-compress", "ocr-text"]);
  writeStorage(STORAGE_KEYS.favorites, ["photo-id", "pdf-merge", "universal-compress"]);
  
  // 初始化一些积分记录
  const initialPointsRecords = [
    {
      id: "points_initial_1",
      type: "recharge",
      title: "新用户注册奖励",
      change: 50,
      createdAt: now - 7 * 24 * 60 * 60 * 1000,
    },
    {
      id: "points_initial_2",
      type: "consume",
      title: "PDF压缩",
      change: -10,
      createdAt: now - 2 * 60 * 60 * 1000,
    },
  ];
  writeStorage(STORAGE_KEYS.pointsRecords, initialPointsRecords);
  
  // 确保用户有初始积分
  const currentUser = getUserState();
  if (currentUser && !currentUser.points) {
    updateUserState({
      points: 100,
    }, { silent: true });
    
    // 添加新用户积分记录
    const initialPointsRecords = [
      {
        id: makeLocalId("pr"),
        type: "recharge",
        title: "新用户注册奖励",
        change: 100,
        createdAt: Date.now(),
      },
    ];
    writeStorage(STORAGE_KEYS.pointsRecords, initialPointsRecords);
  }
}

function getTaskDashboard() {
  const tasks = listTasks();
  const processingCount = tasks.filter((item) => item.status === "processing").length;
  const successCount = tasks.filter((item) => item.status === "success").length;
  const savedTotal = tasks.reduce((sum, item) => {
    if (item.status !== "success") {
      return sum;
    }

    const before = item.beforeSize || 0;
    const after = item.afterSize || 0;
    return sum + Math.max(before - after, 0);
  }, 0);

  return {
    processingCount,
    successCount,
    savedTotalText: formatMegabytes(savedTotal),
  };
}

function getPhotoIdStats() {
  return readStorage(STORAGE_KEYS.photoIdStats, {
    totalUsageCount: 0,
    lastUsedAt: null,
  });
}

function incrementPhotoIdUsage() {
  const stats = getPhotoIdStats();
  const nextStats = {
    totalUsageCount: stats.totalUsageCount + 1,
    lastUsedAt: nowIso(),
  };
  writeStorage(STORAGE_KEYS.photoIdStats, nextStats);
  return nextStats;
}

function setDailyFreeUsage(data) {
  writeStorage(STORAGE_KEYS.dailyFreeUsage, data);
}

function getSyncSnapshot() {
  return {
    user: getUserState(),
    tasks: getRawTasks(),
    favorites: getFavorites(),
    recentToolIds: getRecentToolIds(),
    pointsRecords: getPointsRecords(),
    orders: getOrders(),
    dailyFreeUsage: getDailyFreeUsage(),
  };
}

function getPointsRecords() {
  return readStorage(STORAGE_KEYS.pointsRecords, []);
}

function addPointsRecord(record) {
  const records = getPointsRecords();
  const entry = {
    id: makeLocalId("pr"),
    type: record.type || "consume",
    title: record.title || "",
    change: record.change || 0,
    balance: getUserState().points,
    createdAt: Date.now(),
    ...record,
  };
  records.unshift(entry);
  const next = records.slice(0, 100);
  writeStorage(STORAGE_KEYS.pointsRecords, next);
  markSyncDirty();
  return entry;
}

function getOrders() {
  return readStorage(STORAGE_KEYS.orders, []);
}

function addOrder(order) {
  const orders = getOrders();
  const entry = {
    id: makeLocalId("order"),
    status: "pending",
    createdAt: Date.now(),
    ...order,
  };
  orders.unshift(entry);
  const next = orders.slice(0, 50);
  writeStorage(STORAGE_KEYS.orders, next);
  markSyncDirty();
  return entry;
}

function updateOrder(orderId, patch) {
  const orders = getOrders();
  const index = orders.findIndex((item) => item.id === orderId);
  if (index === -1) return null;
  orders[index] = { ...orders[index], ...patch, updatedAt: Date.now() };
  writeStorage(STORAGE_KEYS.orders, orders);
  markSyncDirty();
  return orders[index];
}

function refundPointsIfLowCompression(taskId, tool) {
  if (!taskId || !tool || tool.points <= 0) return false;
  if (tool.id !== "universal-compress") return false;

  const task = getRawTasks().find((t) => t.id === taskId);
  if (!task) return false;

  const beforeSize = task.beforeSize;
  const afterSize = task.afterSize;
  if (!beforeSize || beforeSize <= 0) return false;

  const reduction = (beforeSize - (afterSize || beforeSize)) / beforeSize;
  if (reduction >= 0.1) return false;

  const user = getUserState();
  const refundAmount = tool.points;
  updateUserState({ points: user.points + refundAmount });
  addPointsRecord({
    type: "refund",
    title: `${tool.name}（压缩不足退还）`,
    change: refundAmount,
  });
  return true;
}

function consumePoints(tool) {
  const billing = getBillingPreview(tool);

  if (!billing.usable) {
    return { success: false, billing };
  }

  if (billing.mode === "free") {
    try {
      const membership = require('../services/membership');
      membership.consumeFreeQuota(tool.id);
    } catch {
      const user = getUserState();
      const nextQuota = Math.max(user.freeQuota - 1, 0);
      updateUserState({ freeQuota: nextQuota });
    }
    addPointsRecord({
      type: "free",
      title: `${tool.name}（免费体验）`,
      change: 0,
    });
    return { success: true, billing, mode: "free" };
  }

  if (billing.mode === "points") {
    const user = getUserState();
    const nextPoints = Math.max(user.points - tool.points, 0);
    updateUserState({ points: nextPoints });
    addPointsRecord({
      type: "consume",
      title: tool.name,
      change: -tool.points,
    });
    return { success: true, billing, mode: "points" };
  }

  return { success: false, billing };
}

function applyRemoteState(state, options = {}) {
  const cloudFirst = !!options.cloudFirst;
  console.log(cloudFirst ? "🔄 应用云端状态，云端数据优先" : "🔄 应用云端状态，本地数据优先");
  
  const snapshot = state || {};
  const currentUser = readStorage(STORAGE_KEYS.user, null);
  const localHasRealData = currentUser && (currentUser.points > 0 || currentUser.authMode === 'wechat');
  
  if (snapshot.user) {
    if (currentUser && localHasRealData && !cloudFirst) {
      const localTime = new Date(currentUser.updatedAt || 0).getTime();
      const remoteTime = new Date(snapshot.user.updatedAt || 0).getTime();
      
      const mergedUser = {
        ...snapshot.user,
        ...currentUser,
        points: Math.max(currentUser.points || 0, snapshot.user.points || 0),
        updatedAt: new Date(Math.max(localTime, remoteTime)).toISOString()
      };
      writeStorage(STORAGE_KEYS.user, mergedUser);
      console.log("✅ 用户数据已合并（本地优先，积分取最大值）");
    } else {
      const mergedUser = cloudFirst && currentUser
        ? {
            ...currentUser,
            ...snapshot.user,
            points: Math.max(currentUser.points || 0, snapshot.user.points || 0),
            updatedAt: new Date(Math.max(
              new Date(currentUser.updatedAt || 0).getTime(),
              new Date(snapshot.user.updatedAt || 0).getTime()
            )).toISOString()
          }
        : snapshot.user;
      writeStorage(STORAGE_KEYS.user, mergedUser);
      console.log(cloudFirst ? "✅ 用户数据已合并（云端优先，积分取最大值）" : "✅ 首次从云端获取用户数据");
    }
  }
  
  if (Array.isArray(snapshot.tasks) && snapshot.tasks.length > 0) {
    saveTasks(mergeTaskLists(getRawTasks(), snapshot.tasks), { silent: true });
  }

  if (Array.isArray(snapshot.favorites) && snapshot.favorites.length > 0) {
    setFavorites(snapshot.favorites, { silent: true });
  }

  if (Array.isArray(snapshot.recentToolIds) && snapshot.recentToolIds.length > 0) {
    setRecentToolIds(snapshot.recentToolIds, { silent: true });
  }

  if (Array.isArray(snapshot.pointsRecords) && snapshot.pointsRecords.length > 0) {
    const localRecords = readStorage(STORAGE_KEYS.pointsRecords, []);
    const mergedRecords = normalizeRecords([...localRecords, ...snapshot.pointsRecords], 200);
    writeStorage(STORAGE_KEYS.pointsRecords, mergedRecords);
  }

  if (Array.isArray(snapshot.orders) && snapshot.orders.length > 0) {
    const localOrders = readStorage(STORAGE_KEYS.orders, []);
    const mergedOrders = normalizeRecords([...localOrders, ...snapshot.orders], 100);
    writeStorage(STORAGE_KEYS.orders, mergedOrders);
  }

  if (snapshot.dailyFreeUsage) {
    const cloudFirst = !!options.cloudFirst;
    const localUsage = getDailyFreeUsage();
    const remoteUsage = snapshot.dailyFreeUsage;

    const todayKey = (() => {
      const today = new Date();
      return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    })();

    let mergedUsage;
    if (remoteUsage.date === todayKey && localUsage.date === todayKey) {
      const mergedTools = { ...remoteUsage.tools, ...localUsage.tools };
      mergedUsage = { date: todayKey, tools: mergedTools };
    } else if (remoteUsage.date === todayKey) {
      mergedUsage = remoteUsage;
    } else if (localUsage.date === todayKey) {
      mergedUsage = localUsage;
    } else {
      const newest = (remoteUsage.date || '') > (localUsage.date || '') ? remoteUsage : localUsage;
      mergedUsage = newest;
    }

    setDailyFreeUsage(mergedUsage);
  }

  clearSyncDirty();
  return getSyncSnapshot();
}

module.exports = {
  seedMockTasks,
  seedUserState,
  getUserState,
  updateUserState,
  logoutCurrentUser,
  getBillingPreview,
  createTask,
  listTasks,
  getTaskById,
  getTaskDashboard,
  toggleFavorite,
  isFavoriteTool,
  listFavoriteTools,
  getFavorites,
  setFavorites,
  touchRecentTool,
  getRecentTools,
  getRecentToolIds,
  setRecentToolIds,
  getRawTasks,
  hasDirtySyncState,
  getSyncDirtyStamp,
  clearSyncDirty,
  getSyncSnapshot,
  applyRemoteState,
  getPhotoIdStats,
  incrementPhotoIdUsage,
  getPointsRecords,
  addPointsRecord,
  getOrders,
  addOrder,
  updateOrder,
  consumePoints,
  refundPointsIfLowCompression,
  commitUsage,
};
