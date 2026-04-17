const { getUserState, updateUserState } = require("../../utils/task-store");
const { hasBackendService } = require("../../services/backend-tools");
const { syncCloudState } = require("../../utils/sync-manager");

Page({
  data: {
    nickname: "",
    avatarUrl: "",
    saving: false,
    backendConfigured: false,
  },

  onLoad() {
    const user = getUserState();
    this.setData({
      nickname: user.nickname || "",
      avatarUrl: user.avatarUrl || "",
      backendConfigured: hasBackendService(),
    });
  },

  handleInput(event) {
    const { field } = event.currentTarget.dataset;
    this.setData({
      [field]: event.detail.value,
    });
  },

  async saveProfile() {
    if (this.data.saving) {
      return;
    }

    const nickname = (this.data.nickname || "").trim();

    if (!nickname) {
      wx.showToast({
        title: "Enter a nickname",
        icon: "none",
      });
      return;
    }

    this.setData({
      saving: true,
    });

    try {
      updateUserState({
        nickname,
        avatarUrl: (this.data.avatarUrl || "").trim(),
      });

      if (this.data.backendConfigured) {
        await syncCloudState({ force: true });
      }

      wx.showToast({
        title: "Saved",
        icon: "none",
      });

      setTimeout(() => {
        wx.navigateBack();
      }, 320);
    } catch (error) {
      wx.showToast({
        title: "Save failed",
        icon: "none",
      });
    } finally {
      this.setData({
        saving: false,
      });
    }
  },
});
