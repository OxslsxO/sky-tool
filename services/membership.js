const { getUserState, updateUserState, addPointsRecord } = require('../utils/task-store');

const STORAGE_KEYS = {
  dailyFreeUsage: 'sky_tools_daily_free',
  redeemCodes: 'sky_tools_redeem_codes',
  usageLogs: 'sky_tools_usage_logs',
};

const MEMBERSHIP_PLANS = [
  { id: 'trial', name: '体验周卡', durationDays: 7, price: '9.9', highlight: '低门槛体验高频工具', recommended: false },
  { id: 'month', name: '月度会员', durationDays: 30, price: '29', highlight: '主推，适合高频使用图片与 PDF 工具', recommended: true },
  { id: 'season', name: '季度会员', durationDays: 90, price: '68', highlight: '单日成本更低，适合上班族和学生季节性需求', recommended: false },
  { id: 'year', name: '年度会员', durationDays: 365, price: '198', highlight: '年度超值套餐，适合长期高频使用', recommended: false },
];

const POINT_PACKAGES = [
  { id: 'p-50', points: 50, price: '8', bonus: '送 5 积分', bonusPoints: 5 },
  { id: 'p-100', points: 100, price: '15', bonus: '送 15 积分', bonusPoints: 15 },
  { id: 'p-200', points: 200, price: '28', bonus: '送 40 积分', bonusPoints: 40 },
  { id: 'p-500', points: 500, price: '68', bonus: '送 120 积分', bonusPoints: 120 },
];

const POINTS_SOURCE = {
  SIGN_IN: { type: 'earn', title: '每日签到', points: 5 },
  SHARE: { type: 'earn', title: '分享小程序', points: 10 },
  REVIEW: { type: 'earn', title: '好评反馈', points: 20 },
  TASK_COMPLETE: { type: 'earn', title: '完成任务', points: 3 },
  REDEEM_CODE: { type: 'earn', title: '兑换码兑换', points: 0 },
  PURCHASE: { type: 'earn', title: '购买积分', points: 0 },
  MEMBER_GIFT: { type: 'earn', title: '会员礼包', points: 50 },
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
}

function getMemberStatus() {
  const user = getUserState();
  if (!user.memberActive || !user.memberExpire) {
    return {
      active: false,
      expired: true,
      plan: null,
      expireDate: null,
      remainingDays: 0,
    };
  }

  const expireDate = new Date(user.memberExpire);
  const now = new Date();
  const expired = now > expireDate;

  if (expired && user.memberActive) {
    updateUserState({ memberActive: false });
  }

  const remainingDays = expired ? 0 : Math.ceil((expireDate - now) / (24 * 60 * 60 * 1000));

  return {
    active: !expired,
    expired,
    plan: user.memberPlan || '普通会员',
    expireDate: user.memberExpire,
    remainingDays,
  };
}

function activateMembership(planId) {
  const plan = MEMBERSHIP_PLANS.find((p) => p.id === planId);
  if (!plan) {
    return { success: false, message: '无效的会员套餐' };
  }

  const user = getUserState();
  const now = new Date();
  let newExpireDate;

  if (user.memberActive && user.memberExpire) {
    const currentExpire = new Date(user.memberExpire);
    newExpireDate = new Date(Math.max(now.getTime(), currentExpire.getTime()) + plan.durationDays * 24 * 60 * 60 * 1000);
  } else {
    newExpireDate = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
  }

  updateUserState({
    memberActive: true,
    memberPlan: plan.name,
    memberExpire: newExpireDate.toISOString().split('T')[0],
  });

  addPointsRecord({
    type: 'member_activate',
    title: `开通${plan.name}`,
    change: 0,
  });

  if (plan.id === 'month' || plan.id === 'season' || plan.id === 'year') {
    const bonusPoints = plan.id === 'year' ? 100 : (plan.id === 'season' ? 50 : 20);
    addPoints(bonusPoints, '开通会员礼包');
  }

  return {
    success: true,
    plan,
    expireDate: newExpireDate.toISOString().split('T')[0],
  };
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
  const memberStatus = getMemberStatus();
  const hasFreeQuota = canUseFreeQuota(tool.id);

  if (hasFreeQuota) {
    return { priority: 'free', text: '使用免费次数', usable: true };
  }

  if (memberStatus.active && tool.memberFree) {
    return { priority: 'member', text: '使用会员权益', usable: true };
  }

  const user = getUserState();
  if ((user.points || 0) >= tool.points) {
    return { priority: 'points', text: `消耗${tool.points}积分`, usable: true };
  }

  return { priority: 'none', text: '积分不足，请充值或开通会员', usable: false };
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

  if (priority.priority === 'member') {
    addPointsRecord({
      type: 'member',
      title: `${tool.name}（会员权益）`,
      change: 0,
    });
    return { success: true, mode: 'member', text: '使用会员权益成功' };
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
  const memberStatus = getMemberStatus();
  const dailyUsage = getDailyFreeUsage();

  const freeToolsUsed = Object.keys(dailyUsage.tools).filter(
    (toolId) => dailyUsage.tools[toolId] && dailyUsage.tools[toolId].count >= 1
  ).length;

  return {
    points: user.points || 0,
    member: memberStatus,
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
    'VIP7DAYS': { type: 'member', value: 7, title: '7天会员体验', maxUse: 1 },
    'POINTS50': { type: 'points', value: 50, title: '积分奖励', maxUse: 1 },
    'FREETRIAL': { type: 'member', value: 3, title: '3天免费体验', maxUse: 1 },
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

  if (rule.type === 'member') {
    const user = getUserState();
    const now = new Date();
    let newExpireDate;

    if (user.memberActive && user.memberExpire) {
      const currentExpire = new Date(user.memberExpire);
      newExpireDate = new Date(Math.max(now.getTime(), currentExpire.getTime()) + rule.value * 24 * 60 * 60 * 1000);
    } else {
      newExpireDate = new Date(now.getTime() + rule.value * 24 * 60 * 60 * 1000);
    }

    updateUserState({
      memberActive: true,
      memberPlan: rule.title,
      memberExpire: newExpireDate.toISOString().split('T')[0],
    });

    addPointsRecord({
      type: 'member_activate',
      title: rule.title,
      change: 0,
    });

    return {
      success: true,
      type: 'member',
      value: rule.value,
      title: rule.title,
      expireDate: newExpireDate.toISOString().split('T')[0],
    };
  }

  return { success: false, message: '兑换失败' };
}

function getMembershipPlans() {
  return MEMBERSHIP_PLANS;
}

function getPointPackages() {
  return POINT_PACKAGES;
}

function getPointsSourceConfig() {
  return POINTS_SOURCE;
}

module.exports = {
  getMemberStatus,
  activateMembership,
  addPoints,
  consumePoints,
  getUsagePriority,
  commitToolUsage,
  getUsageSummary,
  canUseFreeQuota,
  consumeFreeQuota,
  addUsageLog,
  validateAndRedeemCode,
  getMembershipPlans,
  getPointPackages,
  getPointsSourceConfig,
  getTodayKey,
};
