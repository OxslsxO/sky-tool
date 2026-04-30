# Wechat-Only Auth Hardcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the mini program from guest-friendly usage into a strict WeChat-login-only app where `openid` is the single user identity for membership, points, orders, favorites, recents, tasks, and sync state.

**Architecture:** Introduce a small auth-session helper and a reusable page guard first, then rewire app startup and login flow to depend only on WeChat identity, then harden local storage/sync/payment to reject guest state, and finally simplify backend user lookup to only trust the current `openid`. The implementation keeps local cache for the current signed-in user, but removes guest business state and removes phone-binding from the auth path.

**Tech Stack:** WeChat Mini Program (`wx.*` APIs), Node.js backend with Express, local storage helpers in `utils/task-store.js`, cloud sync in `utils/sync-manager.js`, Node test runner (`node --test`).

---

### Task 1: Add explicit auth-session helpers and prove the new login definition

**Files:**
- Create: `utils/auth-session.js`
- Create: `tests/auth-session.test.js`
- Modify: `app.js`
- Test: `tests/auth-session.test.js`

- [ ] **Step 1: Write the failing auth-session test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isWechatIdentity,
  shouldForceLogin,
  buildLoggedOutUserPatch,
} = require("../utils/auth-session");

test("isWechatIdentity only trusts openid + authMode=wechat", () => {
  assert.equal(isWechatIdentity(null), false);
  assert.equal(isWechatIdentity({ authMode: "guest", openid: "o-1" }), false);
  assert.equal(isWechatIdentity({ authMode: "wechat", openid: "" }), false);
  assert.equal(isWechatIdentity({ authMode: "wechat", openid: "o-1" }), true);
});

test("shouldForceLogin is the inverse of a valid wechat identity", () => {
  assert.equal(shouldForceLogin({ authMode: "wechat", openid: "o-1" }), false);
  assert.equal(shouldForceLogin({ authMode: "guest", openid: "" }), true);
});

test("buildLoggedOutUserPatch clears identity fields without reviving guest credit", () => {
  const patch = buildLoggedOutUserPatch();

  assert.deepEqual(patch, {
    userId: "",
    openid: "",
    authMode: "guest",
    nickname: "",
    avatarUrl: "",
    avatar: "",
    phoneNumber: "",
    memberPlan: "",
    memberActive: false,
    memberExpire: "",
    points: 0,
    lastSyncedAt: "",
    syncStatus: "local",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .\tests\auth-session.test.js`

Expected: FAIL with `Cannot find module '../utils/auth-session'`.

- [ ] **Step 3: Write the minimal auth-session helper**

```js
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
    memberPlan: "",
    memberActive: false,
    memberExpire: "",
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
```

- [ ] **Step 4: Update `app.js` to use the helper instead of `phoneNumber`**

```js
const { seedUserState, getUserState } = require("./utils/task-store");
const { syncCloudState, pullCloudState } = require("./utils/sync-manager");
const { shouldForceLogin } = require("./utils/auth-session");

App({
  globalData: {
    brandName: "晴空工具箱",
  },

  async onLaunch() {
    const user = getUserState();

    if (shouldForceLogin(user)) {
      return;
    }

    await pullCloudState().catch(() => {});
    seedUserState();
    syncCloudState().catch(() => {});

    setTimeout(() => {
      wx.switchTab({
        url: "/pages/home/index",
      });
    }, 100);
  },
});
```

- [ ] **Step 5: Run the auth-session test again**

Run: `node --test .\tests\auth-session.test.js`

Expected: PASS with `3` tests passing.

- [ ] **Step 6: Commit**

```bash
git add utils/auth-session.js tests/auth-session.test.js app.js
git commit -m "refactor: define wechat-only auth session helpers"
```

### Task 2: Collapse login flow to pure WeChat login and remove phone-binding from the UI path

**Files:**
- Modify: `pages/login/index.js`
- Modify: `pages/login/index.wxml`
- Modify: `pages/login/index.wxss`
- Test: `tests/login-flow-regression.test.js`

- [ ] **Step 1: Write the failing regression test for the login page**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("login page no longer requires bind-phone flow", () => {
  const js = read("pages/login/index.js");
  const wxml = read("pages/login/index.wxml");

  assert.doesNotMatch(js, /bind-phone|onGetPhoneNumber|\/api\/auth\/bind-phone/);
  assert.doesNotMatch(wxml, /手机号|bind-phone|getPhoneNumber/);
  assert.match(js, /wx\.login/);
  assert.match(js, /goHome\(\)/);
});
```

- [ ] **Step 2: Run the regression test to verify it fails**

Run: `node --test .\tests\login-flow-regression.test.js`

Expected: FAIL because `pages/login/index.js` still contains `bind-phone` flow and `/api/auth/bind-phone`.

- [ ] **Step 3: Simplify the login page controller**

```js
const { getUserState, updateUserState } = require("../../utils/task-store");
const { isWechatIdentity } = require("../../utils/auth-session");
const { buildServiceUrl, getServiceHeaders } = require("../../services/backend-tools");

Page({
  data: {
    loading: false,
    step: "login",
    userInfo: null,
  },

  onLoad() {
    const user = getUserState();
    if (isWechatIdentity(user)) {
      this.goHome();
    }
  },

  async onGetUserInfo(e) {
    if (!e.detail.userInfo) {
      wx.showToast({ title: "需要微信授权后才能使用", icon: "none" });
      return;
    }

    this.setData({
      userInfo: e.detail.userInfo,
      loading: true,
    });

    try {
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({ success: resolve, fail: reject });
      });

      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: buildServiceUrl("/api/auth/login"),
          method: "POST",
          header: {
            "content-type": "application/json",
            ...getServiceHeaders(),
          },
          data: {
            code: loginRes.code,
            userInfo: e.detail.userInfo,
          },
          success: resolve,
          fail: reject,
        });
      });

      if (!(result.statusCode === 200 && result.data.ok && result.data.user)) {
        throw new Error("LOGIN_FAILED");
      }

      updateUserState({
        ...result.data.user,
        authMode: "wechat",
        lastLoginAt: new Date().toISOString(),
      });

      this.setData({ step: "success" });
      setTimeout(() => this.goHome(), 300);
    } catch (error) {
      wx.showToast({ title: "微信登录失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  goHome() {
    wx.switchTab({
      url: "/pages/home/index",
    });
  },
});
```

- [ ] **Step 4: Remove the bind-phone block from the page template**

```xml
<view class="login-page">
  <view class="login-card" wx:if="{{step === 'login'}}">
    <text class="login-title">微信登录后即可使用全部功能</text>
    <button
      class="wechat-login-btn"
      open-type="getUserInfo"
      bindgetuserinfo="onGetUserInfo"
      loading="{{loading}}"
    >
      微信一键登录
    </button>
  </view>

  <view class="login-card" wx:elif="{{step === 'success'}}">
    <text class="login-title">登录成功</text>
    <text class="login-desc">正在进入首页...</text>
  </view>
</view>
```

- [ ] **Step 5: Trim styles that only served the phone-binding state**

```css
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-card {
  width: 100%;
  max-width: 620rpx;
  padding: 48rpx;
  border-radius: 32rpx;
}

.wechat-login-btn {
  margin-top: 32rpx;
}
```

- [ ] **Step 6: Re-run the login flow regression test**

Run: `node --test .\tests\login-flow-regression.test.js`

Expected: PASS with `1` test passing.

- [ ] **Step 7: Commit**

```bash
git add pages/login/index.js pages/login/index.wxml pages/login/index.wxss tests/login-flow-regression.test.js
git commit -m "refactor: remove phone binding from login flow"
```

### Task 3: Add a reusable login guard for pages and tab switching

**Files:**
- Create: `utils/page-auth.js`
- Create: `tests/page-auth.test.js`
- Modify: `custom-tab-bar/index.js`
- Modify: `pages/home/index.js`
- Modify: `pages/category/index.js`
- Modify: `pages/tasks/index.js`
- Modify: `pages/vip/index.js`
- Modify: `pages/mine/index.js`
- Modify: `pages/profile-edit/index.js`
- Modify: `pages/tool-detail/index.js`
- Modify: `pages/task-detail/index.js`
- Test: `tests/page-auth.test.js`

- [ ] **Step 1: Write the failing test for the page guard helper**

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureWechatLogin, buildLoginRedirectUrl } = require("../utils/page-auth");

test("buildLoginRedirectUrl always points to the login page", () => {
  assert.equal(buildLoginRedirectUrl(), "/pages/login/index");
});

test("ensureWechatLogin returns false and redirects when user is missing", () => {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .\tests\page-auth.test.js`

Expected: FAIL with `Cannot find module '../utils/page-auth'`.

- [ ] **Step 3: Implement the reusable guard helper**

```js
const { getUserState } = require("./task-store");
const { shouldForceLogin } = require("./auth-session");

function buildLoginRedirectUrl() {
  return "/pages/login/index";
}

function ensureWechatLogin(options = {}) {
  const getUser = options.getUser || getUserState;
  const redirect = options.redirect || ((url) => wx.reLaunch({ url }));
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
```

- [ ] **Step 4: Guard tab switching in the custom tab bar**

```js
const { ensureWechatLogin } = require("../utils/page-auth");

Component({
  methods: {
    switchTab(e) {
      if (!ensureWechatLogin()) {
        return;
      }

      const data = e.currentTarget.dataset;
      wx.switchTab({ url: data.path });
      this.setData({ selected: data.index });
    },
  },
});
```

- [ ] **Step 5: Add a one-line guard at the top of each business page `onShow`**

```js
const { ensureWechatLogin } = require("../../utils/page-auth");

onShow() {
  if (!ensureWechatLogin()) {
    return;
  }

  this.refreshPage();
}
```

Apply the same pattern to:

- `pages/home/index.js`
- `pages/category/index.js`
- `pages/tasks/index.js`
- `pages/vip/index.js`
- `pages/mine/index.js`
- `pages/profile-edit/index.js`
- `pages/tool-detail/index.js`
- `pages/task-detail/index.js`

- [ ] **Step 6: Run the page guard test**

Run: `node --test .\tests\page-auth.test.js`

Expected: PASS with `3` tests passing.

- [ ] **Step 7: Commit**

```bash
git add utils/page-auth.js tests/page-auth.test.js custom-tab-bar/index.js pages/home/index.js pages/category/index.js pages/tasks/index.js pages/vip/index.js pages/mine/index.js pages/profile-edit/index.js pages/tool-detail/index.js pages/task-detail/index.js
git commit -m "feat: guard business pages behind wechat login"
```

### Task 4: Remove guest business state and add explicit logout/cache clearing

**Files:**
- Modify: `utils/task-store.js`
- Modify: `utils/sync-manager.js`
- Modify: `services/membership.js`
- Modify: `pages/mine/index.js`
- Create: `tests/task-store-auth-regression.test.js`
- Test: `tests/task-store-auth-regression.test.js`

- [ ] **Step 1: Write the failing storage regression test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");

test("task-store no longer seeds guest credit into DEFAULT_USER", async () => {
  const store = await import("../utils/task-store.js");
  const user = store.seedUserState();

  assert.equal(user.authMode, "guest");
  assert.equal(user.points, 0);
  assert.equal(user.memberActive, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .\tests\task-store-auth-regression.test.js`

Expected: FAIL because `DEFAULT_USER.points` still seeds `100`.

- [ ] **Step 3: Remove guest credit and add cache clearing helpers in `utils/task-store.js`**

```js
const DEFAULT_USER = {
  nickname: "",
  points: 0,
  memberPlan: "",
  memberExpire: "",
  memberActive: false,
  userId: "",
  openid: "",
  deviceId: "",
  authMode: "guest",
  avatarUrl: "",
  avatar: "",
  phoneNumber: "",
  lastSyncedAt: "",
  syncStatus: "local",
  createdAt: "",
  updatedAt: "",
};

function clearUserBusinessStorage() {
  [
    STORAGE_KEYS.tasks,
    STORAGE_KEYS.favorites,
    STORAGE_KEYS.recent,
    STORAGE_KEYS.photoIdStats,
    STORAGE_KEYS.pointsRecords,
    STORAGE_KEYS.orders,
    STORAGE_KEYS.syncDirty,
  ].forEach((key) => {
    wx.removeStorageSync(key);
  });
}

function logoutCurrentUser() {
  clearUserBusinessStorage();
  writeStorage(STORAGE_KEYS.user, normalizeUserState(DEFAULT_USER));
  return getUserState();
}
```

- [ ] **Step 4: Stop cloud sync from running without a valid WeChat identity**

```js
const { shouldForceLogin } = require("./auth-session");

function shouldSync(options) {
  if (options.force) {
    return !shouldForceLogin(getUserState());
  }

  const user = getUserState();
  if (shouldForceLogin(user)) {
    return false;
  }

  return !user.lastSyncedAt || hasDirtySyncState();
}

async function pullCloudState() {
  const user = getUserState();
  if (shouldForceLogin(user)) {
    return {
      ok: false,
      skipped: true,
      reason: "LOGIN_REQUIRED",
    };
  }

  // existing fetchClientState logic continues here
}
```

- [ ] **Step 5: Wire a real logout action from the Mine page**

```js
const { logoutCurrentUser } = require("../../utils/task-store");

handleLogout() {
  logoutCurrentUser();
  wx.reLaunch({
    url: "/pages/login/index",
  });
}
```

- [ ] **Step 6: Make membership helpers depend on a real logged-in user**

```js
const { shouldForceLogin } = require("../utils/auth-session");

function getUsagePriority(tool) {
  const user = getUserState();
  if (shouldForceLogin(user)) {
    return { priority: "none", text: "请先登录微信账号", usable: false };
  }

  // existing free/member/points logic continues here
}
```

- [ ] **Step 7: Re-run the storage regression test**

Run: `node --test .\tests\task-store-auth-regression.test.js`

Expected: PASS with `1` test passing.

- [ ] **Step 8: Commit**

```bash
git add utils/task-store.js utils/sync-manager.js services/membership.js pages/mine/index.js tests/task-store-auth-regression.test.js
git commit -m "refactor: remove guest business state"
```

### Task 5: Simplify backend auth and lock server-side identity to `openid`

**Files:**
- Modify: `backend/server.js`
- Modify: `backend/lib/client-state-repository.js`
- Create: `tests/backend-auth-regression.test.js`
- Modify: `services/payment.js`
- Test: `tests/backend-auth-regression.test.js`

- [ ] **Step 1: Write the failing backend regression test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("auth login no longer resurrects recent users or bind-phone flow", () => {
  const server = read("backend/server.js");

  assert.doesNotMatch(server, /recentActiveUser|auth\/bind-phone|phoneNumber = `138/);
  assert.match(server, /findOne\(\{ openid \}\)/);
});

test("client state repository no longer falls back to recent active users", () => {
  const repository = read("backend/lib/client-state-repository.js");

  assert.doesNotMatch(repository, /limit\(3\)|最近活跃用户|recentUsers/);
  assert.match(repository, /findOne\(\{ userId: identity\.userId \}\)/);
});
```

- [ ] **Step 2: Run the regression test to verify it fails**

Run: `node --test .\tests\backend-auth-regression.test.js`

Expected: FAIL because both files still contain recent-user fallback logic and bind-phone remnants.

- [ ] **Step 3: Reduce `/api/auth/login` to direct `openid` lookup/create**

```js
app.post("/api/auth/login", async (req, res) => {
  const { code, userInfo } = req.body;
  if (!code) {
    sendError(res, 400, "MISSING_CODE", "Missing login code");
    return;
  }

  const wxResult = await wechatCode2Session(code);
  const openid = wxResult.openid;
  const collections = await clientStateRepository.getCollections();

  let user = collections ? await collections.users.findOne({ openid }) : null;
  let isNewUser = false;

  if (!user && collections) {
    isNewUser = true;
    const now = new Date().toISOString();
    user = {
      userId: openid,
      openid,
      nickname: userInfo?.nickName || "微信用户",
      avatarUrl: userInfo?.avatarUrl || "",
      avatar: userInfo?.avatarUrl || "",
      authMode: "wechat",
      points: 0,
      memberPlan: "",
      memberActive: false,
      memberExpire: "",
      createdAt: now,
      updatedAt: now,
    };
    await collections.users.insertOne(user);
  }

  if (collections && user) {
    await collections.users.updateOne(
      { openid },
      {
        $set: {
          updatedAt: new Date().toISOString(),
          nickname: userInfo?.nickName || user.nickname || "微信用户",
          avatarUrl: userInfo?.avatarUrl || user.avatarUrl || "",
          avatar: userInfo?.avatarUrl || user.avatar || "",
          authMode: "wechat",
        },
      }
    );
    user = await collections.users.findOne({ openid });
  }

  res.json({
    ok: true,
    isNewUser,
    user: {
      userId: user.userId,
      openid: user.openid,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl || "",
      avatar: user.avatar || user.avatarUrl || "",
      points: user.points || 0,
      memberPlan: user.memberPlan || "",
      memberActive: !!user.memberActive,
      memberExpire: user.memberExpire || "",
    },
  });
});
```

- [ ] **Step 4: Remove recent-user fallback from the repository lookup**

```js
async function findMongoRecord(collections, identity) {
  let user = null;
  let device = null;

  if (identity.userId) {
    user = await collections.users.findOne({ userId: identity.userId });
  }

  if (!user && identity.deviceId) {
    device = await collections.clientDevices.findOne({ deviceId: identity.deviceId });
    if (device && device.userId) {
      user = await collections.users.findOne({ userId: device.userId });
    }
  }

  if (!user) {
    return null;
  }

  return {
    user,
    device,
    snapshot: await findSnapshot(collections, {
      userId: user.userId,
      deviceId: identity.deviceId,
    }),
  };
}
```

- [ ] **Step 5: Require `openid` when creating WeChat payment orders**

```js
async function createOrder(type, itemId, retryCount = 0) {
  const user = getUserState();

  if (!user || !user.openid || user.authMode !== "wechat") {
    throw new Error("LOGIN_REQUIRED");
  }

  // existing request code continues here
}
```

Also keep `backend/server.js` using:

```js
payer: {
  openid: userId,
},
```

instead of `userId || "test openid"` fallback.

- [ ] **Step 6: Re-run the backend regression test**

Run: `node --test .\tests\backend-auth-regression.test.js`

Expected: PASS with `2` tests passing.

- [ ] **Step 7: Commit**

```bash
git add backend/server.js backend/lib/client-state-repository.js services/payment.js tests/backend-auth-regression.test.js
git commit -m "refactor: trust only wechat openid for user identity"
```

### Task 6: Run the full auth hardcut regression suite and document any manual checks

**Files:**
- Modify: `tests/payment.requestPayment.test.js`
- Modify: `tests/login-flow-regression.test.js`
- Modify: `tests/page-auth.test.js`
- Modify: `tests/task-store-auth-regression.test.js`
- Modify: `tests/backend-auth-regression.test.js`
- Test: `tests/*.test.js`

- [ ] **Step 1: Add one final regression for login-only payment usage**

```js
test("createOrder rejects payment when the current user is not a wechat identity", async () => {
  global.wx = createWxStub();
  delete require.cache[require.resolve("../services/payment")];
  const payment = require("../services/payment");

  const originalGetUserState = require("../utils/task-store").getUserState;
  require("../utils/task-store").getUserState = () => ({
    authMode: "guest",
    openid: "",
    userId: "",
  });

  await assert.rejects(
    () => payment.createOrder("member", "month"),
    /LOGIN_REQUIRED/
  );

  require("../utils/task-store").getUserState = originalGetUserState;
});
```

- [ ] **Step 2: Run the full targeted suite**

Run:

```bash
node --test .\tests\auth-session.test.js .\tests\login-flow-regression.test.js .\tests\page-auth.test.js .\tests\task-store-auth-regression.test.js .\tests\backend-auth-regression.test.js .\tests\payment.requestPayment.test.js .\pages\tool-entry-regression.test.js .\pages\photo-id-regression.test.js
```

Expected: PASS with all tests green and no new failures.

- [ ] **Step 3: Perform manual mini program smoke checks**

Manual checklist:

```text
1. Launch app without prior login -> only login page appears.
2. Complete WeChat login -> app lands on home tab.
3. Open VIP page -> member/points render for current account.
4. Log out from Mine page -> app returns to login page.
5. Re-login with same account -> previous member/points/records reappear.
6. Attempt payment while logged in -> backend request includes current openid.
```

- [ ] **Step 4: Commit**

```bash
git add tests/payment.requestPayment.test.js tests/auth-session.test.js tests/login-flow-regression.test.js tests/page-auth.test.js tests/task-store-auth-regression.test.js tests/backend-auth-regression.test.js pages/tool-entry-regression.test.js pages/photo-id-regression.test.js
git commit -m "test: cover wechat-only auth hardcut regressions"
```

## Self-Review

### Spec coverage

- Login-only startup and no guest access: covered by Tasks 1, 2, and 3.
- Remove phone binding: covered by Task 2 and Task 5.
- Membership, points, orders, tasks, favorites, recents tied to WeChat identity: covered by Task 4 and Task 5.
- Payment must use current `openid`: covered by Task 5 and Task 6.
- Logout clears local state and prevents cross-user leakage: covered by Task 4.
- Same-account re-login restores cloud-backed state: enabled by Tasks 1, 4, and 5, then checked manually in Task 6.

### Placeholder scan

- No `TODO`/`TBD` placeholders remain.
- Every task includes concrete file paths, concrete test commands, and concrete code snippets.

### Type consistency

- `authMode` is consistently `wechat` or `guest`.
- `openid` remains the authoritative identity key.
- Shared helper names are consistent across tasks: `isWechatIdentity`, `shouldForceLogin`, `ensureWechatLogin`, `logoutCurrentUser`.
