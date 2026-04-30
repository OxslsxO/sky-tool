const {
  listFavoriteTools,
  getRecentTools,
  getUserState,
  listTasks,
  updateUserState,
  addPointsRecord,
} = require("../../utils/task-store");
const { ensureWechatLogin } = require("../../utils/page-auth");

const REDEEM_CODES = {
  "万里第一帅": {
    type: "points",
    points: 100,
    description: "100积分",
  },
};

Page({
  data: {
    user: {},
    favorites: [],
    recents: [],
    taskCount: 0,
    showRedeemModal: false,
    redeemInput: "",
    redeeming: false,
  },

  onShow() {
    if (!ensureWechatLogin()) {
      return;
    }

    this.refreshPage();

    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 3,
      });
    }
  },

  refreshPage() {
    const user = getUserState();

    this.setData({
      user,
      favorites: listFavoriteTools(),
      recents: getRecentTools(),
      taskCount: listTasks().length,
    });
  },

  handleToolSelect(event) {
    const { id } = event.detail;
    wx.navigateTo({
      url: `/pages/tool-detail/index?id=${id}`,
    });
  },

  openRedeemModal() {
    this.setData({
      showRedeemModal: true,
      redeemInput: "",
    });
  },

  closeRedeemModal() {
    this.setData({
      showRedeemModal: false,
      redeemInput: "",
    });
  },

  preventBubble() {},

  onRedeemInput(e) {
    this.setData({
      redeemInput: e.detail.value,
    });
  },

  handleRedeem() {
    const code = this.data.redeemInput.trim();
    if (!code) {
      wx.showToast({ title: "请输入口令", icon: "none" });
      return;
    }

    const reward = REDEEM_CODES[code];
    if (!reward) {
      wx.showToast({ title: "口令无效，请重新输入", icon: "none" });
      return;
    }

    if (this.data.redeeming) return;
    this.setData({ redeeming: true });

    try {
      if (reward.type === "points") {
        const user = getUserState();
        updateUserState({
          points: user.points + reward.points,
        });

        addPointsRecord({
          type: "recharge",
          title: `口令兑换${reward.points}积分`,
          change: reward.points,
        });

        wx.showToast({ title: `兑换成功！+${reward.points}积分`, icon: "none" });
      }

      this.setData({
        showRedeemModal: false,
        redeemInput: "",
      });

      this.refreshPage();
    } catch (error) {
      wx.showToast({ title: "兑换失败", icon: "none" });
    } finally {
      this.setData({ redeeming: false });
    }
  },

});
