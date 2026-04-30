function isWechatIdentity(user) {
  return !!(
    user &&
    user.authMode === "wechat" &&
    typeof user.openid === "string" &&
    user.openid.trim()
  );
}

function shouldForceLogin(user) {
  return !isWechatIdentity(user);
}

function buildLoggedOutUserPatch() {
  return {
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
  };
}

module.exports = {
  isWechatIdentity,
  shouldForceLogin,
  buildLoggedOutUserPatch,
};
