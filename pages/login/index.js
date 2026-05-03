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

Page({
  data: {
    loading: false,
  },

  onLoad() {
    const user = getUserState();
    if (user && user.openid && user.authMode === 'wechat') {
      this.goHome();
    }
  },

  async onChooseAvatar(e) {
    console.log('🎯 获取到微信头像:', e.detail);
    const { avatarUrl } = e.detail;

    this.setData({ loading: true });
    try {
      await this.loginWechat(avatarUrl);
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

  async loginWechat(avatarUrl) {
    console.log('🔄 开始微信登录...');

    const localSnapshot = getSyncSnapshot();

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
        this.localLogin(avatarUrl);
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
              nickName: '微信用户',
            },
          },
          success: resolve,
          fail: reject,
        });
      });

      console.log('📥 后端登录响应:', result);

      if (result.statusCode === 200 && result.data.ok) {
        const { user } = result.data;

        console.log('✅ 登录成功！用户信息:', user);
        console.log('🔑 真实 openid:', user.openid);

        updateUserState({
          userId: user.userId || user.openid,
          openid: user.openid,
          nickname: user.nickname || '微信用户',
          avatarUrl: user.avatarUrl || user.avatar || avatarUrl,
          avatar: user.avatar || user.avatarUrl || avatarUrl,
          phoneNumber: user.phoneNumber || '',
          authMode: 'wechat',
          lastLoginAt: new Date().toISOString(),
        });

        let remoteStateApplied = false;

        try {
          console.log('📡 尝试从后端拉取用户状态...');
          const stateResult = await fetchClientState({
            userId: user.userId || user.openid,
          });

          if (stateResult && stateResult.ok && stateResult.state) {
            console.log('✅ 从后端拉取到用户状态:', stateResult.state);
            applyRemoteState(stateResult.state);
            remoteStateApplied = true;
            console.log('✅ 本地状态已更新为云端数据');
          }
        } catch (fetchErr) {
          console.warn('⚠️ 拉取云端状态失败:', fetchErr);
        }

        try {
          if (localSnapshot.tasks.length > 0 || 
              localSnapshot.favorites.length > 0 || 
              localSnapshot.pointsRecords.length > 0 || 
              localSnapshot.orders.length > 0) {
            console.log('📤 同步本地数据到云端...');
            const syncResult = await syncClientState({
              ...localSnapshot,
              userId: user.userId || user.openid,
              preferRemote: true,
            });

            if (!remoteStateApplied && syncResult && syncResult.ok && syncResult.state) {
              console.log('✅ 从同步响应中恢复云端数据');
              applyRemoteState(syncResult.state);
            }
          }
        } catch (syncErr) {
          console.warn('⚠️ 同步本地数据到云端失败:', syncErr);
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
      this.localLogin(avatarUrl);
    }
  },

  localLogin(avatarUrl) {
    console.log('🔐 使用本地登录模式');
    const currentUser = getUserState();
    const existingOpenid = (currentUser.openid && currentUser.openid.startsWith('local_')) ? currentUser.openid : `local_${Date.now()}`;
    updateUserState({
      authMode: 'wechat',
      openid: existingOpenid,
      avatarUrl: avatarUrl || currentUser.avatarUrl,
      nickName: '微信用户',
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
