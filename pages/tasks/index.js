const { getRawTasks, getTaskById, getTaskDashboard, cleanTasksForCurrentUser } = require("../../utils/task-store");
const { getToolById } = require("../../data/mock");
const { ensureWechatLogin } = require("../../utils/page-auth");

function getTaskListForDisplay() {
  // 清理不属于当前用户的任务
  cleanTasksForCurrentUser();
  const rawTasks = getRawTasks();
  const now = Date.now();
  
  return rawTasks.map(task => {
    let status = task.status;
    let progress = 100;

    const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    if (now - task.createdAt > TASK_RETENTION_MS) {
      status = "expired";
    } else if (task.status === "processing") {
      const elapsed = now - task.createdAt;
      progress = Math.min(100, Math.max(12, Math.round((elapsed / task.duration) * 100)));
      status = elapsed >= task.duration ? "success" : "processing";
    }

    const statusText = {
      processing: "处理中",
      success: "已完成",
      failed: "处理失败",
      expired: "已过期",
    }[status] || "处理中";

    const savedSize = task.beforeSize && task.afterSize
      ? Math.max(task.beforeSize - task.afterSize, 0)
      : 0;

    const formatMegabytes = (mb) => {
      if (!mb) return "0 MB";
      return mb < 1 ? `${Math.round(mb * 1024)} KB` : `${mb.toFixed(1)} MB`;
    };

    const formatRelativeTime = (timestamp) => {
      const diff = now - timestamp;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      
      if (minutes < 1) return "刚刚";
      if (minutes < 60) return `${minutes} 分钟前`;
      if (hours < 24) return `${hours} 小时前`;
      return `${days} 天前`;
    };

    const tool = getToolById(task.toolId);

    return {
      id: task.id,
      toolId: task.toolId,
      tool: tool ? { name: tool.name, accent: tool.accent } : { name: "工具", accent: "" },
      status,
      statusText,
      progress,
      resultHeadline: task.resultHeadline,
      finalDetail: task.resultDetail,
      createdLabel: formatRelativeTime(task.createdAt),
      createdAt: task.createdAt,
      beforeSizeText: formatMegabytes(task.beforeSize),
      afterSizeText: formatMegabytes(task.afterSize),
      savedSizeText: formatMegabytes(savedSize),
    };
  }).sort((left, right) => right.createdAt - left.createdAt);
}

Page({
  data: {
    filter: "all",
    tasks: [],
    visibleTasks: [],
    dashboard: {},
    refreshTimer: null,
  },

  onShow() {
    if (!ensureWechatLogin()) {
      return;
    }

    this.refreshPage();
    this.startTimer();
    
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1
      });
    }
  },

  onHide() {
    this.clearTimer();
  },

  onUnload() {
    this.clearTimer();
  },

  startTimer() {
    this.clearTimer();
    // 延长刷新间隔，只在有处理中的任务时才刷新
    this.timer = setInterval(() => {
      const tasks = getTaskListForDisplay();
      const hasProcessingTasks = tasks.some(t => t.status === 'processing');
      
      if (hasProcessingTasks) {
        this.setData({
          tasks,
          dashboard: getTaskDashboard(),
          visibleTasks: this.filterTasks(tasks, this.data.filter),
        });
      }
    }, 3000); // 从1.2秒延长到3秒
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  refreshPage() {
    const tasks = getTaskListForDisplay();
    this.setData({
      tasks,
      dashboard: getTaskDashboard(),
      visibleTasks: this.filterTasks(tasks, this.data.filter),
    });
  },

  filterTasks(tasks, filter) {
    if (filter === "all") {
      return tasks;
    }
    return tasks.filter((item) => item.status === filter);
  },

  handleFilterTap(event) {
    const { filter } = event.currentTarget.dataset;
    this.setData({
      filter,
      visibleTasks: this.filterTasks(this.data.tasks, filter),
    });
  },

  handleTaskTap(event) {
    const { id } = event.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/task-detail/index?id=${id}`,
    });
  },

  goHome() {
    wx.switchTab({
      url: "/pages/home/index",
    });
  },
});
