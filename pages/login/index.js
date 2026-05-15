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
    agreed: false,
  },

  onLoad() {
    const user = getUserState();
    if (user && user.openid && user.authMode === 'wechat') {
      this.goHome();
    }
  },

  toggleAgree() {
    this.setData({
      agreed: !this.data.agreed,
    });
  },

  onChooseAvatar(e) {
    if (!this.data.agreed) {
      wx.showToast({
        title: '请先同意用户协议和隐私政策',
        icon: 'none',
      });
      return;
    }
    const { avatarUrl } = e.detail;
    this.setData({ loading: true });
    this.loginWechat(avatarUrl || '', '微信用户');
  },

  goPrivacy() {
    wx.navigateTo({
      url: '/pages/privacy/index',
    });
  },

  goAgreement() {
    wx.navigateTo({
      url: '/pages/agreement/index',
    });
  },

  goHomeAsGuest() {
    wx.switchTab({
      url: '/pages/home/index',
    });
  },

  async loginWechat(avatarUrl, nickname) {
    console.log('🔄 开始微信登录...');

    try {
      // 第一步：立即获取本地用户状态，检查是否已有登录信息
      const existingUser = getUserState();
      if (existingUser && existingUser.openid && existingUser.authMode === 'wechat') {
        console.log('ℹ️ 发现本地已有登录信息，尝试快速登录');
      }

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

      // 先发送登录请求
      const resultPromise = new Promise((resolve, reject) => {
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

      // 同时检查本地数据
      const hasLocalData = this._hasLocalUserData();

      // 等待登录响应
      const result = await resultPromise;

      console.log('📥 后端登录响应:', result);

      if (result.statusCode === 200 && result.data.ok) {
        const { user } = result.data;
        const userId = user.userId || user.openid;

        console.log('✅ 登录成功！用户信息:', user);
        console.log('🔑 真实 openid:', user.openid);

        // 根据是否有本地数据选择登录策略
        if (hasLocalData) {
          await this._loginWithLocalData(userId, user, avatarUrl, nickname);
        } else {
          await this._loginWithCloudData(userId, user, avatarUrl, nickname);
        }

        wx.showToast({
          title: '登录成功',
          icon: 'success',
          duration: 800
        });

        setTimeout(() => {
          this.goHome();
        }, 800);
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
    const currentUser = getUserState();
    const isNewUser = !currentUser.openid;

    // 立即更新用户状态，不等待云端数据
    updateUserState({
      userId: userId,
      openid: backendUser.openid,
      nickname: backendUser.nickname || nickname || '微信用户',
      avatarUrl: backendUser.avatarUrl || backendUser.avatar || avatarUrl,
      avatar: backendUser.avatar || backendUser.avatarUrl || avatarUrl,
      phoneNumber: backendUser.phoneNumber || '',
      authMode: 'wechat',
      points: isNewUser ? 100 : currentUser.points,
      lastLoginAt: new Date().toISOString(),
    });

    // 如果是新用户，添加积分记录
    if (isNewUser) {
      const { addPointsRecord } = require("../../utils/task-store");
      addPointsRecord({
        type: "recharge",
        title: "新用户注册奖励",
        change: 100,
      });
    }

    // 确保认证信息正确
    this._ensureAuthInfo(backendUser, avatarUrl, nickname);

    // 异步拉取云端数据，不阻塞登录流程
    this._asyncFetchCloudData(userId);
  },

  async _asyncFetchCloudData(userId) {
    let cloudRestored = false;
    try {
      console.log('📡 异步从后端拉取用户状态...');
      const stateResult = await Promise.race([
        fetchClientState({ userId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);

      if (stateResult && stateResult.ok && stateResult.state) {
        console.log('✅ 从后端拉取到用户状态');
        applyRemoteState(stateResult.state, { cloudFirst: true });
        cloudRestored = true;
      } else {
        throw new Error('invalid response');
      }
    } catch (err) {
      console.warn('⚠️ 拉取云端状态失败，尝试同步:', err);
      try {
        const syncResult = await Promise.race([
          syncClientState({
            ...getSyncSnapshot(),
            userId,
            preferRemote: true,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]);

        if (syncResult && syncResult.ok && syncResult.state) {
          console.log('✅ 从同步响应中恢复云端数据');
          applyRemoteState(syncResult.state, { cloudFirst: true });
          cloudRestored = true;
        }
      } catch (syncErr) {
        console.warn('⚠️ 同步获取云端数据也失败:', syncErr);
      }
    }

    if (!cloudRestored) {
      const currentTasks = getRawTasks();
      if (currentTasks.length === 0) {
        console.log('📝 云端恢复失败且本地无数据，初始化演示数据...');
        seedMockTasks();
      }
    }
  },

  async _loginWithLocalData(userId, backendUser, avatarUrl, nickname) {
    console.log('📦 本地有数据，合并云端数据...');

    // 立即更新用户状态，不等待云端数据
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

    this._ensureAuthInfo(backendUser, avatarUrl, nickname);

    // 异步同步数据到云端，不阻塞登录流程
    this._asyncSyncLocalDataToCloud(userId, backendUser, avatarUrl, nickname);
  },

  async _asyncSyncLocalDataToCloud(userId, backendUser, avatarUrl, nickname) {
    let cloudDataApplied = false;

    try {
      console.log('📡 异步从后端拉取用户状态...');
      const stateResult = await Promise.race([
        fetchClientState({ userId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);

      if (stateResult && stateResult.ok && stateResult.state) {
        console.log('✅ 从后端拉取到用户状态');
        applyRemoteState(stateResult.state, { cloudFirst: true });
        cloudDataApplied = true;
      }
    } catch (fetchErr) {
      console.warn('⚠️ 拉取云端状态失败:', fetchErr);
    }

    try {
      console.log('📤 异步同步本地数据到云端...');
      const currentSnapshot = getSyncSnapshot();
      const syncResult = await Promise.race([
        syncClientState({
          ...currentSnapshot,
          userId,
          preferRemote: false,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ]);

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
    const isNewUser = !currentUser.openid;
    const existingOpenid = (currentUser.openid && currentUser.openid.startsWith('local_')) ? currentUser.openid : `local_${Date.now()}`;
    
    updateUserState({
      authMode: 'wechat',
      openid: existingOpenid,
      avatarUrl: avatarUrl || currentUser.avatarUrl,
      nickname: nickname || '微信用户',
      points: isNewUser ? 100 : currentUser.points,
      lastLoginAt: new Date().toISOString(),
    });

    // 如果是新用户，添加积分记录
    if (isNewUser) {
      const { addPointsRecord } = require("../../utils/task-store");
      addPointsRecord({
        type: "recharge",
        title: "新用户注册奖励",
        change: 100,
      });
    }

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
