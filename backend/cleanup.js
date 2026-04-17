require("dotenv").config();

const { ensureLocalDirs, buildConfig } = require("./lib/config");
const { createStorage } = require("./lib/storage");

ensureLocalDirs();

const config = buildConfig();
const storage = createStorage(config);
const deletedCount = storage.cleanupExpiredLocalOutputs();
const storageHealth = storage.getHealth();

console.log(
  `cleanup finished, removed ${deletedCount} expired local files (storage=${storageHealth.provider})`
);
