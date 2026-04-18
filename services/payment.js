const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");
const {
  getUserState,
  updateUserState,
  addPointsRecord,
  addOrder,
  updateOrder,
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

function createOrder(type, itemId) {
  const user = getUserState();

  return new Promise((resolve, reject) => {
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
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }

        reject(response.data || new Error("CREATE_ORDER_FAILED"));
      },
      fail: reject,
    });
  });
}

function verifyPayment(orderId) {
  const user = getUserState();

  return new Promise((resolve, reject) => {
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
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }

        reject(response.data || new Error("VERIFY_FAILED"));
      },
      fail: reject,
    });
  });
}

function parsePeriodDays(period) {
  const match = String(period || "").match(/(\d+)/);
  if (!match) {
    return 30;
  }

  return parseInt(match[1], 10);
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
  const bonusMatch = String(packageItem.bonus || "").match(/(\d+)/);
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
      return simulateMemberPurchase(plan);
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
      return simulateMemberPurchase(plan);
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
      return simulatePointsPurchase(packageItem);
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
      return simulatePointsPurchase(packageItem);
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
  simulateMemberPurchase,
  simulatePointsPurchase,
};
