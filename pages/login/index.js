const {
  getUserState,
  updateUserState,
  seedUserState,
  seedMockTasks,
  saveTasks,
  setFavorites,
  setRecentToolIds,
  getSyncSnapshot,
  applyRemoteState,
  getRawTasks,
} = require("../../utils/task-store");
const {
  buildServiceUrl,
  getServiceHeaders,
  hasBackendService,
} = require("../../services/backend-tools");
const {
  fetchClientState,
  syncClientState,
} = require("../../services/state-sync");

const STORAGE_KEYS = {
  user: "sky_tools_user",
};

Page({
  data: {
    loading: false,
    showUserInfoStep: false,
    avatarUrl: '',
    nickname: '',
  },

  onLoad() {
    const user = getUserState();
    if (user && user.openid && user.authMode === 'wechat') {
      this.goHome();
    }
  },

  onChooseAvatar(e) {
    console.log('🎯 获取到微信头像:', e.detail);
    const { avatarUrl } = e.detail;
    this.setData({
      avatarUrl,
      showUserInfoStep: true,
      nickname: '微信用户',
    });
  },

  onNicknameInput(e) {
    this.setData({
      nickname: e.detail.value,
    });
  },

  async onConfirmLogin() {
    const { avatarUrl, nickname } = this.data;

    if (!nickname || !nickname.trim()) {
      wx.showToast({
        title: '请输入昵称',
        icon: 'none',
      });
      return;
    }

    this.setData({ loading: true });
    try {
      await this.loginWechat(avatarUrl, nickname.trim());
    } catch (err) {
      console.error('❌ 登录失败:', err);
      wx.showModal({
        title: '登录失败',
        content: err.message || '请重试',
        showCancel: false
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loginWechat(avatarUrl, nickname) {
    console.log('🔄 开始微信登录...');

    try {
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({
          success: resolve,
          fail: reject,
        });
      });

      console.log('✅ 获取到登录 code:', loginRes.code);

      if (!hasBackendService()) {
        console.log('⚠️ 后端服务不可用，使用本地登录模式');
        this.localLogin(avatarUrl, nickname);
        return;
      }

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
            userInfo: {
              avatarUrl: avatarUrl,
              nickName: nickname,
            },
          },
          success: resolve,
          fail: reject,
        });
      });

      console.log('📥 后端登录响应:', result);

      if (result.statusCode === 200 && result.data.ok) {
        const { user } = result.data;
        const userId = user.userId || user.openid;

        console.log('✅ 登录成功！用户信息:', user);
        console.log('🔑 真实 openid:', user.openid);

        const hasLocalData = this._hasLocalUserData();

        if (hasLocalData) {
          await this._loginWithLocalData(userId, user, avatarUrl, nickname);
        } else {
          await this._loginWithCloudData(userId, user, avatarUrl, nickname);
        }

        const currentTasks = getRawTasks();
        if (currentTasks.length === 0) {
          console.log('📝 本地没有任务数据，初始化演示数据...');
          seedMockTasks();
        }

        wx.showToast({
          title: '登录成功',
          icon: 'success'
        });

        setTimeout(() => {
          this.goHome();
        }, 1000);
      } else {
        throw new Error(result.data?.message || '登录失败');
      }
    } catch (err) {
      console.warn('⚠️ 登录过程出错，降级到本地模式:', err);
      this.localLogin(avatarUrl, nickname);
    }
  },

  _hasLocalUserData() {
    try {
      const user = wx.getStorageSync(STORAGE_KEYS.user);
      const hasPoints = user && user.points > 0;
      const hasTasks = (wx.getStorageSync("sky_tools_tasks") || []).length > 0;
      const hasPointsRecords = (wx.getStorageSync("sky_tools_points_records") || []).length > 0;
      const hasOrders = (wx.getStorageSync("sky_tools_orders") || []).length > 0;
      return hasPoints || hasTasks || hasPointsRecords || hasOrders;
    } catch {
      return false;
    }
  },

  async _loginWithCloudData(userId, backendUser, avatarUrl, nickname) {
    console.log('☁️ 本地无数据，从云端恢复...');

    updateUserState({
      userId: userId,
      openid: backendUser.openid,
      nickname: backendUser.nickname || nickname || '微信用户',
      avatarUrl: backendUser.avatarUrl || backendUser.avatar || avatarUrl,
      avatar: backendUser.avatar || backendUser.avatarUrl || avatarUrl,
      phoneNumber: backendUser.phoneNumber || '',
      authMode: 'wechat',
      lastLoginAt: new Date().toISOString(),
    });

    let cloudDataApplied = false;

    try {
      console.log('📡 从后端拉取用户状态...');
      const stateResult = await fetchClientState({ userId });

      if (stateResult && stateResult.ok && stateResult.state) {
        console.log('✅ 从后端拉取到用户状态，积分:', stateResult.state.user?.points);
        applyRemoteState(stateResult.state, { cloudFirst: true });
        cloudDataApplied = true;
      }
    } catch (fetchErr) {
      console.warn('⚠️ 拉取云端状态失败:', fetchErr);
    }

    if (!cloudDataApplied) {
      try {
        console.log('📤 尝试通过同步获取云端数据...');
        const syncResult = await syncClientState({
          ...getSyncSnapshot(),
          userId,
          preferRemote: true,
        });

        if (syncResult && syncResult.ok && syncResult.state) {
          console.log('✅ 从同步响应中恢复云端数据');
          applyRemoteState(syncResult.state, { cloudFirst: true });
        }
      } catch (syncErr) {
        console.warn('⚠️ 同步获取云端数据失败:', syncErr);
      }
    }

    this._ensureAuthInfo(backendUser, avatarUrl, nickname);
  },

  async _loginWithLocalData(userId, backendUser, avatarUrl, nickname) {
    console.log('📦 本地有数据，合并云端数据...');

    const localSnapshot = getSyncSnapshot();

    let cloudDataApplied = false;

    try {
      console.log('📡 先从后端拉取用户状态...');
      const stateResult = await fetchClientState({ userId });

      if (stateResult && stateResult.ok && stateResult.state) {
        console.log('✅ 从后端拉取到用户状态，云端积分:', stateResult.state.user?.points);
        applyRemoteState(stateResult.state, { cloudFirst: true });
        cloudDataApplied = true;
      }
    } catch (fetchErr) {
      console.warn('⚠️ 拉取云端状态失败:', fetchErr);
    }

    if (!cloudDataApplied) {
      updateUserState({
        userId: userId,
        openid: backendUser.openid,
        nickname: backendUser.nickname || nickname || '微信用户',
        avatarUrl: backendUser.avatarUrl || backendUser.avatar || avatarUrl,
        avatar: backendUser.avatar || backendUser.avatarUrl || avatarUrl,
        phoneNumber: backendUser.phoneNumber || '',
        authMode: 'wechat',
        lastLoginAt: new Date().toISOString(),
      });
    }

    this._ensureAuthInfo(backendUser, avatarUrl, nickname);

    try {
      console.log('📤 同步本地数据到云端...');
      const currentSnapshot = getSyncSnapshot();
      const syncResult = await syncClientState({
        ...currentSnapshot,
        userId,
        preferRemote: false,
      });

      if (!cloudDataApplied && syncResult && syncResult.ok && syncResult.state) {
        console.log('✅ 从同步响应中恢复云端数据');
        applyRemoteState(syncResult.state, { cloudFirst: true });
        this._ensureAuthInfo(backendUser, avatarUrl, nickname);
      }
    } catch (syncErr) {
      console.warn('⚠️ 同步本地数据到云端失败:', syncErr);
    }
  },

  _ensureAuthInfo(backendUser, avatarUrl, nickname) {
    const currentUser = getUserState();
    updateUserState({
      userId: backendUser.userId || backendUser.openid || currentUser.userId,
      openid: backendUser.openid || currentUser.openid,
      nickname: backendUser.nickname || nickname || currentUser.nickname || '微信用户',
      avatarUrl: backendUser.avatarUrl || backendUser.avatar || avatarUrl || currentUser.avatarUrl,
      avatar: backendUser.avatar || backendUser.avatarUrl || avatarUrl || currentUser.avatar,
      authMode: 'wechat',
      lastLoginAt: new Date().toISOString(),
    });
  },

  localLogin(avatarUrl, nickname) {
    console.log('🔐 使用本地登录模式');
    const currentUser = getUserState();
    const existingOpenid = (currentUser.openid && currentUser.openid.startsWith('local_')) ? currentUser.openid : `local_${Date.now()}`;
    updateUserState({
      authMode: 'wechat',
      openid: existingOpenid,
      avatarUrl: avatarUrl || currentUser.avatarUrl,
      nickname: nickname || '微信用户',
      lastLoginAt: new Date().toISOString(),
    });

    wx.showToast({
      title: '登录成功（本地模式）',
      icon: 'success'
    });

    setTimeout(() => {
      this.goHome();
    }, 1000);
  },

  goHome() {
    wx.switchTab({
      url: '/pages/home/index',
    });
  },
});
