const {
  listFavoriteTools,
  getRecentTools,
  getUserState,
  listTasks,
  getMemberStatus,
} = require("../../utils/task-store");
const {
  hasBackendService,
  shouldAllowManualServiceConfig,
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
});
