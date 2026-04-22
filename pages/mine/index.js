const {
  listFavoriteTools,
  getRecentTools,
  getUserState,
  listTasks,
  getMemberStatus,
  updateUserState,
  addPointsRecord,
} = require("../../utils/task-store");

const REDEEM_CODES = {
  "万里第一帅": {
    type: "member",
    name: "体验周卡",
    durationDays: 7,
    description: "7天体验周卡",
  },
};

Page({
  data: {
    user: {},
    memberStatus: {},
    favorites: [],
    recents: [],
    taskCount: 0,
    showRedeemModal: false,
    redeemInput: "",
    redeeming: false,
  },

  onShow() {
    this.refreshPage();

    if (typeof this.getTabBar === "function" && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 3,
      });
    }
  },

  refreshPage() {
    const user = getUserState();
    const memberStatus = getMemberStatus();

    this.setData({
      user,
      memberStatus,
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

  openVip() {
    wx.switchTab({
      url: "/pages/vip/index",
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

  preventBubble() {
    // 阻止事件冒泡，防止点击弹窗内容时关闭
  },

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
      if (reward.type === "member") {
        const user = getUserState();
        const memberStatus = getMemberStatus();
        const now = new Date();
        let baseDate = now;

        if (memberStatus.active && user.memberExpire) {
          const expireDate = new Date(user.memberExpire);
          if (expireDate > now) {
            baseDate = expireDate;
          }
        }

        const newExpire = new Date(
          baseDate.getTime() + reward.durationDays * 24 * 60 * 60 * 1000
        );

        updateUserState({
          memberPlan: reward.name,
          memberActive: true,
          memberExpire: newExpire.toISOString().split("T")[0],
        });

        addPointsRecord({
          type: "member",
          title: `口令兑换${reward.description}`,
          change: 0,
        });

        wx.showToast({ title: `兑换成功！${reward.description}`, icon: "none" });
      } else if (reward.type === "points") {
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
