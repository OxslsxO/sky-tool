Component({
  data: {
    selected: 0,
    color: "#7d7a70",
    selectedColor: "#1d5c4b",
    list: [
      {
        pagePath: "/pages/home/index",
        text: "首页",
        icon: "🏠"
      },
      {
        pagePath: "/pages/tasks/index",
        text: "任务",
        icon: "📋"
      },
      {
        pagePath: "/pages/vip/index",
        text: "会员",
        icon: "👑"
      },
      {
        pagePath: "/pages/mine/index",
        text: "我的",
        icon: "👤"
      }
    ]
  },

  attached() {
    // 获取当前页面路径
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
