const { seedUserState, getUserState } = require("./utils/task-store");
const { isWechatIdentity } = require("./utils/auth-session");
const { hasBackendService, warmUpBackend } = require("./services/backend-tools");

App({
  globalData: {
    brandName: "万里工具箱",
    backendReady: false,
  },

  onLaunch() {
    console.log("🚀 应用启动");

    try {
      const user = getUserState();
      const isLoggedIn = isWechatIdentity(user);

      if (isLoggedIn) {
        console.log("✅ 已登录，准备数据");
        seedUserState();

        if (hasBackendService()) {
          this._warmUpAndRestore(user);
        }
      } else {
        console.log("👤 游客模式，初始化本地数据");
        seedUserState();
      }

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

  _warmUpAndRestore(user) {
    warmUpBackend()
      .then((result) => {
        if (result.ok) {
          this.globalData.backendReady = true;
          if (user.userId) {
            this._tryCloudRestore(user);
          }
        } else {
          console.warn("⚠️ 后端唤醒失败，部分功能可能不可用");
        }
      })
      .catch((err) => {
        console.warn("⚠️ 后端唤醒异常:", err);
      });
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
