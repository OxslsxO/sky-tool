const test = require("node:test");
const assert = require("node:assert/strict");

function createWxStub() {
  const storage = new Map();

  return {
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
    requestPayment(options) {
      this.requestPaymentCalls.push(options);
      options.success({ errMsg: "requestPayment:ok" });
    },
  };
}

test("requestPayment rejects invalid payloads instead of simulating success", async () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../services/payment")];
  const { requestPayment } = require("../services/payment");

  await assert.rejects(
    requestPayment({
      signType: "MD5",
      package: "prepay_id=mock",
    }),
    (error) => error && error.code === "INVALID_PAYMENT_PARAMS"
  );

  assert.equal(global.wx.requestPaymentCalls.length, 0);
});

test("requestPayment forwards real payment params to wx.requestPayment", async () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../services/payment")];
  const { requestPayment } = require("../services/payment");

  const orderInfo = {
    timeStamp: "123",
    nonceStr: "nonce",
    package: "prepay_id=real",
    signType: "RSA",
    paySign: "signed",
  };

  await requestPayment(orderInfo);

  assert.equal(global.wx.requestPaymentCalls.length, 1);
  assert.equal(global.wx.requestPaymentCalls[0].timeStamp, orderInfo.timeStamp);
  assert.equal(global.wx.requestPaymentCalls[0].nonceStr, orderInfo.nonceStr);
  assert.equal(global.wx.requestPaymentCalls[0].package, orderInfo.package);
  assert.equal(global.wx.requestPaymentCalls[0].signType, orderInfo.signType);
  assert.equal(global.wx.requestPaymentCalls[0].paySign, orderInfo.paySign);
});

test("requestPayment supports lowercase sdk field names", async () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../services/payment")];
  const { requestPayment } = require("../services/payment");

  await requestPayment({
    appid: "wx123",
    timestamp: "456",
    noncestr: "lowercase",
    package: "prepay_id=lower",
    signType: "RSA",
    sign: "signed-lowercase",
  });

  assert.equal(global.wx.requestPaymentCalls.length, 1);
  assert.equal(global.wx.requestPaymentCalls[0].timeStamp, "456");
  assert.equal(global.wx.requestPaymentCalls[0].nonceStr, "lowercase");
  assert.equal(global.wx.requestPaymentCalls[0].paySign, "signed-lowercase");
});
