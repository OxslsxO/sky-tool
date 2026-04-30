const { tools, featuredBundles, categories, getToolsByIds } = require("../../data/mock");
const { getRecentTools, getTaskDashboard, getUserState, getRawTasks } = require("../../utils/task-store");
const { fetchToolUsageStats } = require("../../services/tool-usage");
const { ensureWechatLogin } = require("../../utils/page-auth");

const TOOL_ICONS = {
  "photo-id": "/icons/photo-id.svg",
  "universal-compress": "/icons/universal-compress.svg",
  "image-compress": "/icons/image-compress.svg",
  "image-convert": "/icons/image-convert.svg",
  "resize-crop": "/icons/resize-crop.svg",
  "image-to-pdf": "/icons/image-to-pdf.svg",
  "pdf-merge": "/icons/pdf-merge.svg",
  "pdf-split": "/icons/pdf-split.svg",
  "office-to-pdf": "/icons/office-to-pdf.svg",
  "pdf-to-word": "/icons/pdf-to-word.svg",
  "ocr-text": "/icons/ocr-text.svg",
  "qr-maker": "/icons/qr-maker.svg",
  "unit-convert": "/icons/unit-convert.svg",
  "audio-convert": "/icons/audio-convert.svg",
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
  },

  onLoad() {
    this.setData({
      displayTools: this.filterTools(""),
    });
  },

  onShow() {
    if (!ensureWechatLogin()) {
      return;
    }

    this.refreshPage();
    this.refreshToolUsageStats();
    this.updateGreeting();
    
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 0
      });
    }
  },

  refreshPage() {
    const bundles = featuredBundles.map((bundle) => ({
      ...bundle,
      toolNames: getToolsByIds(bundle.toolIds).map((tool) => tool.name).join(" / "),
      toolIcons: bundle.toolIds.map((id) => TOOL_ICONS[id] || "🛠"),
      toolCount: bundle.toolIds.length,
    }));

    const user = getUserState();

    this.setData({
      displayTools: this.filterTools(this.data.keyword),
      recentTools: getRecentTools().slice(0, 6).map((tool) => this.enhanceTool(tool)),
      bundles,
      dashboard: getTaskDashboard(),
      user,
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
      icon: TOOL_ICONS[tool.id] || "/icons/universal-compress.svg",
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
