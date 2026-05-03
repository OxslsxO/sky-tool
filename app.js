const { seedUserState, getUserState } = require("./utils/task-store");
const { isWechatIdentity } = require("./utils/auth-session");
const { clearServiceConfig } = require("./services/backend-tools");

App({
  globalData: {
    brandName: "万里工具箱",
  },

  onLaunch() {
    console.log("🚀 应用启动");

    try {
      // 清除旧的后端配置缓存，确保使用新的远程地址
      clearServiceConfig();

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
    } catch (error) {
      console.error("❌ 应用启动异常:", error);
      // 出现异常时也跳转到登录页，确保用户能正常使用
      wx.reLaunch({
        url: '/pages/login/index',
      });
    }
  },
});
