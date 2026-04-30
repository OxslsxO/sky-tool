const {
  getUserState,
  updateUserState,
} = require("../../utils/task-store");
const {
  buildServiceUrl,
  getServiceHeaders,
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

    const loginRes = await new Promise((resolve, reject) => {
      wx.login({
        success: resolve,
        fail: reject,
      });
    });

    console.log('✅ 获取到登录 code:', loginRes.code);

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
        ...user,
        authMode: 'wechat',
        lastLoginAt: new Date().toISOString(),
      });

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
  },

  goHome() {
    wx.switchTab({
      url: '/pages/home/index',
    });
  },
});
