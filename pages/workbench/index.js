Page({
  onLoad(options) {
    const query = [];

    if (options.id) {
      query.push(`id=${encodeURIComponent(options.id)}`);
    }

    if (options.selections) {
      query.push(`selections=${options.selections}`);
    }

    const suffix = query.length ? `?${query.join("&")}` : "";

    wx.redirectTo({
      url: `/pages/tool-detail/index${suffix}`,
    });
  },
});
