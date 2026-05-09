const { getTaskById } = require("../../utils/task-store");
const { getToolById } = require("../../data/mock");
const { downloadRemoteFile } = require("../../services/remote-executor");

const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "ogg", "m4a", "aac"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"];

function isAudioTask(task) {
  if (!task || !task.toolId) return false;
  if (task.outputName) {
    const ext = task.outputName.split(".").pop().toLowerCase();
    return AUDIO_EXTENSIONS.includes(ext);
  }
  if (task.toolId === "audio-convert" && task.selections && task.selections.target) {
    return AUDIO_EXTENSIONS.includes(String(task.selections.target).toLowerCase());
  }
  return false;
}

const TASK_RETENTION_DAYS = 7;

Page({
  data: {
    taskId: "",
    task: null,
    configEntries: [],
    isAudioTask: false,
    audioUrl: "",
    isPlaying: false,
    audioContext: null,
    audioMetaText: "",
    taskRetentionDays: TASK_RETENTION_DAYS,
  },

  onLoad(options) {
    this.setData({
      taskId: options.id,
    });
    this.refreshTask();
  },

  onShow() {
    this.refreshTask();
    this.startTimer();
  },

  onHide() {
    this.clearTimer();
  },

  onUnload() {
    this.clearTimer();
  },

  startTimer() {
    this.clearTimer();
    this.timer = setInterval(() => {
      const task = getTaskById(this.data.taskId);
      if (!task || task.status !== "processing") {
        this.clearTimer();
        if (task) {
          this.refreshTask();
        }
      } else {
        this.refreshTask();
      }
    }, 2000); // 从1.2秒延长到2秒
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  refreshTask() {
    const task = getTaskById(this.data.taskId);

    if (!task) {
      return;
    }

    const audioTask = isAudioTask(task);
    let audioUrl = "";
    let audioMetaText = "";
    if (audioTask) {
      audioUrl = task.outputPath || task.remoteUrl || "";
      const afterSize = task.afterSize || 0;
      audioMetaText = `点击播放 · ${afterSize.toFixed(1)} MB`;
    }

    this.setData({
      task,
      configEntries: this.buildConfigEntries(task),
      isAudioTask: audioTask,
      audioUrl,
      audioMetaText,
    });
  },

  buildConfigEntries(task) {
    const tool = getToolById(task.toolId);
    if (!tool) {
      return [];
    }

    return tool.params.map((param) => ({
      key: param.key,
      label: param.label,
      value: task.selections[param.key],
    }));
  },

  handleRetry() {
    const { task } = this.data;
    wx.navigateTo({
      url: `/pages/tool-detail/index?id=${task.toolId}&selections=${encodeURIComponent(JSON.stringify(task.selections))}`,
    });
  },

  openTool() {
    const { task } = this.data;
    wx.navigateTo({
      url: `/pages/tool-detail/index?id=${task.toolId}`,
    });
  },

  openTasks() {
    wx.switchTab({
      url: "/pages/tasks/index",
    });
  },

  previewResult() {
    const { task } = this.data;
    if (!task.previewPath || task.status === 'expired') {
      return;
    }

    wx.previewImage({
      current: task.previewPath,
      urls: [task.previewPath],
    });
  },

  async saveResult() {
    const { task } = this.data;
    if (task.status === 'expired') {
      wx.showToast({ title: "任务已过期", icon: "none" });
      return;
    }

    let filePath = task.outputPath;

    if (!filePath && task.remoteUrl) {
      wx.showLoading({ title: "正在下载...", mask: true });
      try {
        const download = await downloadRemoteFile(task.remoteUrl, { maxRetries: 2 });
        wx.hideLoading();
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      } catch (err) {
        wx.hideLoading();
        wx.showToast({ title: "下载失败", icon: "none" });
        return;
      }
    }

    if (!filePath) {
      wx.showToast({ title: "文件不存在", icon: "none" });
      return;
    }

    const ext = (task.outputName || "").split(".").pop().toLowerCase() || (filePath || "").split(".").pop().toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(ext);
    const isImage = ["jpg", "jpeg", "png", "webp", "bmp", "gif"].includes(ext);

    if (isVideo) {
      try {
        await new Promise((resolve, reject) => {
          wx.saveVideoToPhotosAlbum({
            filePath,
            success: resolve,
            fail: reject,
          });
        });
        wx.showToast({ title: "已保存到相册", icon: "none" });
      } catch (err) {
        const errMsg = (err && err.errMsg) || "";
        if (errMsg.indexOf("auth deny") > -1 || errMsg.indexOf("拒绝") > -1) {
          wx.showModal({
            title: "需要相册权限",
            content: "请在设置中允许访问相册，以便保存视频",
            confirmText: "去设置",
            success: (res) => {
              if (res.confirm) wx.openSetting();
            },
          });
        } else {
          wx.openDocument({
            filePath,
            showMenu: true,
            fail: () => {
              wx.showToast({ title: "保存失败", icon: "none" });
            },
          });
        }
      }
      return;
    }

    if (isImage) {
      try {
        await new Promise((resolve, reject) => {
          wx.saveImageToPhotosAlbum({
            filePath,
            success: resolve,
            fail: reject,
          });
        });
        wx.showToast({ title: "已保存到相册", icon: "none" });
      } catch (err) {
        const errMsg = (err && err.errMsg) || "";
        if (errMsg.indexOf("auth deny") > -1 || errMsg.indexOf("拒绝") > -1) {
          wx.showModal({
            title: "需要相册权限",
            content: "请在设置中允许访问相册，以便保存图片",
            confirmText: "去设置",
            success: (res) => {
              if (res.confirm) wx.openSetting();
            },
          });
        } else {
          wx.showToast({ title: "保存失败", icon: "none" });
        }
      }
      return;
    }

    wx.openDocument({
      filePath,
      showMenu: true,
      fail: () => {
        wx.showToast({ title: "打开文件失败", icon: "none" });
      },
    });
  },

  openDocumentResult() {
    const { task } = this.data;
    if (task.status === 'expired') {
      wx.showToast({
        title: "任务已过期，文件已不可用",
        icon: "none",
      });
      return;
    }

    if (task.outputPath) {
      wx.openDocument({
        filePath: task.outputPath,
        showMenu: true,
        fail: () => {
          wx.showToast({
            title: "打开文件失败",
            icon: "none",
          });
        },
      });
      return;
    }

    if (!task.remoteUrl) {
      return;
    }

    this.downloadAndOpen(task.remoteUrl);
  },

  copyResult() {
    const { task } = this.data;
    if (!task.copyText) {
      return;
    }

    wx.setClipboardData({
      data: task.copyText,
      success: () => {
        wx.showToast({
          title: "已复制结果",
          icon: "none",
        });
      },
    });
  },

  copyDownloadLink() {
    const { task } = this.data;
    if (!task.remoteUrl || task.status === 'expired') {
      if (task.status === 'expired') {
        wx.showToast({
          title: "任务已过期，文件已不可用",
          icon: "none",
        });
      }
      return;
    }

    wx.setClipboardData({
      data: task.remoteUrl,
      success: () => {
        wx.showToast({
          title: "已复制下载链接",
          icon: "none",
        });
      },
    });
  },

  async downloadAndOpen(url) {
    try {
      const result = await downloadRemoteFile(url, { maxRetries: 2 });

      if (result.statusCode && result.statusCode >= 400) {
        throw new Error("DOWNLOAD_FAILED");
      }

      wx.openDocument({
        filePath: result.tempFilePath,
        showMenu: true,
      });
    } catch (error) {
      let errorMsg = "下载或打开失败";
      let showCopyLink = false;
      
      if (error && error.errMsg) {
        if (error.errMsg.indexOf("exceed") > -1 || error.errMsg.indexOf("max") > -1) {
          errorMsg = "文件过大，超过小程序限制";
          showCopyLink = true;
        }
      }
      
      if (showCopyLink) {
        wx.showModal({
          title: "提示",
          content: errorMsg + "\n是否复制下载链接，用浏览器打开？",
          confirmText: "复制链接",
          success: (res) => {
            if (res.confirm) {
              wx.setClipboardData({
                data: url,
                success: () => {
                  wx.showToast({
                    title: "已复制链接",
                    icon: "none",
                  });
                },
              });
            }
          },
        });
      } else {
        wx.showToast({
          title: errorMsg,
          icon: "none",
        });
      }
    }
  },

  openAttachment(event) {
    const { task } = this.data;
    if (task.status === 'expired') {
      wx.showToast({
        title: "任务已过期，文件已不可用",
        icon: "none",
      });
      return;
    }

    const { url } = event.currentTarget.dataset;
    if (!url) {
      return;
    }

    this.downloadAndOpen(url);
  },

  toggleAudioPlay() {
    const { audioUrl, isPlaying, audioContext, task } = this.data;
    if (task.status === 'expired') {
      wx.showToast({
        title: "任务已过期，文件已不可用",
        icon: "none",
      });
      return;
    }

    if (!audioUrl) {
      wx.showToast({
        title: "音频文件不可用",
        icon: "none",
      });
      return;
    }

    const afterSize = task.afterSize || 0;
    const sizeText = afterSize.toFixed(1) + " MB";

    if (isPlaying) {
      if (audioContext) {
        audioContext.pause();
      }
      this.setData({
        isPlaying: false,
        audioMetaText: `点击播放 · ${sizeText}`,
      });
    } else {
      let context = audioContext;
      if (!context) {
        context = wx.createInnerAudioContext();
        context.src = audioUrl;
        context.onEnded(() => {
          this.setData({
            isPlaying: false,
            audioMetaText: `点击播放 · ${sizeText}`,
          });
        });
        context.onError((err) => {
          console.error("[Audio] 播放错误:", err);
          wx.showToast({
            title: "播放失败",
            icon: "none",
          });
          this.setData({
            isPlaying: false,
            audioMetaText: `点击播放 · ${sizeText}`,
          });
        });
        this.setData({ audioContext: context });
      }
      context.play();
      this.setData({
        isPlaying: true,
        audioMetaText: `正在播放... · ${sizeText}`,
      });
    }
  },

  async openAudioFile() {
    const { task } = this.data;
    let filePath = task.outputPath;

    try {
      if (!filePath && task.remoteUrl) {
        wx.showLoading({
          title: "下载中...",
        });
        const download = await downloadRemoteFile(task.remoteUrl, { maxRetries: 2 });
        wx.hideLoading();
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("AUDIO_FILE_MISSING");
      }

      const ext = (task.outputName || "audio.mp3").split(".").pop().toLowerCase();
      const supportedExts = ["mp3", "m4a", "aac"];

      if (!supportedExts.includes(ext)) {
        wx.showModal({
          title: "提示",
          content: `微信暂不支持直接打开 .${ext} 格式。\n建议：\n1. 先在上方播放预览\n2. 或用“保存到手机”后用其他播放器打开`,
          showCancel: false,
          confirmText: "知道了",
        });
        return;
      }

      wx.openDocument({
        filePath: filePath,
        fileType: ext === "m4a" ? "docx" : (ext === "aac" ? "docx" : ext),
        success: () => {
          console.log("[Audio] 文件打开成功");
        },
        fail: (err) => {
          console.error("[Audio] 文件打开失败:", err);
          wx.showModal({
            title: "打开失败",
            content: "无法直接打开此文件，建议先播放预览或保存后用其他播放器打开。",
            showCancel: false,
            confirmText: "知道了",
          });
        },
      });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({
        title: "下载失败",
        icon: "none",
      });
    }
  },

  async saveAudioFile() {
    const { task } = this.data;
    let filePath = task.outputPath;

    try {
      if (!filePath && task.remoteUrl) {
        wx.showLoading({
          title: "下载中...",
        });
        const download = await downloadRemoteFile(task.remoteUrl, { maxRetries: 2 });
        wx.hideLoading();
        if (download.statusCode >= 200 && download.statusCode < 300) {
          filePath = download.tempFilePath || "";
        }
      }

      if (!filePath) {
        throw new Error("AUDIO_FILE_MISSING");
      }

      wx.saveFile({
        tempFilePath: filePath,
        success: (res) => {
          wx.showToast({
            title: "已保存到手机",
            icon: "none",
          });
        },
        fail: () => {
          wx.showToast({
            title: "保存失败，请用“打开文件”",
            icon: "none",
            duration: 2000,
          });
        },
      });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({
        title: "下载失败",
        icon: "none",
      });
    }
  },

  onUnload() {
    if (this.data.audioContext) {
      this.data.audioContext.destroy();
    }
  },
});
