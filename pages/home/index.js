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
    toolUsageTotalStr: "0",
    toolUsageProvider: "",
    viewMode: "grid",
    selectedCategory: "all",
    isLoaded: false,
  },

  onLoad() {
    // 快速初始化，只设置必要数据
    this.setData({
      isLoaded: false,
    });
    
    // 延迟加载完整内容
    setTimeout(() => {
      this.setData({
        displayTools: this.filterTools(""),
        isLoaded: true,
      });
    }, 100);
  },

  onShow() {
    if (!ensureWechatLogin()) {
      return;
    }

    this.updateGreeting();
    
    // 延迟刷新页面数据，避免阻塞
    setTimeout(() => {
      this.refreshPage();
    }, 150);
    
    // 恢复工具使用统计
    setTimeout(() => {
      this.refreshToolUsageStats();
    }, 1200);
    
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
    const recentTools = getRecentTools().slice(0, 6).map((tool) => this.enhanceTool(tool));

    // 分批更新数据，避免一次性更新过大导致阻塞
    this.setData({
      user,
      dashboard: getTaskDashboard(),
      recentTools,
      bundles,
    });
    
    // 延迟更新工具列表
    setTimeout(() => {
      this.setData({
        displayTools: this.filterTools(this.data.keyword),
      });
    }, 50);
  },

  enhanceTool(tool) {
    const globalUsageCount = this.data.toolUsageStats[tool.id] || 0;
    const personalUsageCount = this.getPersonalToolUsageCount(tool.id);
    const usageCount = globalUsageCount || personalUsageCount;

    let usageText = "";
    if (globalUsageCount > 0) {
      usageText = `全站 ${this.formatUsageCount(globalUsageCount)} 次`;
    } else if (personalUsageCount > 0) {
      usageText = `全站使用 ${this.formatUsageCount(personalUsageCount)} 次`;
    }

    return {
      id: tool.id,
      name: tool.name,
      shortDescription: tool.shortDescription,
      categoryId: tool.categoryId,
      categoryIds: tool.categoryIds,
      badge: tool.badge,
      accent: tool.accent,
      cardBackground: tool.cardBackground,
      formatText: tool.formatText,
      points: tool.points,
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

      const total = Number(response.totalUsageCount) || stats.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
      let totalStr = String(total);
      if (total >= 10000) {
        totalStr = (total / 10000).toFixed(total >= 100000 ? 0 : 1) + '万';
      }

      this.setData({
        toolUsageStats,
        toolUsageTotal: total,
        toolUsageTotalStr: totalStr,
        toolUsageProvider: response.provider || "",
        displayTools: this.filterTools(this.data.keyword),
      });
    } catch (error) {
      console.warn("[home] failed to fetch tool usage stats", error);
      // 静默失败，不影响页面显示
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

  handlePressStart(event) {
    const { index } = event.currentTarget.dataset;

    const displayTools = this.data.displayTools.map((tool, i) => {
      if (i === index) {
        return { ...tool, isPressed: true };
      }
      return tool;
    });
    this.setData({ displayTools });
  },

  handlePressEnd(event) {
    const { index } = event.currentTarget.dataset;

    const displayTools = this.data.displayTools.map((tool, i) => {
      if (i === index) {
        const updates = { isPressed: false };
        if (tool.isHot) {
          updates.showRipple = true;
        }
        return { ...tool, ...updates };
      }
      return tool;
    });
    this.setData({ displayTools });

    setTimeout(() => {
      const resetTools = this.data.displayTools.map((tool, i) => {
        if (i === index && tool.showRipple) {
          const { showRipple, ...rest } = tool;
          return rest;
        }
        return tool;
      });
      this.setData({ displayTools: resetTools });
    }, 600);
  },

  // 预防措施：避免某些情况下的错误提示
  onChooseAvatar() {
    console.warn('首页不应该触发 onChooseAvatar 事件');
  },
});
