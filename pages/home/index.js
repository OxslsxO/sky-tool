const { tools, featuredBundles, categories, getToolsByIds } = require("../../data/mock");
const { getRecentTools, getTaskDashboard, getUserState, getRawTasks } = require("../../utils/task-store");
const { fetchToolUsageStats } = require("../../services/tool-usage");

const TOOL_ICONS = {
  "photo-id": "📷",
  "universal-compress": "🗜️",
  "image-convert": "🔁",
  "resize-crop": "📐",
  "image-to-pdf": "📄",
  "pdf-merge": "➕",
  "pdf-split": "✂️",
  "office-to-pdf": "📑",
  "ocr-text": "🔎",
  "qr-maker": "▦",
  "unit-convert": "📏",
  "audio-convert": "🎵",
};

const HOT_SEARCHES = ["证件照", "PDF压缩", "OCR", "二维码", "图片转PDF", "音视频转换"];

const TOOL_ORDER = tools.reduce((map, tool, index) => {
  map[tool.id] = index;
  return map;
}, {});

Page({
  data: {
    keyword: "",
    greeting: "",
    hotSearches: HOT_SEARCHES,
    displayTools: [],
    recentTools: [],
    bundles: [],
    categories,
    dashboard: {},
    user: {},
    toolUsageStats: {},
    toolUsageTotal: 0,
    toolUsageProvider: "",
    viewMode: "grid",
    selectedCategory: "all",
    memberExpireText: "",
  },

  onLoad() {
    this.setData({
      displayTools: this.filterTools(""),
    });
  },

  onShow() {
    this.refreshPage();
    this.refreshToolUsageStats();
    this.updateGreeting();
  },

  refreshPage() {
    const bundles = featuredBundles.map((bundle) => ({
      ...bundle,
      toolNames: getToolsByIds(bundle.toolIds).map((tool) => tool.name).join(" / "),
      toolIcons: bundle.toolIds.map((id) => TOOL_ICONS[id] || "🛠"),
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
    const globalUsageCount = this.data.toolUsageStats[tool.id] || 0;
    const personalUsageCount = this.getPersonalToolUsageCount(tool.id);
    const usageCount = globalUsageCount || personalUsageCount;

    let usageText = "";
    if (globalUsageCount > 0) {
      usageText = `全站 ${this.formatUsageCount(globalUsageCount)} 次`;
    } else if (personalUsageCount > 0) {
      usageText = `已使用 ${this.formatUsageCount(personalUsageCount)} 次`;
    }

    return {
      ...tool,
      usageCount,
      usageText,
      icon: TOOL_ICONS[tool.id] || "🛠",
    };
  },

  getPersonalToolUsageCount(toolId) {
    const tasks = getRawTasks();
    return tasks.filter((task) => task.toolId === toolId && task.status === "success").length;
  },

  formatUsageCount(count) {
    const value = Number(count) || 0;
    if (value >= 10000) {
      return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`;
    }
    return String(value);
  },

  filterTools(keyword) {
    let filtered = [...tools];

    if (this.data.selectedCategory !== "all") {
      filtered = filtered.filter((tool) => tool.categoryId === this.data.selectedCategory);
    }

    if (keyword) {
      const lowerKeyword = keyword.toLowerCase();
      filtered = filtered.filter((tool) => {
        const text = `${tool.name}${tool.shortDescription}${tool.tagline}${tool.formatText}`.toLowerCase();
        return text.indexOf(lowerKeyword) > -1;
      });
    }

    filtered.sort((left, right) => {
      const leftGlobal = this.data.toolUsageStats[left.id] || 0;
      const rightGlobal = this.data.toolUsageStats[right.id] || 0;
      const leftPersonal = this.getPersonalToolUsageCount(left.id);
      const rightPersonal = this.getPersonalToolUsageCount(right.id);
      const leftCount = leftGlobal || leftPersonal;
      const rightCount = rightGlobal || rightPersonal;

      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }

      return (TOOL_ORDER[left.id] || 0) - (TOOL_ORDER[right.id] || 0);
    });

    return filtered.map((tool) => this.enhanceTool(tool));
  },

  async refreshToolUsageStats() {
    try {
      const response = await fetchToolUsageStats();
      const stats = Array.isArray(response.stats) ? response.stats : [];
      const toolUsageStats = stats.reduce((map, item) => {
        if (item && item.toolId) {
          map[item.toolId] = Number(item.count) || 0;
        }
        return map;
      }, {});

      this.setData({
        toolUsageStats,
        toolUsageTotal: Number(response.totalUsageCount) || stats.reduce((sum, item) => sum + (Number(item.count) || 0), 0),
        toolUsageProvider: response.provider || "",
        displayTools: this.filterTools(this.data.keyword),
      });
    } catch (error) {
      console.warn("[home] failed to fetch tool usage stats", error);
      this.setData({
        displayTools: this.filterTools(this.data.keyword),
      });
    }
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
    this.setData({
      selectedCategory: category,
    }, () => {
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

  goBundleDetail() {
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
