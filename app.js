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

        if (hasBackendService() && user.userId) {
          this._tryCloudRestore(user);
        }

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
      wx.reLaunch({
        url: '/pages/login/index',
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
