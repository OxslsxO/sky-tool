const { seedUserState } = require("./utils/task-store");
const { syncCloudState } = require("./utils/sync-manager");

App({
  globalData: {
    brandName: "晴空工具箱",
  },

  onLaunch() {
    seedUserState();
    syncCloudState().catch(() => {});
  },
});
