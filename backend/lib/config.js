const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const DEFAULT_STORAGE_ROOT_DIR = path.join(os.homedir(), ".sky-toolbox-runtime");
const STORAGE_DIR = path.resolve(process.env.STORAGE_ROOT_DIR || DEFAULT_STORAGE_ROOT_DIR);
const OUTPUT_DIR = path.join(STORAGE_DIR, "outputs");
const TEMP_DIR = path.join(STORAGE_DIR, "temp");
const OPERATIONS_LOG_PATH = path.join(STORAGE_DIR, "operations.ndjson");
const CLIENT_STATE_PATH = path.join(STORAGE_DIR, "client-state.json");
const HUGGING_FACE_SPACE_PORT = 7860;

function ensureLocalDirs() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function isHuggingFaceSpaceRuntime() {
  return Boolean(process.env.SPACE_ID || process.env.SPACE_HOST);
}

function getRuntimePort() {
  if (isHuggingFaceSpaceRuntime()) {
    return HUGGING_FACE_SPACE_PORT;
  }

  return Number(process.env.PORT || 3100);
}

function getRuntimeHost() {
  if (isHuggingFaceSpaceRuntime()) {
    return "0.0.0.0";
  }

  return process.env.HOST || "0.0.0.0";
}

function buildConfig() {
  return {
    port: getRuntimePort(),
    host: getRuntimeHost(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
    apiToken: process.env.API_TOKEN || "",
    fileTtlHours: Number(process.env.FILE_TTL_HOURS || 24),
    outputDir: OUTPUT_DIR,
    tempDir: TEMP_DIR,
    operationsLogPath: OPERATIONS_LOG_PATH,
    clientStatePath: CLIENT_STATE_PATH,
    mongodb: {
      uri: process.env.MONGODB_URI || "",
      dbName: process.env.MONGODB_DB_NAME || "sky_toolbox",
      collectionName: process.env.MONGODB_COLLECTION_NAME || "operation_logs",
      clientStateCollectionName:
        process.env.MONGODB_CLIENT_STATE_COLLECTION_NAME || "client_states",
      usersCollectionName: process.env.MONGODB_USERS_COLLECTION_NAME || "users",
      clientDevicesCollectionName:
        process.env.MONGODB_CLIENT_DEVICES_COLLECTION_NAME || "client_devices",
      userPreferencesCollectionName:
        process.env.MONGODB_USER_PREFERENCES_COLLECTION_NAME || "user_preferences",
      tasksCollectionName: process.env.MONGODB_TASKS_COLLECTION_NAME || "tasks",
      pointsRecordsCollectionName:
        process.env.MONGODB_POINTS_RECORDS_COLLECTION_NAME || "points_records",
      ordersCollectionName: process.env.MONGODB_ORDERS_COLLECTION_NAME || "orders",
    },
    qiniu: {
      accessKey: process.env.QINIU_ACCESS_KEY || "",
      secretKey: process.env.QINIU_SECRET_KEY || "",
      bucket: process.env.QINIU_BUCKET || "",
      region: process.env.QINIU_REGION || "",
      prefix: (process.env.QINIU_PREFIX || "sky-toolbox").replace(/^\/+|\/+$/g, ""),
      publicBaseUrl: (process.env.QINIU_PUBLIC_BASE_URL || "").replace(/\/$/, ""),
      privateBucket: ["1", "true", "yes", "on"].includes(
        String(process.env.QINIU_PRIVATE_BUCKET || "").toLowerCase()
      ),
      downloadExpiresSeconds: Number(process.env.QINIU_DOWNLOAD_EXPIRES_SECONDS || 3600),
    },
  };
}

module.exports = {
  ROOT_DIR,
  DEFAULT_STORAGE_ROOT_DIR,
  STORAGE_DIR,
  OUTPUT_DIR,
  TEMP_DIR,
  OPERATIONS_LOG_PATH,
  CLIENT_STATE_PATH,
  ensureLocalDirs,
  buildConfig,
};
