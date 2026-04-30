const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isWechatIdentity,
  shouldForceLogin,
  buildLoggedOutUserPatch,
} = require("../utils/auth-session");

test("isWechatIdentity only trusts openid plus authMode=wechat", () => {
  assert.equal(isWechatIdentity(null), false);
  assert.equal(isWechatIdentity({ authMode: "guest", openid: "o-1" }), false);
  assert.equal(isWechatIdentity({ authMode: "wechat", openid: "" }), false);
  assert.equal(isWechatIdentity({ authMode: "wechat", openid: "o-1" }), true);
});

test("shouldForceLogin is the inverse of a valid wechat identity", () => {
  assert.equal(shouldForceLogin({ authMode: "wechat", openid: "o-1" }), false);
  assert.equal(shouldForceLogin({ authMode: "guest", openid: "" }), true);
});

test("buildLoggedOutUserPatch clears identity and business fields", () => {
  assert.deepEqual(buildLoggedOutUserPatch(), {
    userId: "",
    openid: "",
    authMode: "guest",
    nickname: "",
    avatarUrl: "",
    avatar: "",
    phoneNumber: "",
    points: 0,
    lastSyncedAt: "",
    syncStatus: "local",
  });
});
