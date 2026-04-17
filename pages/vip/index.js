const { memberPlans, pointPackages } = require("../../data/mock");
const { getUserState } = require("../../utils/task-store");

Page({
  data: {
    user: {},
    memberPlans,
    pointPackages,
  },

  onShow() {
    this.setData({
      user: getUserState(),
    });
  },

  handlePlanTap(event) {
    const { name } = event.currentTarget.dataset;
    wx.showToast({
      title: `${name} 已加入演示清单`,
      icon: "none",
    });
  },

  handlePointTap(event) {
    const { points } = event.currentTarget.dataset;
    wx.showToast({
      title: `${points} 积分包待接支付`,
      icon: "none",
    });
  },
});
