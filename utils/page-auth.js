const { getUserState } = require("./task-store");
const { shouldForceLogin } = require("./auth-session");

function buildLoginRedirectUrl() {
  return "/pages/login/index";
}

function ensureWechatLogin(options = {}) {
  const getUser = options.getUser || getUserState;
  const redirect =
    options.redirect ||
    ((url) => {
      wx.reLaunch({ url });
    });
  const user = getUser();

  if (!shouldForceLogin(user)) {
    return true;
  }

  redirect(buildLoginRedirectUrl());
  return false;
}

module.exports = {
  buildLoginRedirectUrl,
  ensureWechatLogin,
};
