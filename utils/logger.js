// 简单的logger工具
const logger = {
  log: function(message, data) {
    if (data) {
      console.log(`[LOG] ${message}`, data);
    } else {
      console.log(`[LOG] ${message}`);
    }
  },
  error: function(message, data) {
    if (data) {
      console.error(`[ERROR] ${message}`, data);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  },
  info: function(message, data) {
    if (data) {
      console.info(`[INFO] ${message}`, data);
    } else {
      console.info(`[INFO] ${message}`);
    }
  },
  warn: function(message, data) {
    if (data) {
      console.warn(`[WARN] ${message}`, data);
    } else {
      console.warn(`[WARN] ${message}`);
    }
  }
};

module.exports = logger;