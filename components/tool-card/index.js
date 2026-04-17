Component({
  properties: {
    tool: {
      type: Object,
      value: {},
    },
    compact: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    cardClass: "",
    taglineText: "",
  },

  observers: {
    "tool, compact": function (tool, compact) {
      const safeTool = tool || {};
      this.setData({
        cardClass: compact ? "tool-card tool-card--compact" : "tool-card",
        taglineText: compact ? safeTool.shortDescription : safeTool.tagline,
      });
    },
  },

  methods: {
    handleTap() {
      this.triggerEvent("select", {
        id: this.properties.tool.id,
      });
    },
  },
});
