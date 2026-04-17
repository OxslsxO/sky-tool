const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");
const {
  getUserState,
  updateUserState,
  addPointsRecord,
} = require("../utils/task-store");

function requestPayment(orderInfo) {
  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: orderInfo.timeStamp,
      nonceStr: orderInfo.nonceStr,
      package: orderInfo.package,
      signType: orderInfo.signType || "MD5",
      paySign: orderInfo.paySign,
      success: resolve,
      fail: (err) => {
        const errMsg = err.errMsg || "";
        if (errMsg.indexOf("cancel") > -1) {
          reject({ code: "CANCEL", message: "用户取消支付" });
        } else if (errMsg.indexOf("no permission") > -1) {
          reject({ code: "NO_PERMISSION", message: "微信支付权限未开通" });
        } else {
          reject({ code: "PAY_ERROR", message: errMsg || "支付失败" });
        }
      },
    });
  });
}

function createOrder(type, itemId) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: buildServiceUrl("/api/pay/create"),
      method: "POST",
      header: {
        "content-type": "application/json",
        ...getServiceHeaders(),
      },
      data: { type, itemId },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
        } else {
          reject(response.data || new Error("CREATE_ORDER_FAILED"));
        }
      },
      fail: reject,
    });
  });
}

function verifyPayment(orderId) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: buildServiceUrl("/api/pay/verify"),
      method: "POST",
      header: {
        "content-type": "application/json",
        ...getServiceHeaders(),
      },
      data: { orderId },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
        } else {
          reject(response.data || new Error("VERIFY_FAILED"));
        }
      },
      fail: reject,
    });
  });
}

function simulateMemberPurchase(plan) {
  const now = new Date();
  const periodDays = parsePeriodDays(plan.period);
  const expireDate = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

  updateUserState({
    memberPlan: plan.name,
    memberActive: true,
    memberExpire: expireDate.toISOString().split("T")[0],
  });

  addPointsRecord({
    type: "member",
    title: `开通${plan.name}`,
    change: 0,
    planId: plan.id,
    price: plan.price,
  });

  return { success: true, message: `已开通${plan.name}` };
}

function simulatePointsPurchase(packageItem) {
  const bonusMatch = packageItem.bonus.match(/(\d+)/);
  const bonusPoints = bonusMatch ? parseInt(bonusMatch[1], 10) : 0;
  const totalPoints = packageItem.points + bonusPoints;

  const user = getUserState();
  updateUserState({
    points: user.points + totalPoints,
  });

  addPointsRecord({
    type: "recharge",
    title: `充值${packageItem.points}积分`,
    change: totalPoints,
    packageId: packageItem.id,
    price: packageItem.price,
  });

  return { success: true, message: `已充值${totalPoints}积分` };
}

async function purchaseMember(plan) {
  try {
    const orderResult = await createOrder("member", plan.id);
    if (!orderResult.orderId || !orderResult.payment) {
      throw new Error("订单创建失败");
    }

    await requestPayment(orderResult.payment);

    const verifyResult = await verifyPayment(orderResult.orderId);
    if (verifyResult.success) {
      return simulateMemberPurchase(plan);
    }

    throw new Error("支付验证失败");
  } catch (error) {
    if (error.code === "CANCEL") {
      return { success: false, message: "已取消支付", cancelled: true };
    }
    if (error.code === "NO_PERMISSION") {
      return simulateMemberPurchase(plan);
    }
    return { success: false, message: error.message || "支付失败" };
  }
}

async function purchasePoints(packageItem) {
  try {
    const orderResult = await createOrder("points", packageItem.id);
    if (!orderResult.orderId || !orderResult.payment) {
      throw new Error("订单创建失败");
    }

    await requestPayment(orderResult.payment);

    const verifyResult = await verifyPayment(orderResult.orderId);
    if (verifyResult.success) {
      return simulatePointsPurchase(packageItem);
    }

    throw new Error("支付验证失败");
  } catch (error) {
    if (error.code === "CANCEL") {
      return { success: false, message: "已取消支付", cancelled: true };
    }
    if (error.code === "NO_PERMISSION") {
      return simulatePointsPurchase(packageItem);
    }
    return { success: false, message: error.message || "支付失败" };
  }
}

function parsePeriodDays(period) {
  const match = period.match(/(\d+)/);
  if (!match) return 30;
  return parseInt(match[1], 10);
}

function checkMemberExpired() {
  const user = getUserState();
  if (!user.memberActive || !user.memberExpire) {
    return true;
  }

  const expireDate = new Date(user.memberExpire);
  const now = new Date();
  if (now > expireDate) {
    updateUserState({
      memberActive: false,
    });
    return true;
  }

  return false;
}

module.exports = {
  createOrder,
  requestPayment,
  verifyPayment,
  purchaseMember,
  purchasePoints,
  checkMemberExpired,
  simulateMemberPurchase,
  simulatePointsPurchase,
};
