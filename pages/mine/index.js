const {
  listFavoriteTools,
  getRecentTools,
  getUserState,
  listTasks,
  getMemberStatus,
  applyRemoteState,
} = require("../../utils/task-store");
const {
  hasBackendService,
  shouldAllowManualServiceConfig,
  buildServiceUrl,
  getServiceHeaders,
} = require("../../services/backend-tools");
const { syncCloudState } = require("../../utils/sync-manager");
const { formatDateTime } = require("../../utils/format");

Page({
  data: {
    user: {},
    memberStatus: {},
    favorites: [],
    recents: [],
    taskCount: 0,
    backendConfigured: false,
    canConfigureBackend: false,
    syncBusy: false,
    syncHint: "Cloud sync is not configured yet",
    shortUserId: "--",
    authModeText: "Guest",
  },

  onShow() {
    this.refreshPage();
    
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 3
      });
    }
  },

  refreshPage() {
    const user = getUserState();
    const memberStatus = getMemberStatus();
    const backendConfigured = hasBackendService();

    this.setData({
      user,
      memberStatus,
      favorites: listFavoriteTools(),
      recents: getRecentTools(),
      taskCount: listTasks().length,
      backendConfigured,
      canConfigureBackend: shouldAllowManualServiceConfig(),
      syncHint: this.buildSyncHint(user, backendConfigured),
      shortUserId: this.buildShortUserId(user.userId || user.deviceId),
      authModeText: user.authMode === "wechat" ? "WeChat" : "Guest",
    });
  },

  buildSyncHint(user, backendConfigured) {
    if (!backendConfigured) {
      return "Configure cloud service to sync tasks and account state";
    }

    if (user.syncStatus === "syncing") {
      return "Syncing cloud state...";
    }

    if (user.lastSyncedAt) {
      return `Last synced at ${formatDateTime(user.lastSyncedAt)}`;
    }

    return "Ready to sync for the first time";
  },

  buildShortUserId(value) {
    if (!value) {
      return "--";
    }

    return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
  },

  handleToolSelect(event) {
    const { id } = event.detail;
    wx.navigateTo({
      url: `/pages/tool-detail/index?id=${id}`,
    });
  },

  openServiceConfig() {
    if (!this.data.canConfigureBackend) {
      wx.showToast({
        title: "当前版本不向用户开放服务配置",
        icon: "none",
      });
      return;
    }

    wx.navigateTo({
      url: "/pages/service-config/index",
    });
  },

  openProfileEdit() {
    wx.navigateTo({
      url: "/pages/profile-edit/index",
    });
  },

  openVip() {
    wx.navigateTo({
      url: "/pages/vip/index",
    });
  },

  async syncNow() {
    if (this.data.syncBusy) {
      return;
    }

    if (!this.data.backendConfigured) {
      if (this.data.canConfigureBackend) {
        this.openServiceConfig();
      } else {
        wx.showToast({
          title: "云同步暂不可用",
          icon: "none",
        });
      }
      return;
    }

    this.setData({
      syncBusy: true,
      syncHint: "Syncing cloud state...",
    });

    try {
      await syncCloudState({ force: true });
      this.refreshPage();
      wx.showToast({
        title: "Synced",
        icon: "none",
      });
    } catch (error) {
      this.refreshPage();
      wx.showToast({
        title: "Sync failed",
        icon: "none",
      });
    } finally {
      this.setData({
        syncBusy: false,
      });
    }
  },

  async tryRecoverData() {
    if (!hasBackendService()) {
      wx.showToast({
        title: "请先配置后端服务",
        icon: "none",
      });
      return;
    }

    wx.showLoading({ title: "查找数据中..." });

    try {
      // 先尝试查找最近的用户
      const recentUsers = await this.fetchRecentUsers();
      
      wx.hideLoading();

      if (!recentUsers || recentUsers.length === 0) {
        wx.showModal({
          title: "未找到数据",
          content: "没有找到可恢复的历史数据",
          showCancel: false,
        });
        return;
      }

      // 让用户选择恢复哪个
      const userOptions = recentUsers.map((u, idx) => {
        const points = u.points || 0;
        const memberInfo = u.memberActive 
          ? `${u.memberPlan || '会员'}(至${u.memberExpire ? u.memberExpire.substring(0,10) : '未知'})` 
          : '普通用户';
        const date = u.updatedAt ? new Date(u.updatedAt).toLocaleDateString() : '未知';
        return `${idx + 1}. ${memberInfo} · ${points}积分 · ${date}`;
      });

      userOptions.push('取消');

      wx.showActionSheet({
        itemList: userOptions,
        success: async (res) => {
          if (res.tapIndex === recentUsers.length) return;

          const selectedUser = recentUsers[res.tapIndex];
          await this.confirmAndRecover(selectedUser);
        },
      });
    } catch (err) {
      wx.hideLoading();
      console.error("恢复失败:", err);
      wx.showToast({
        title: "查找失败",
        icon: "none",
      });
    }
  },

  async fetchRecentUsers() {
    return new Promise((resolve, reject) => {
      wx.request({
        url: buildServiceUrl("/api/tools/usage"),
        method: "GET",
        header: {
          "content-type": "application/json",
          ...getServiceHeaders(),
        },
        success: async (response) => {
          if (response.statusCode === 200 && response.data) {
            // 这个接口其实不是查用户的，让我们直接用一个新的临时方法
            // 我们直接调用我们自定义的查找最近用户的逻辑
            const recentUsers = await this.tryFindRecentUsersDirectly();
            resolve(recentUsers);
          } else {
            reject(new Error("获取失败"));
          }
        },
        fail: reject,
      });
    });
  },

  async tryFindRecentUsersDirectly() {
    // 直接尝试用各种可能的方式查找
    // 1. 先用当前用户试试
    const currentUser = getUserState();
    let foundState = null;

    try {
      const result = await new Promise((resolve, reject) => {
        wx.request({
          url: buildServiceUrl("/api/client/state?tryRecover=1"),
          method: "GET",
          header: {
            "content-type": "application/json",
            ...getServiceHeaders(),
          },
          success: resolve,
          fail: reject,
        });
      });

      if (result.statusCode === 200 && result.data && result.data.state) {
        foundState = result.data.state;
      }
    } catch (e) {
      console.log("尝试查找失败:", e);
    }

    if (foundState && foundState.user) {
      return [foundState.user];
    }

    return [];
  },

  async confirmAndRecover(userInfo) {
    wx.showModal({
      title: "确认恢复",
      content: `确定要恢复这个账号的数据吗？\n积分: ${userInfo.points || 0}\n会员: ${userInfo.memberActive ? '是' : '否'}`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: "恢复中..." });
          
          try {
            // 构建一个最小化的 state 来应用
            const stateToApply = {
              user: userInfo,
              tasks: [],
              favorites: [],
              recentToolIds: [],
              pointsRecords: [],
              orders: [],
            };

            // 应用恢复的数据
            applyRemoteState(stateToApply);
            
            // 刷新页面
            this.refreshPage();
            
            wx.hideLoading();
            wx.showToast({
              title: "恢复成功！",
              icon: "success",
            });
          } catch (e) {
            wx.hideLoading();
            wx.showToast({
              title: "恢复失败",
              icon: "none",
            });
          }
        }
      },
    });
  },
});
