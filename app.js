const { seedUserState, getUserState } = require("./utils/task-store");
const { syncCloudState, pullCloudState } = require("./utils/sync-manager");

App({
  globalData: {
    brandName: "晴空工具箱",
  },

  async onLaunch() {
    console.log("🚀 应用启动");
    
    // 检查登录状态
    const user = getUserState();
    const isLoggedIn = user && user.openid && user.authMode === 'wechat' && user.phoneNumber;
    
    if (isLoggedIn) {
      // 已登录，走正常流程
      console.log("✅ 已登录，准备数据");
      
      // 先尝试从云端拉取数据
      await pullCloudState().catch(err => {
        console.log("从云端拉取失败，使用本地初始化:", err);
      });
      
      // 确保用户状态初始化
      seedUserState();
      
      // 再进行同步（如有本地修改）
      syncCloudState().catch(() => {});
      
      // 跳转到首页
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/home/index',
        });
      }, 100);
    } else {
      // 未登录，保留在登录页
      console.log("❌ 未登录，等待用户登录");
    }
  },
});
