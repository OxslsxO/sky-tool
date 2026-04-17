const { tools, featuredBundles, categories, getToolsByIds } = require("../../data/mock");
const { getRecentTools, getTaskDashboard, getUserState } = require("../../utils/task-store");

const TOOL_ICONS = {
  "photo-id": "📷",
  "image-compress": "🗜️",
  "image-convert": "🔄",
  "resize-crop": "📐",
  "image-to-pdf": "📄",
  "pdf-compress": "📉",
  "pdf-merge": "➕",
  "pdf-split": "✂️",
  "office-to-pdf": "📋",
  "ocr-text": "🔍",
  "qr-maker": "🔲",
  "unit-convert": "📏",
  "audio-convert": "🎵",
};

const HOT_SEARCHES = ["证件照", "PDF压缩", "OCR", "二维码", "图片转PDF", "音频转换"];

Page({
  data: {
    keyword: "",
    greeting: "",
    hotSearches: HOT_SEARCHES,
    displayTools: [],
    recentTools: [],
    bundles: [],
    categories: categories,
    dashboard: {},
    user: {},
    viewMode: "grid",
    selectedCategory: "all",
    memberExpireText: "",
  },

  onLoad() {
    console.log("[首页] onLoad, 刷新所有数据");
    this.setData({
      displayTools: this.filterTools(""),
    });
  },

  onShow() {
    this.refreshPage();
    this.updateGreeting();
  },

  refreshPage() {
    const bundles = featuredBundles.map((bundle) => ({
      ...bundle,
      toolNames: getToolsByIds(bundle.toolIds).map((tool) => tool.name).join(" / "),
      toolIcons: bundle.toolIds.map((id) => TOOL_ICONS[id] || "🔧"),
      toolCount: bundle.toolIds.length,
    }));

    const user = getUserState();
    const memberExpireText = this.formatExpireDate(user.memberExpire);

    this.setData({
      displayTools: this.filterTools(this.data.keyword),
      recentTools: getRecentTools().slice(0, 6).map((tool) => this.enhanceTool(tool)),
      bundles,
      dashboard: getTaskDashboard(),
      user,
      memberExpireText,
    });
  },

  enhanceTool(tool) {
    return {
      ...tool,
      icon: TOOL_ICONS[tool.id] || "🔧",
    };
  },

  filterTools(keyword) {
    let filtered = [...tools];

    console.log("[首页筛选] 开始筛选, selectedCategory:", this.data.selectedCategory);
    console.log("[首页筛选] 原始工具数量:", filtered.length);

    if (this.data.selectedCategory !== "all") {
      filtered = filtered.filter((tool) => tool.categoryId === this.data.selectedCategory);
      console.log("[首页筛选] 按分类筛选后工具数量:", filtered.length);
      console.log("[首页筛选] 筛选后工具:", filtered.map(t => ({id: t.id, name: t.name, categoryId: t.categoryId})));
    }

    if (keyword) {
      const lowerKeyword = keyword.toLowerCase();
      filtered = filtered.filter((tool) => {
        const text = `${tool.name}${tool.shortDescription}${tool.tagline}${tool.formatText}`.toLowerCase();
        return text.indexOf(lowerKeyword) > -1;
      });
    }

    return filtered.map((tool) => this.enhanceTool(tool));
  },

  updateGreeting() {
    const hour = new Date().getHours();
    let greeting = "你好";
    if (hour < 6) greeting = "夜深了";
    else if (hour < 9) greeting = "早上好";
    else if (hour < 12) greeting = "上午好";
    else if (hour < 14) greeting = "中午好";
    else if (hour < 18) greeting = "下午好";
    else greeting = "晚上好";

    this.setData({ greeting });
  },

  formatExpireDate(dateStr) {
    if (!dateStr) return "未开通";
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil((date - now) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return "已过期";
    if (diffDays === 0) return "今天";
    if (diffDays <= 7) return `${diffDays}天后`;
    return `${date.getMonth() + 1}/${date.getDate()}`;
  },

  handleSearchInput(event) {
    const keyword = event.detail.value.trim();
    this.setData({
      keyword,
      displayTools: this.filterTools(keyword),
    });
  },

  clearKeyword() {
    this.setData({
      keyword: "",
      displayTools: this.filterTools(""),
    });
  },

  applyHotSearch(event) {
    const keyword = event.currentTarget.dataset.keyword;
    this.setData({
      keyword,
      displayTools: this.filterTools(keyword),
    });
  },

  switchViewMode(event) {
    const mode = event.currentTarget.dataset.mode;
    this.setData({ viewMode: mode });
  },

  selectCategory(event) {
    const category = event.currentTarget.dataset.category;
    console.log("[首页分类] 选中分类:", category);
    this.setData({
      selectedCategory: category,
    }, () => {
      console.log("[首页分类] 数据更新完成，重新筛选工具");
      this.setData({
        displayTools: this.filterTools(this.data.keyword),
      });
    });
  },

  handleToolSelect(event) {
    const { id } = event.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/tool-detail/index?id=${id}`,
    });
  },

  goBundleDetail(event) {
    wx.showToast({
      title: "套装功能开发中",
      icon: "none",
    });
  },

  goTasks() {
    wx.switchTab({
      url: "/pages/tasks/index",
    });
  },

  goVip() {
    wx.switchTab({
      url: "/pages/vip/index",
    });
  },

  goProfile() {
    wx.switchTab({
      url: "/pages/mine/index",
    });
  },

  clearRecent() {
    wx.showModal({
      title: "清空记录",
      content: "确定要清空最近使用记录吗？",
      success: (res) => {
        if (res.confirm) {
          wx.setStorageSync("sky_tools_recent", []);
          this.setData({ recentTools: [] });
          wx.showToast({ title: "已清空", icon: "success" });
        }
      },
    });
  },
});
