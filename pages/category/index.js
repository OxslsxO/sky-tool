const { categories, getCategoryById, getToolsByCategory } = require("../../data/mock");

Page({
  data: {
    categories,
    activeCategoryId: categories[0].id,
    activeCategory: categories[0],
    categoryTools: [],
  },

  onLoad() {
    this.updateCategory(categories[0].id);
  },

  onShow() {
    this.setData({
      categoryTools: getToolsByCategory(this.data.activeCategoryId),
    });
  },

  handleCategoryTap(event) {
    const { id } = event.currentTarget.dataset;
    this.updateCategory(id);
  },

  updateCategory(categoryId) {
    this.setData({
      activeCategoryId: categoryId,
      activeCategory: getCategoryById(categoryId),
      categoryTools: getToolsByCategory(categoryId),
    });
  },

  handleToolSelect(event) {
    const { id } = event.detail;
    wx.navigateTo({
      url: `/pages/tool-detail/index?id=${id}`,
    });
  },
});
