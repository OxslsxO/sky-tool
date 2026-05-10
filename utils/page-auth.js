const { getUserState } = require("./task-store");
const { isWechatIdentity } = require("./auth-session");

function buildLoginRedirectUrl() {
  return "/pages/login/index";
}

function ensureWechatLogin(options = {}) {
  const getUser = options.getUser || getUserState;
  const user = getUser();
  return isWechatIdentity(user);
}

function isLoggedIn() {
  const user = getUserState();
  return isWechatIdentity(user);
}

module.exports = {
  buildLoginRedirectUrl,
  ensureWechatLogin,
  isLoggedIn,
};
