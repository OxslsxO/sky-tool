const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureWechatLogin, buildLoginRedirectUrl } = require("../utils/page-auth");

test("buildLoginRedirectUrl always points to the login page", () => {
  assert.equal(buildLoginRedirectUrl(), "/pages/login/index");
});

test("ensureWechatLogin redirects when user is missing", () => {
  const redirects = [];
  const ok = ensureWechatLogin({
    getUser: () => ({ authMode: "guest", openid: "" }),
    redirect: (url) => redirects.push(url),
  });

  assert.equal(ok, false);
  assert.deepEqual(redirects, ["/pages/login/index"]);
});

test("ensureWechatLogin returns true for a valid wechat identity", () => {
  const ok = ensureWechatLogin({
    getUser: () => ({ authMode: "wechat", openid: "o-1" }),
    redirect: () => {
      throw new Error("should not redirect");
    },
  });

  assert.equal(ok, true);
});
