const { listTasks, getTaskDashboard } = require("../../utils/task-store");

Page({
  data: {
    filter: "all",
    tasks: [],
    visibleTasks: [],
    dashboard: {},
    refreshTimer: null,
  },

  onShow() {
    this.refreshPage();
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
      this.refreshPage();
    }, 1200);
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  refreshPage() {
    const tasks = listTasks();
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
