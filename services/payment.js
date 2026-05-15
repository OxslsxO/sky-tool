const { buildServiceUrl, getServiceHeaders } = require("./backend-tools");
const {
  getUserState,
  updateUserState,
  addPointsRecord,
  addOrder,
  updateOrder,
} = require("../utils/task-store");
const { isWechatIdentity } = require("../utils/auth-session");

function normalizePaymentPayload(orderInfo) {
  const payload = orderInfo || {};
  const signType = String(payload.signType || payload.signtype || "").toUpperCase();

  return {
    appId: payload.appId || payload.appid || "",
    timeStamp: String(payload.timeStamp || payload.timestamp || ""),
    nonceStr: payload.nonceStr || payload.noncestr || "",
    package: payload.package || (payload.prepayid ? `prepay_id=${payload.prepayid}` : ""),
    signType,
    paySign: payload.paySign || payload.sign || "",
  };
}

function requestPayment(orderInfo) {
  const payment = normalizePaymentPayload(orderInfo);

  if (!payment.timeStamp || !payment.nonceStr || !payment.package || !payment.paySign) {
    return Promise.reject({
      code: "INVALID_PAYMENT_PARAMS",
      message: "支付参数不完整，请检查后端返回的 payment 字段",
    });
  }

  return new Promise((resolve, reject) => {
    wx.requestPayment({
      timeStamp: payment.timeStamp,
      nonceStr: payment.nonceStr,
      package: payment.package,
      signType: payment.signType || "RSA",
      paySign: payment.paySign,
      success: (res) => resolve(res),
      fail: (err) => {
        const errMsg = err.errMsg || "";

        if (errMsg.indexOf("cancel") > -1) {
          reject({ code: "CANCEL", message: "用户取消支付", error: err });
          return;
        }

        if (errMsg.indexOf("no permission") > -1) {
          reject({ code: "NO_PERMISSION", message: "微信支付权限未开通", error: err });
          return;
        }

        reject({ code: "PAY_ERROR", message: errMsg || "支付失败", error: err });
      },
    });
  });
}

async function createOrder(type, itemId) {
  const user = getUserState();

  if (!isWechatIdentity(user)) {
    throw { code: "NOT_LOGGED_IN", message: "请先登录后再进行支付" };
  }

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
          openid: user.openid,
          deviceId: user.deviceId,
        },
        success: (res) => resolve(res),
        fail: (err) => reject(err),
      });
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.data;
    }

    throw response.data || new Error(`CREATE_ORDER_FAILED_${response.statusCode}`);
  } catch (error) {
    console.error("[payment] createOrder failed:", error);
    throw error;
  }
}

async function verifyPayment(orderId) {
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
        success: (res) => resolve(res),
        fail: (err) => reject(err),
      });
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response.data;
    }

    throw response.data || new Error(`VERIFY_FAILED_${response.statusCode}`);
  } catch (error) {
    console.error("[payment] verifyPayment failed:", error);
    throw error;
  }
}

function addPointsDirectly(packageItem) {
  console.log("[payment] addPointsDirectly called with package:", packageItem);
  const totalPoints = packageItem.points + (packageItem.bonusPoints || 0);

  try {
    addOrder({
      type: "points",
      itemId: packageItem.id,
      provider: "wechat",
      status: "paid",
      title: `${packageItem.points}积分`,
      amount: packageItem.price,
      paidAt: Date.now(),
    });

    const currentUser = getUserState();
    const updatedUser = updateUserState({
      points: (currentUser.points || 0) + totalPoints,
    });

    addPointsRecord({
      type: "recharge",
      title: `充值${packageItem.points}积分`,
      change: totalPoints,
      packageId: packageItem.id,
      price: packageItem.price,
    });

    console.log("[payment] points added successfully:", updatedUser);
    return { success: true, message: `已充值${totalPoints}积分` };
  } catch (error) {
    console.error("[payment] addPointsDirectly failed:", error);
    throw error;
  }
}

function isVerifiedPaidOrder(result) {
  const normalizedStatus = String(result && result.status ? result.status : "").toLowerCase();
  return !!(
    result &&
    (
      result.paid === true ||
      normalizedStatus === "paid" ||
      normalizedStatus === "success" ||
      normalizedStatus === "trade_success"
    )
  );
}

function createLocalOrder(orderResult, payload) {
  console.log("[payment] createLocalOrder:", { orderResult, payload });
  return addOrder({
    id: orderResult.orderId,
    provider: "wechat",
    status: "pending",
    ...payload,
  });
}

async function purchasePoints(packageItem) {
  let localOrderId = null;

  try {
    const orderResult = await createOrder("points", packageItem.id);
    
    if (!orderResult.orderId || !orderResult.payment) {
      throw new Error("订单创建失败：缺少订单ID或支付参数");
    }

    localOrderId = orderResult.orderId;

    createLocalOrder(orderResult, {
      type: "points",
      itemId: packageItem.id,
      title: `${packageItem.points}积分`,
      amount: packageItem.price,
    });

    await requestPayment(orderResult.payment);

    const verifyResult = await verifyPayment(orderResult.orderId);
    if (verifyResult.success && isVerifiedPaidOrder(verifyResult)) {
      updateOrder(orderResult.orderId, { status: "paid", paidAt: Date.now() });
      
      const totalPoints = packageItem.points + (packageItem.bonusPoints || 0);
      addOrder({
        type: "points",
        itemId: packageItem.id,
        provider: "wechat",
        status: "paid",
        title: `${packageItem.points}积分`,
        amount: packageItem.price,
        paidAt: Date.now(),
      });
      
      if (verifyResult.user) {
        const { getUserState, updateUserState, addPointsRecord } = require("../utils/task-store");
        updateUserState({
          ...verifyResult.user,
          updatedAt: new Date().toISOString()
        });
        
        addPointsRecord({
          type: "recharge",
          title: `充值${packageItem.points}积分`,
          change: totalPoints,
          packageId: packageItem.id,
          price: packageItem.price,
        });
      }
      
      return { success: true, message: `已充值${totalPoints}积分` };
    }

    throw new Error(`PAYMENT_NOT_CONFIRMED:${JSON.stringify(verifyResult)}`);
  } catch (error) {
    if (error.code === "CANCEL") {
      if (localOrderId) {
        updateOrder(localOrderId, { status: "cancelled", cancelledAt: Date.now() });
      }
      return { success: false, message: "已取消支付", cancelled: true, error };
    }

    if (localOrderId) {
      updateOrder(localOrderId, {
        status: "failed",
        failedAt: Date.now(),
        errorMessage: error.message || "",
      });
    }

    throw error;
  }
}

async function purchaseTool(tool) {
  let localOrderId = null;

  try {
    const orderResult = await createOrder("tool", tool.id);
    
    if (!orderResult.orderId || !orderResult.payment) {
      throw new Error("订单创建失败：缺少订单ID或支付参数");
    }

    localOrderId = orderResult.orderId;

    createLocalOrder(orderResult, {
      type: "tool",
      itemId: tool.id,
      title: tool.name,
      amount: (tool.points || 0) * 10,
    });

    await requestPayment(orderResult.payment);

    const verifyResult = await verifyPayment(orderResult.orderId);
    if (verifyResult.success && isVerifiedPaidOrder(verifyResult)) {
      updateOrder(orderResult.orderId, { status: "paid", paidAt: Date.now() });
      return { success: true, message: "已完成支付，可以使用工具了" };
    }

    throw new Error(`PAYMENT_NOT_CONFIRMED:${JSON.stringify(verifyResult)}`);
  } catch (error) {
    if (error.code === "CANCEL") {
      if (localOrderId) {
        updateOrder(localOrderId, { status: "cancelled", cancelledAt: Date.now() });
      }
      return { success: false, message: "已取消支付", cancelled: true, error };
    }

    if (localOrderId) {
      updateOrder(localOrderId, {
        status: "failed",
        failedAt: Date.now(),
        errorMessage: error.message || "",
      });
    }

    throw error;
  }
}

module.exports = {
  createOrder,
  requestPayment,
  verifyPayment,
  purchasePoints,
  purchaseTool,
  addPointsFromPackage: addPointsDirectly,
};
