Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: "/pages/home/index",
        text: "首页",
        icon: "/custom-tab-bar/icons/home.svg",
        activeIcon: "/custom-tab-bar/icons/home-active.svg"
      },
      {
        pagePath: "/pages/tasks/index",
        text: "历史",
        icon: "/custom-tab-bar/icons/tasks.svg",
        activeIcon: "/custom-tab-bar/icons/tasks-active.svg"
      },
      {
        pagePath: "/pages/mine/index",
        text: "我的",
        icon: "/custom-tab-bar/icons/mine.svg",
        activeIcon: "/custom-tab-bar/icons/mine-active.svg"
      }
    ]
  },

  attached() {
    const pages = getCurrentPages();
    const currentPage = pages[pages.length - 1];
    const route = currentPage ? currentPage.route : '';

    const list = this.data.list;
    for (let i = 0; i < list.length; i++) {
      if (list[i].pagePath === `/${route}`) {
        this.setData({
          selected: i
        });
        break;
      }
    }
  },

  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset;
      const url = data.path;

      wx.switchTab({
        url: url
      });

      this.setData({
        selected: data.index
      });
    }
  }
});
