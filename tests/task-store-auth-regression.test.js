const test = require("node:test");
const assert = require("node:assert/strict");

function createWxStub() {
  const storage = new Map();

  return {
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
  };
}

test("task-store no longer seeds guest credit into default users", () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../utils/task-store")];
  const store = require("../utils/task-store");

  const user = store.seedUserState();

  assert.equal(user.authMode, "guest");
  assert.equal(user.points, 0);
});

test("logoutCurrentUser clears local business state", () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../utils/task-store")];
  const store = require("../utils/task-store");

  store.updateUserState({
    authMode: "wechat",
    openid: "o-1",
    userId: "o-1",
    points: 80,
  });
  store.addPointsRecord({
    type: "earn",
    title: "bonus",
    change: 80,
  });

  const loggedOutUser = store.logoutCurrentUser();

  assert.equal(loggedOutUser.authMode, "guest");
  assert.equal(loggedOutUser.openid, "");
  assert.equal(store.getPointsRecords().length, 0);
});
