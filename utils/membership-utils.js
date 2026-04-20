const membership = require("../services/membership");
const { getUserState, getPointsRecords } = require("./task-store");
const { memberPlans, pointPackages, redeemCodeSamples } = require("../data/mock");

function formatPoints(points) {
  if (points >= 10000) {
    return (points / 10000).toFixed(1) + "万";
  }
  return String(points);
}

function formatDate(dateString) {
  if (!dateString) return "";
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMembershipInfo() {
  const status = membership.getMemberStatus();
  const user = getUserState();
  const summary = membership.getUsageSummary();

  return {
    active: status.active,
    expired: status.expired,
    plan: status.plan,
    expireDate: status.expireDate,
    remainingDays: status.remainingDays,
    points: user.points || 0,
    freeUsage: summary.freeUsage,
  };
}

function getToolBillingInfo(tool) {
  const preview = require("./task-store").getBillingPreview(tool);
  const memberInfo = getMembershipInfo();

  return {
    preview,
    memberInfo,
    tool,
  };
}

function getPricingData() {
  return {
    memberPlans: memberPlans.map((plan) => ({
      ...plan,
      isPopular: plan.recommended,
      originalPrice: plan.price,
    })),
    pointPackages: pointPackages.map((pkg) => ({
      ...pkg,
      totalPoints: pkg.points + (pkg.bonusPoints || 0),
      isBestValue: pkg.points >= 200,
    })),
    redeemCodeSamples: redeemCodeSamples,
  };
}

function getPointsHistory() {
  const records = getPointsRecords();
  return records
    .map((record) => ({
      id: record.id,
      type: record.type,
      title: record.title,
      change: record.change,
      balance: record.balance,
      createdAt: record.createdAt,
      date: formatDate(new Date(record.createdAt).toISOString()),
      time: new Date(record.createdAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    }))
    .filter((record) => record.change !== 0);
}

function calculateToolCost(tool, count = 1) {
  if (tool.memberFree) {
    return { free: true, points: 0, member: true };
  }
  return { free: false, points: tool.points * count, member: false };
}

function checkCanUseTool(tool) {
  const preview = require("./task-store").getBillingPreview(tool);
  return {
    canUse: preview.usable,
    reason: preview.text,
    mode: preview.mode,
    costText: preview.costText,
    needUpgrade: preview.needUpgrade,
  };
}

module.exports = {
  formatPoints,
  formatDate,
  getMembershipInfo,
  getToolBillingInfo,
  getPricingData,
  getPointsHistory,
  calculateToolCost,
  checkCanUseTool,
};
