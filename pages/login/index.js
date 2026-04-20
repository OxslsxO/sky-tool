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
    step: 'login', // 'login' | 'bind-phone' | 'success'
    userInfo: null,
  },

  onLoad() {
    // 检查是否已登录
    const user = getUserState();
    if (user && user.openid && user.authMode === 'wechat' && user.phoneNumber) {
      this.goHome();
    }
  },

  async onGetUserInfo(e) {
    if (!e.detail.userInfo) {
      wx.showToast({
        title: '需要授权才能使用',
        icon: 'none',
      });
      return;
    }

    this.setData({
      userInfo: e.detail.userInfo,
      loading: true,
    });

    try {
      await this.loginWechat(e.detail.userInfo);
    } catch (err) {
      console.error('登录失败:', err);
      wx.showToast({
        title: '登录失败',
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loginWechat(userInfo) {
    // 1. 获取登录凭证 code
    const loginRes = await new Promise((resolve, reject) => {
      wx.login({
        success: resolve,
        fail: reject,
      });
    });

    // 2. 发送到后端登录
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
          userInfo,
        },
        success: resolve,
        fail: reject,
      });
    });

    if (result.statusCode === 200 && result.data.ok) {
      const { user, isNewUser } = result.data;
      
      // 保存登录状态
      updateUserState({
        ...user,
        authMode: 'wechat',
        lastLoginAt: new Date().toISOString(),
      });

      console.log(`登录成功: isNewUser=${isNewUser}, phoneNumber=${user.phoneNumber ? 'yes' : 'no'}`);

      // 判断流程：
      // 老用户且有手机号 → 直接进首页
      // 新用户，或者老用户没手机号 → 需要绑定手机
      if (!isNewUser && user.phoneNumber) {
        // 老用户，有手机号 → 直接进入首页
        this.setData({ step: 'success' });
        setTimeout(() => this.goHome(), 1500);
      } else {
        // 新用户，或者老用户没手机号 → 需要绑定手机号
        this.setData({ step: 'bind-phone' });
      }
    } else {
      throw new Error('登录失败');
    }
  },

  async onGetPhoneNumber(e) {
    console.log('手机号授权回调:', JSON.stringify(e.detail));
    
    // 支持多种场景：真实 code、测试跳过、点击按钮直接跳过
    let needBind = true;
    let phoneCode = null;
    
    if (e.type === 'tap' || !e.detail) {
      // 是点击按钮直接进来的，不是授权回调（用于测试）
      console.log('测试模式：跳过真实手机号授权');
    } else if (e.detail.errMsg === 'getPhoneNumber:ok') {
      // 真实授权成功
      phoneCode = e.detail.code || e.detail.encryptedData;
    } else if (e.detail.errMsg === 'getPhoneNumber:fail user deny') {
      // 用户拒绝
      wx.showModal({
        title: '提示',
        content: '需要获取您的手机号才能继续使用',
        showCancel: false,
      });
      return;
    } else {
      // 其他情况，先尝试继续
      phoneCode = e.detail.code || e.detail.encryptedData;
    }

    this.setData({ loading: true });

    try {
      const currentUser = getUserState();
      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: buildServiceUrl("/api/auth/bind-phone"),
          method: "POST",
          header: {
            "content-type": "application/json",
            ...getServiceHeaders(),
          },
          data: {
            code: phoneCode || 'test_code', // 测试时用 test_code
            userId: currentUser.userId,
            openid: currentUser.openid,
          },
          success: resolve,
          fail: reject,
        });
      });

      if (result.statusCode === 200 && result.data.ok) {
        const { user } = result.data;
        
        updateUserState({
          phoneNumber: user.phoneNumber,
        });

        this.setData({ step: 'success' });
        setTimeout(() => this.goHome(), 1500);
      } else {
        throw new Error('绑定失败');
      }
    } catch (err) {
      console.error('绑定手机号失败:', err);
      wx.showToast({
        title: '绑定失败',
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  goHome() {
    wx.switchTab({
      url: '/pages/home/index',
    });
  },
});
