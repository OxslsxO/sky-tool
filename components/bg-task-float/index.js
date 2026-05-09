Component({
  methods: {
    handleTapItem(e) {
      const { completed, storeTaskId } = e.currentTarget.dataset;
      if (!completed) return;
      if (!storeTaskId) return;
      wx.navigateTo({
        url: `/pages/task-detail/index?id=${storeTaskId}`,
      });
    },
  },

  lifetimes: {
    attached() {
      const bgTasks = require("../../services/background-tasks");
      this._onTasksChange = (taskList) => {
        this.setData({
          tasks: taskList,
          visible: taskList.length > 0,
        });
      };
      bgTasks.addListener(this._onTasksChange);
      this._onTasksChange(bgTasks.getTasks());
    },

    detached() {
      const bgTasks = require("../../services/background-tasks");
      if (this._onTasksChange) {
        bgTasks.removeListener(this._onTasksChange);
      }
    },
  },
});
