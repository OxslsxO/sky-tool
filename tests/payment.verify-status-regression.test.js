const test = require("node:test");
const assert = require("node:assert/strict");

function createWxStub() {
  const storage = new Map();
  const requests = [];

  const wx = {
    requests,
    requestPaymentCalls: [],
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
    request(options) {
      requests.push(options);

      if (options.url.endsWith("/api/pay/create")) {
        options.success({
          statusCode: 200,
          data: {
            orderId: "ord-1",
            payment: {
              timeStamp: "123",
              nonceStr: "nonce",
              package: "prepay_id=real",
              signType: "RSA",
              paySign: "signed",
            },
          },
        });
        return;
      }

      if (options.url.endsWith("/api/pay/verify")) {
        options.success({
          statusCode: 200,
          data: {
            success: true,
            status: "pending",
            orderId: "ord-1",
          },
        });
        return;
      }

      throw new Error(`unexpected request: ${options.url}`);
    },
    requestPayment(options) {
      this.requestPaymentCalls.push(options);
      options.success({ errMsg: "requestPayment:ok" });
    },
    getAccountInfoSync() {
      return {
        miniProgram: {
          envVersion: "develop",
        },
      };
    },
  };

  storage.set("sky_tools_backend_service", {
    baseUrl: "http://127.0.0.1:3100",
    token: "",
  });
  storage.set("sky_tools_user", {
    authMode: "wechat",
    openid: "o-1",
    userId: "o-1",
    deviceId: "d-1",
    points: 0,
    nickname: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return wx;
}

test("purchasePoints does not grant credits when verify status is not paid", async () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../services/backend-tools")];
  delete require.cache[require.resolve("../utils/task-store")];
  delete require.cache[require.resolve("../services/payment")];

  const store = require("../utils/task-store");
  const payment = require("../services/payment");

  await assert.rejects(
    payment.purchasePoints({
      id: "p-50",
      points: 50,
      bonusPoints: 5,
      price: "8",
    }),
    /支付验证失败|PAYMENT_NOT_CONFIRMED|pending/i
  );

  assert.equal(store.getUserState().points, 0);
  assert.equal(store.getPointsRecords().length, 0);
});
