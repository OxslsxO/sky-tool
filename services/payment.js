const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");
const {
  getUserState,
  updateUserState,
  addPointsRecord,
  addOrder,
  updateOrder,
} = require("../utils/task-store");

const RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
          return;
        }

        if (errMsg.indexOf("no permission") > -1) {
          reject({ code: "NO_PERMISSION", message: "微信支付权限未开通" });
          return;
        }

        reject({ code: "PAY_ERROR", message: errMsg || "支付失败" });
      },
    });
  });
}

async function createOrder(type, itemId, retryCount = 0) {
  const user = getUserState();

  try {
    const response = await new Promise((resolve, reject) => {
      wx.request({
        url: buildServiceUrl("/api/pay/create"),
        method: "POST",
        header: {
          "content-type": "application/json",
          ...getServiceHeaders(),
        },
        data: {
          type,
          itemId,
          userId: user.userId,
          deviceId: user.deviceId,
        },
        success: resolve,
        fail: reject,
      });
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.data;
    }

    throw response.data || new Error("CREATE_ORDER_FAILED");
  } catch (error) {
    if (retryCount < RETRY_CONFIG.maxRetries) {
      await delay(RETRY_CONFIG.retryDelay);
      return createOrder(type, itemId, retryCount + 1);
    }
    throw error;
  }
}

async function verifyPayment(orderId, retryCount = 0) {
  const user = getUserState();

  try {
    const response = await new Promise((resolve, reject) => {
      wx.request({
        url: buildServiceUrl("/api/pay/verify"),
        method: "POST",
        header: {
          "content-type": "application/json",
          ...getServiceHeaders(),
        },
        data: {
          orderId,
          userId: user.userId,
          deviceId: user.deviceId,
        },
        success: resolve,
        fail: reject,
      });
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.data;
    }

    throw response.data || new Error("VERIFY_FAILED");
  } catch (error) {
    if (retryCount < RETRY_CONFIG.maxRetries) {
      await delay(RETRY_CONFIG.retryDelay);
      return verifyPayment(orderId, retryCount + 1);
    }
    throw error;
  }
}

function parsePeriodDays(period) {
  const match = String(period || "").match(/(\d+)/);
  if (!match) {
    return 30;
  }

  return parseInt(match[1], 10);
}

function activateMemberDirectly(plan) {
  const now = new Date();
  const periodDays = plan.durationDays || parsePeriodDays(plan.period);
  let newExpireDate;

  try {
    const currentUser = getUserState();

    if (currentUser.memberActive && currentUser.memberExpire) {
      const currentExpire = new Date(currentUser.memberExpire);
      newExpireDate = new Date(Math.max(now.getTime(), currentExpire.getTime()) + periodDays * 24 * 60 * 60 * 1000);
    } else {
      newExpireDate = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
    }

    let newPoints = currentUser.points || 0;
    
    if (plan.id === 'month' || plan.id === 'season' || plan.id === 'year') {
      const bonusPoints = plan.id === 'year' ? 100 : (plan.id === 'season' ? 50 : 20);
      newPoints += bonusPoints;
    }

    const updatedUser = updateUserState({
      memberPlan: plan.name,
      memberActive: true,
      memberExpire: newExpireDate.toISOString().split("T")[0],
      points: newPoints
    });

    addPointsRecord({
      type: "member",
      title: `开通${plan.name}`,
      change: 0,
      planId: plan.id,
      price: plan.price,
    });

    if (plan.id === 'month' || plan.id === 'season' || plan.id === 'year') {
      const bonusPoints = plan.id === 'year' ? 100 : (plan.id === 'season' ? 50 : 20);
      addPointsRecord({
        type: 'earn',
        title: '开通会员礼包',
        change: bonusPoints,
      });
    }

    console.log("✅ 会员开通成功，已标记同步:", updatedUser);
    return { success: true, message: `已开通${plan.name}` };
  } catch (e) {
    console.error("❌ 开通会员失败:", e);
    return { success: false, message: "开通会员失败" };
  }
}

function addPointsDirectly(packageItem) {
  const totalPoints = packageItem.points + (packageItem.bonusPoints || 0);
  
  try {
    const currentUser = getUserState();

    const updatedUser = updateUserState({
      points: (currentUser.points || 0) + totalPoints
    });

    addPointsRecord({
      type: "recharge",
      title: `充值${packageItem.points}积分`,
      change: totalPoints,
      packageId: packageItem.id,
      price: packageItem.price,
    });

    console.log("✅ 积分充值成功，已标记同步:", updatedUser);
    return { success: true, message: `已充值${totalPoints}积分` };
  } catch (e) {
    console.error("❌ 积分充值失败:", e);
    return { success: false, message: "积分充值失败" };
  }
}

function createLocalOrder(orderResult, payload) {
  return addOrder({
    id: orderResult.orderId,
    provider: "wechat",
    status: "pending",
    ...payload,
  });
}

async function purchaseMember(plan) {
  let localOrder = null;

  try {
    const orderResult = await createOrder("member", plan.id);
    if (!orderResult.orderId || !orderResult.payment) {
      throw new Error("订单创建失败");
    }

    localOrder = createLocalOrder(orderResult, {
      type: "member",
      itemId: plan.id,
      title: plan.name,
      amount: plan.price,
    });

    await requestPayment(orderResult.payment);

    const verifyResult = await verifyPayment(orderResult.orderId);
    if (verifyResult.success) {
      updateOrder(orderResult.orderId, { status: "paid", paidAt: Date.now() });
      return activateMemberDirectly(plan);
    }

    throw new Error("支付验证失败");
  } catch (error) {
    if (error.code === "CANCEL") {
      if (localOrder) {
        updateOrder(localOrder.id, { status: "cancelled", cancelledAt: Date.now() });
      }
      return { success: false, message: "已取消支付", cancelled: true };
    }

    if (error.code === "NO_PERMISSION") {
      if (localOrder) {
        updateOrder(localOrder.id, { status: "paid", paidAt: Date.now(), simulated: true });
      }
      return activateMemberDirectly(plan);
    }

    if (localOrder) {
      updateOrder(localOrder.id, {
        status: "failed",
        failedAt: Date.now(),
        errorMessage: error.message || "",
      });
    }
    return { success: false, message: error.message || "支付失败" };
  }
}

async function purchasePoints(packageItem) {
  let localOrder = null;

  try {
    const orderResult = await createOrder("points", packageItem.id);
    if (!orderResult.orderId || !orderResult.payment) {
      throw new Error("订单创建失败");
    }

    localOrder = createLocalOrder(orderResult, {
      type: "points",
      itemId: packageItem.id,
      title: `${packageItem.points}积分`,
      amount: packageItem.price,
    });

    await requestPayment(orderResult.payment);

    const verifyResult = await verifyPayment(orderResult.orderId);
    if (verifyResult.success) {
      updateOrder(orderResult.orderId, { status: "paid", paidAt: Date.now() });
      return addPointsDirectly(packageItem);
    }

    throw new Error("支付验证失败");
  } catch (error) {
    if (error.code === "CANCEL") {
      if (localOrder) {
        updateOrder(localOrder.id, { status: "cancelled", cancelledAt: Date.now() });
      }
      return { success: false, message: "已取消支付", cancelled: true };
    }

    if (error.code === "NO_PERMISSION") {
      if (localOrder) {
        updateOrder(localOrder.id, { status: "paid", paidAt: Date.now(), simulated: true });
      }
      return addPointsDirectly(packageItem);
    }

    if (localOrder) {
      updateOrder(localOrder.id, {
        status: "failed",
        failedAt: Date.now(),
        errorMessage: error.message || "",
      });
    }
    return { success: false, message: error.message || "支付失败" };
  }
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
  activateMemberFromPlan: activateMemberDirectly,
  addPointsFromPackage: addPointsDirectly,
};
