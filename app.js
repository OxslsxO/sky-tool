const { seedUserState, getUserState } = require("./utils/task-store");
const { isWechatIdentity } = require("./utils/auth-session");
const { clearServiceConfig, hasBackendService } = require("./services/backend-tools");

App({
  globalData: {
    brandName: "万里工具箱",
  },

  onLaunch() {
    console.log("🚀 应用启动");

    try {
      clearServiceConfig();

      const user = getUserState();
      const isLoggedIn = isWechatIdentity(user);

      if (isLoggedIn) {
        console.log("✅ 已登录，准备数据");
        seedUserState();

        // 延迟云端恢复，不阻塞启动
        if (hasBackendService() && user.userId) {
          setTimeout(() => {
            this._tryCloudRestore(user);
          }, 2000);
        }
      } else {
        console.log("👤 游客模式，初始化本地数据");
        seedUserState();
      }

      // 直接跳转到首页，允许游客访问
      wx.switchTab({
        url: '/pages/home/index',
      });
    } catch (error) {
      console.error("❌ 应用启动异常:", error);
      wx.switchTab({
        url: '/pages/home/index',
      });
    }
  },

  _tryCloudRestore(user) {
    const { fetchClientState } = require("./services/state-sync");
    const { applyRemoteState } = require("./utils/task-store");

    fetchClientState({ userId: user.userId })
      .then((stateResult) => {
        if (stateResult && stateResult.ok && stateResult.state) {
          console.log("✅ 启动时从云端恢复数据，积分:", stateResult.state.user?.points);
          applyRemoteState(stateResult.state, { cloudFirst: true });
        }
      })
      .catch((err) => {
        console.warn("⚠️ 启动时云端恢复失败:", err);
      });
  },
});
