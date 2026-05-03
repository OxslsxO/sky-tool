const { getUserState, updateUserState, addPointsRecord } = require('../utils/task-store');

const STORAGE_KEYS = {
  dailyFreeUsage: 'sky_tools_daily_free',
  redeemCodes: 'sky_tools_redeem_codes',
  usageLogs: 'sky_tools_usage_logs',
};

const POINT_PACKAGES = [
  { id: 'p-10', points: 10, price: '1', bonus: '送 1 积分', bonusPoints: 1 },
  { id: 'p-20', points: 20, price: '2', bonus: '送 3 积分', bonusPoints: 3 },
  { id: 'p-30', points: 30, price: '3', bonus: '送 5 积分', bonusPoints: 5 },
  { id: 'p-50', points: 50, price: '5', bonus: '送 10 积分', bonusPoints: 10 },
];

const POINTS_SOURCE = {
  SIGN_IN: { type: 'earn', title: '每日签到', points: 5 },
  SHARE: { type: 'earn', title: '分享小程序', points: 10 },
  REVIEW: { type: 'earn', title: '好评反馈', points: 20 },
  TASK_COMPLETE: { type: 'earn', title: '完成任务', points: 3 },
  REDEEM_CODE: { type: 'earn', title: '兑换码兑换', points: 0 },
  PURCHASE: { type: 'earn', title: '购买积分', points: 0 },
};

function readStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value !== undefined && value !== null ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch {
  }
}

function getTodayKey() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function getDailyFreeUsage() {
  const todayKey = getTodayKey();
  const data = readStorage(STORAGE_KEYS.dailyFreeUsage, {});

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

function consumeFreeQuota(toolId) {
  const dailyUsage = getDailyFreeUsage();
  if (!dailyUsage.tools[toolId]) {
    dailyUsage.tools[toolId] = { count: 0 };
  }
  dailyUsage.tools[toolId].count += 1;
  dailyUsage.tools[toolId].lastUsedAt = Date.now();
  writeStorage(STORAGE_KEYS.dailyFreeUsage, dailyUsage);
  
  try {
    const { markSyncDirty } = require('../utils/task-store');
    markSyncDirty();
  } catch (e) {
  }
}

function addPoints(points, reason = '积分充值') {
  if (points <= 0) {
    return { success: false, message: '积分数量必须大于0' };
  }

  const user = getUserState();
  const newPoints = (user.points || 0) + points;
  updateUserState({ points: newPoints });

  addPointsRecord({
    type: 'earn',
    title: reason,
    change: points,
  });

  return { success: true, balance: newPoints };
}

function consumePoints(points, reason = '工具使用') {
  if (points <= 0) {
    return { success: false, message: '积分数量必须大于0' };
  }

  const user = getUserState();
  if ((user.points || 0) < points) {
    return { success: false, message: '积分不足' };
  }

  const newPoints = user.points - points;
  updateUserState({ points: newPoints });

  addPointsRecord({
    type: 'consume',
    title: reason,
    change: -points,
  });

  return { success: true, balance: newPoints };
}

function getUsagePriority(tool) {
  // 积分要求为 0 的工具直接免费，不限次数
  if (tool.points === 0) {
    return { priority: 'free', text: '免费使用', usable: true };
  }

  const hasFreeQuota = canUseFreeQuota(tool.id);

  if (hasFreeQuota) {
    return { priority: 'free', text: '使用免费次数', usable: true };
  }

  const user = getUserState();
  if ((user.points || 0) >= tool.points) {
    return { priority: 'points', text: `消耗${tool.points}积分`, usable: true };
  }

  return { priority: 'none', text: '积分不足，请充值', usable: false };
}

function commitToolUsage(tool) {
  const priority = getUsagePriority(tool);

  if (!priority.usable) {
    return { success: false, reason: priority.text };
  }

  if (priority.priority === 'free') {
    consumeFreeQuota(tool.id);
    addPointsRecord({
      type: 'free',
      title: `${tool.name}（免费次数）`,
      change: 0,
    });
    return { success: true, mode: 'free', text: '使用免费次数成功' };
  }

  if (priority.priority === 'points') {
    const result = consumePoints(tool.points, tool.name);
    if (!result.success) {
      return result;
    }
    return { success: true, mode: 'points', text: `消耗${tool.points}积分成功`, balance: result.balance };
  }

  return { success: false, reason: '未知错误' };
}

function getUsageSummary() {
  const user = getUserState();
  const dailyUsage = getDailyFreeUsage();

  const freeToolsUsed = Object.keys(dailyUsage.tools).filter(
    (toolId) => dailyUsage.tools[toolId] && dailyUsage.tools[toolId].count >= 1
  ).length;

  return {
    points: user.points || 0,
    freeUsage: {
      date: dailyUsage.date,
      usedCount: freeToolsUsed,
      tools: dailyUsage.tools,
    },
  };
}

function addUsageLog(toolId, mode) {
  const logs = readStorage(STORAGE_KEYS.usageLogs, []);
  const log = {
    id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    toolId,
    mode,
    timestamp: Date.now(),
    createdAt: new Date().toISOString(),
  };

  logs.unshift(log);
  const trimmedLogs = logs.slice(0, 200);
  writeStorage(STORAGE_KEYS.usageLogs, trimmedLogs);

  return log;
}

function validateAndRedeemCode(code) {
  if (!code || !code.trim()) {
    return { success: false, message: '请输入兑换码' };
  }

  const codeUpper = code.trim().toUpperCase();
  const redeemRules = {
    'WELCOME100': { type: 'points', value: 100, title: '新用户礼包', maxUse: 1 },
    'POINTS50': { type: 'points', value: 50, title: '积分奖励', maxUse: 1 },
  };

  const rule = redeemRules[codeUpper];
  if (!rule) {
    return { success: false, message: '无效的兑换码' };
  }

  const usedCodes = readStorage('sky_tools_used_redeem_codes', {});
  if (usedCodes[codeUpper]) {
    return { success: false, message: '该兑换码已使用' };
  }

  usedCodes[codeUpper] = {
    usedAt: Date.now(),
    rule,
  };
  writeStorage('sky_tools_used_redeem_codes', usedCodes);

  if (rule.type === 'points') {
    const result = addPoints(rule.value, rule.title);
    if (result.success) {
      return { success: true, type: 'points', value: rule.value, title: rule.title, balance: result.balance };
    }
    return result;
  }

  return { success: false, message: '兑换失败' };
}

function getPointPackages() {
  return POINT_PACKAGES;
}

function getPointsSourceConfig() {
  return POINTS_SOURCE;
}

module.exports = {
  addPoints,
  consumePoints,
  getUsagePriority,
  commitToolUsage,
  getUsageSummary,
  canUseFreeQuota,
  consumeFreeQuota,
  addUsageLog,
  validateAndRedeemCode,
  getPointPackages,
  getPointsSourceConfig,
  getTodayKey,
};
