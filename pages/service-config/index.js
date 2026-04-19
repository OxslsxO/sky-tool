const {
  getServiceConfig,
  saveServiceConfig,
  clearServiceConfig,
  requestHealthCheck,
  shouldAllowManualServiceConfig,
} = require("../../services/backend-tools");

Page({
  data: {
    baseUrl: "",
    token: "",
    testing: false,
    statusText: "Not checked",
    statusTone: "neutral",
    capabilities: [],
    authRequired: false,
    fileTtlHours: "",
    publicBaseUrl: "",
    storageProvider: "",
    storageBucket: "",
    repositoryProvider: "",
    clientStateProvider: "",
    officeAvailable: false,
    officePath: "",
  },

  onShow() {
    if (!shouldAllowManualServiceConfig()) {
      wx.showToast({
        title: "当前版本不向用户开放服务配置",
        icon: "none",
      });
      wx.navigateBack({
        fail: () => {
          wx.switchTab({
            url: "/pages/mine/index",
          });
        },
      });
      return;
    }

    const config = getServiceConfig();
    this.setData({
      baseUrl: config.baseUrl || "",
      token: config.token || "",
    });

    if (config.baseUrl) {
      this.testConfig(true);
    }
  },

  handleInput(event) {
    const { field } = event.currentTarget.dataset;
    this.setData({
      [field]: event.detail.value,
    });
  },

  saveConfig() {
    saveServiceConfig({
      baseUrl: this.data.baseUrl.trim(),
      token: this.data.token.trim(),
    });

    wx.showToast({
      title: "Saved",
      icon: "none",
    });
  },

  clearConfig() {
    clearServiceConfig();
    this.setData({
      baseUrl: "",
      token: "",
      testing: false,
      statusText: "Not checked",
      statusTone: "neutral",
      capabilities: [],
      authRequired: false,
      fileTtlHours: "",
      publicBaseUrl: "",
      storageProvider: "",
      storageBucket: "",
      repositoryProvider: "",
      clientStateProvider: "",
      officeAvailable: false,
      officePath: "",
    });

    wx.showToast({
      title: "Cleared",
      icon: "none",
    });
  },

  async testConfig(silent) {
    this.setData({
      testing: true,
      statusText: "Checking...",
      statusTone: "neutral",
    });

    try {
      const response = await requestHealthCheck();
      const data = response.data || {};
      const capabilities = Object.keys(data.capabilities || {}).map((key) => ({
        key,
        label: this.getCapabilityLabel(key),
        enabled: !!data.capabilities[key],
      }));

      this.setData({
        statusText: "Connected",
        statusTone: "success",
        capabilities,
        authRequired: !!data.authRequired,
        fileTtlHours: data.fileTtlHours || "",
        publicBaseUrl: data.publicBaseUrl || "",
        storageProvider: this.getStorageLabel(data.storage),
        storageBucket: data.storage && data.storage.bucket ? data.storage.bucket : "",
        repositoryProvider: this.getRepositoryLabel(data.repository),
        clientStateProvider: this.getRepositoryLabel(data.clientState),
        officeAvailable: !!(data.office && data.office.available),
        officePath: data.office && data.office.path ? data.office.path : "",
      });

      if (!silent) {
        wx.showToast({
          title: "Connected",
          icon: "none",
        });
      }
    } catch (error) {
      this.setData({
        statusText: "Failed",
        statusTone: "danger",
        capabilities: [],
        publicBaseUrl: "",
        storageProvider: "",
        storageBucket: "",
        repositoryProvider: "",
        clientStateProvider: "",
        officeAvailable: false,
        officePath: "",
      });

      if (!silent) {
        wx.showToast({
          title: "Check failed",
          icon: "none",
        });
      }
    } finally {
      this.setData({
        testing: false,
      });
    }
  },

  getCapabilityLabel(key) {
    const map = {
      pdfMerge: "PDF Merge",
      pdfSplit: "PDF Split",
      pdfCompress: "PDF Compress",
      ocrImage: "Image OCR",
      baiduOcr: "Baidu OCR",
      officeToPdf: "Office to PDF",
    };

    return map[key] || key;
  },

  getStorageLabel(storage) {
    if (!storage || !storage.provider) {
      return "";
    }

    return storage.provider === "qiniu" ? "Qiniu Kodo" : "Local Disk";
  },

  getRepositoryLabel(repository) {
    if (!repository || !repository.provider) {
      return "";
    }

    return repository.provider === "mongodb" ? "MongoDB" : "Local File";
  },
});
