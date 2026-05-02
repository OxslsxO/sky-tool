const {
  getUserState,
  updateUserState,
  seedUserState,
} = require("../../utils/task-store");
const {
  buildServiceUrl,
  getServiceHeaders,
  hasBackendService,
} = require("../../services/backend-tools");

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

    const localUser = getUserState();
    const localPoints = localUser.points || 0;
    const localTasks = require("../../utils/task-store").getRawTasks();
    const localFavorites = require("../../utils/task-store").getFavorites();
    const localRecentToolIds = require("../../utils/task-store").getRecentToolIds();
    const localPointsRecords = require("../../utils/task-store").getPointsRecords();
    const localOrders = require("../../utils/task-store").getOrders();

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

        const remotePoints = user.points || 0;
        const mergedPoints = Math.max(localPoints, remotePoints);

        updateUserState({
          userId: user.userId || user.openid,
          openid: user.openid,
          nickname: user.nickname || '微信用户',
          avatarUrl: user.avatarUrl || user.avatar || avatarUrl,
          avatar: user.avatar || user.avatarUrl || avatarUrl,
          phoneNumber: user.phoneNumber || '',
          authMode: 'wechat',
          points: mergedPoints,
          lastLoginAt: new Date().toISOString(),
        });

        if (localTasks.length > 0) {
          const { saveTasks } = require("../../utils/task-store");
          saveTasks(localTasks, { silent: true });
        }
        if (localFavorites.length > 0) {
          const { setFavorites } = require("../../utils/task-store");
          setFavorites(localFavorites, { silent: true });
        }
        if (localRecentToolIds.length > 0) {
          const { setRecentToolIds } = require("../../utils/task-store");
          setRecentToolIds(localRecentToolIds, { silent: true });
        }
        if (localPointsRecords.length > 0) {
          const { addPointsRecord } = require("../../utils/task-store");
          wx.setStorageSync("sky_tools_points_records", localPointsRecords);
        }
        if (localOrders.length > 0) {
          wx.setStorageSync("sky_tools_orders", localOrders);
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
