const { pointPackages } = require("../../data/mock");
const {
  getUserState,
  getPointsRecords,
} = require("../../utils/task-store");
const { purchasePoints } = require("../../services/payment");
const { hasBackendService } = require("../../services/backend-tools");
const { formatRelativeTime } = require("../../utils/format");
const { ensureWechatLogin } = require("../../utils/page-auth");

Page({
  data: {
    user: {},
    pointPackages,
    pointsRecords: [],
    selectedPackage: null,
    purchasing: false,
    backendConfigured: false,
    tab: "points",
  },

  onShow() {
    if (!ensureWechatLogin()) {
      return;
    }

    this.refreshPage();

    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 2
      });
    }
  },

  refreshPage() {
    const user = getUserState();
    const records = getPointsRecords().slice(0, 20).map((item) => ({
      ...item,
      changeText: item.change > 0 ? `+${item.change}` : `${item.change}`,
      changeClass: item.change > 0 ? "record-plus" : (item.change < 0 ? "record-minus" : "record-zero"),
      timeLabel: formatRelativeTime(item.createdAt),
    }));

    this.setData({
      user,
      pointsRecords: records,
      backendConfigured: hasBackendService(),
    });
  },

  switchTab(event) {
    const { tab } = event.currentTarget.dataset;
    this.setData({ tab });
  },

  selectPackage(event) {
    const { id } = event.currentTarget.dataset;
    const pkg = pointPackages.find((item) => item.id === id);
    this.setData({ selectedPackage: pkg || null });
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
