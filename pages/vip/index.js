const { memberPlans, pointPackages } = require("../../data/mock");
const {
  getUserState,
  getMemberStatus,
  getPointsRecords,
} = require("../../utils/task-store");
const { purchaseMember, purchasePoints } = require("../../services/payment");
const { hasBackendService } = require("../../services/backend-tools");
const { formatRelativeTime } = require("../../utils/format");

Page({
  data: {
    user: {},
    memberStatus: {},
    memberPlans,
    pointPackages,
    pointsRecords: [],
    selectedPlan: null,
    selectedPackage: null,
    purchasing: false,
    backendConfigured: false,
    tab: "member",
  },

  onShow() {
    this.refreshPage();
  },

  refreshPage() {
    const user = getUserState();
    const memberStatus = getMemberStatus();
    const records = getPointsRecords().slice(0, 20).map((item) => ({
      ...item,
      changeText: item.change > 0 ? `+${item.change}` : `${item.change}`,
      changeClass: item.change > 0 ? "record-plus" : (item.change < 0 ? "record-minus" : "record-zero"),
      timeLabel: formatRelativeTime(item.createdAt),
    }));

    this.setData({
      user,
      memberStatus,
      pointsRecords: records,
      backendConfigured: hasBackendService(),
    });
  },

  switchTab(event) {
    const { tab } = event.currentTarget.dataset;
    this.setData({ tab });
  },

  selectPlan(event) {
    const { id } = event.currentTarget.dataset;
    const plan = memberPlans.find((item) => item.id === id);
    this.setData({ selectedPlan: plan || null });
  },

  selectPackage(event) {
    const { id } = event.currentTarget.dataset;
    const pkg = pointPackages.find((item) => item.id === id);
    this.setData({ selectedPackage: pkg || null });
  },

  async handleBuyMember() {
    const { selectedPlan, purchasing } = this.data;
    if (!selectedPlan || purchasing) return;

    if (!this.data.backendConfigured) {
      this.simulatePurchaseMember(selectedPlan);
      return;
    }

    this.setData({ purchasing: true });
    try {
      const result = await purchaseMember(selectedPlan);
      if (result.success) {
        wx.showToast({ title: result.message, icon: "none" });
        this.setData({ selectedPlan: null });
        this.refreshPage();
      } else if (!result.cancelled) {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } catch (error) {
      wx.showToast({ title: "支付失败", icon: "none" });
    } finally {
      this.setData({ purchasing: false });
    }
  },

  async handleBuyPoints() {
    const { selectedPackage, purchasing } = this.data;
    if (!selectedPackage || purchasing) return;

    if (!this.data.backendConfigured) {
      this.simulatePurchasePoints(selectedPackage);
      return;
    }

    this.setData({ purchasing: true });
    try {
      const result = await purchasePoints(selectedPackage);
      if (result.success) {
        wx.showToast({ title: result.message, icon: "none" });
        this.setData({ selectedPackage: null });
        this.refreshPage();
      } else if (!result.cancelled) {
        wx.showToast({ title: result.message, icon: "none" });
      }
    } catch (error) {
      wx.showToast({ title: "支付失败", icon: "none" });
    } finally {
      this.setData({ purchasing: false });
    }
  },

  simulatePurchaseMember(plan) {
    const { updateUserState, addPointsRecord } = require("../../utils/task-store");
    const now = new Date();
    const periodDays = parseInt(plan.period, 10) || 30;
    const expireDate = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

    updateUserState({
      memberPlan: plan.name,
      memberActive: true,
      memberExpire: expireDate.toISOString().split("T")[0],
    });

    addPointsRecord({
      type: "member",
      title: `开通${plan.name}`,
      change: 0,
      price: plan.price,
    });

    wx.showToast({ title: `已开通${plan.name}`, icon: "none" });
    this.setData({ selectedPlan: null });
    this.refreshPage();
  },

  simulatePurchasePoints(pkg) {
    const { getUserState, updateUserState, addPointsRecord } = require("../../utils/task-store");
    const bonusMatch = pkg.bonus.match(/(\d+)/);
    const bonusPoints = bonusMatch ? parseInt(bonusMatch[1], 10) : 0;
    const totalPoints = pkg.points + bonusPoints;
    const user = getUserState();

    updateUserState({
      points: user.points + totalPoints,
    });

    addPointsRecord({
      type: "recharge",
      title: `充值${pkg.points}积分`,
      change: totalPoints,
      price: pkg.price,
    });

    wx.showToast({ title: `已充值${totalPoints}积分`, icon: "none" });
    this.setData({ selectedPackage: null });
    this.refreshPage();
  },

  // 调试用：快捷充值10000积分
  debugAddPoints() {
    const { getUserState, updateUserState, addPointsRecord } = require("../../utils/task-store");
    const user = getUserState();
    const addPoints = 10000;

    updateUserState({
      points: user.points + addPoints,
    });

    addPointsRecord({
      type: "recharge",
      title: "调试充值",
      change: addPoints,
    });

    wx.showToast({ title: `已充值${addPoints}积分`, icon: "success" });
    this.refreshPage();
  },
});
