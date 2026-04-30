const { seedUserState, getUserState } = require("./utils/task-store");
const { isWechatIdentity } = require("./utils/auth-session");
const { syncCloudState, pullCloudState } = require("./utils/sync-manager");

App({
  globalData: {
    brandName: "万里工具箱",
  },

  async onLaunch() {
    console.log("🚀 应用启动");

    const user = getUserState();
    const isLoggedIn = isWechatIdentity(user);

    if (isLoggedIn) {
      console.log("✅ 已登录，准备数据");
      seedUserState();
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/home/index',
        });
      }, 100);
    } else {
      console.log("❌ 未登录，跳转登录页");
      wx.reLaunch({
        url: '/pages/login/index',
      });
    }
  },
});
