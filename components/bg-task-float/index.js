const bgTasks = require("../../services/background-tasks");

Component({
  data: {
    tasks: [],
    visible: false,
  },

  lifetimes: {
    attached() {
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
      if (this._onTasksChange) {
        bgTasks.removeListener(this._onTasksChange);
      }
    },
  },

  methods: {
    handleTapItem(e) {
      const { id } = e.currentTarget.dataset;
      const task = bgTasks.getTasks().find((t) => t.id === id);
      if (!task) return;

      if (task.toolId) {
        wx.navigateTo({
          url: `/pages/tool-detail/index?id=${task.toolId}`,
        });
      }
    },
  },
});
