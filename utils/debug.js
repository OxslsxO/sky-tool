
function debugStorage() {
  console.log("=== 调试存储状态 ===");
  
  try {
    const userRaw = wx.getStorageSync("sky_tools_user");
    console.log("1. 用户原始存储:", userRaw);
    
    const pointsRecords = wx.getStorageSync("sky_tools_points_records");
    console.log("2. 积分记录:", pointsRecords);
    
    const orders = wx.getStorageSync("sky_tools_orders");
    console.log("3. 订单记录:", orders);
    
  } catch (e) {
    console.error("读取存储出错:", e);
  }
  
  console.log("=================");
}

function forceUpdateTest() {
  console.log("=== 强制更新测试 ===");
  
  try {
    const now = new Date();
    const expireDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const testUser = {
      nickname: "测试用户",
      points: 500,
      memberPlan: "月度会员",
      memberActive: true,
      memberExpire: expireDate.toISOString().split("T")[0],
      deviceId: "test_device_123",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    console.log("4. 要写入的测试数据:", testUser);
    wx.setStorageSync("sky_tools_user", testUser);
    console.log("5. 写入完成！");
    
    const verifyUser = wx.getStorageSync("sky_tools_user");
    console.log("6. 验证读取:", verifyUser);
    
  } catch (e) {
    console.error("测试失败:", e);
  }
}

module.exports = {
  debugStorage,
  forceUpdateTest
};
