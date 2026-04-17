const fs = require("fs");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

function createClientStateRepository(config) {
  let client = null;
  let collectionPromise = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function makeUserId() {
    return `usr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  function normalizeStringArray(values, limit) {
    return Array.from(new Set((values || []).filter(Boolean))).slice(0, limit);
  }

  function normalizeTasks(tasks) {
    const taskMap = new Map();

    (tasks || []).forEach((task) => {
      if (!task || !task.id) {
        return;
      }

      const previous = taskMap.get(task.id);
      const previousUpdatedAt = Number(previous && previous.updatedAt ? previous.updatedAt : 0);
      const nextUpdatedAt = Number(task.updatedAt || task.createdAt || 0);

      if (!previous || nextUpdatedAt >= previousUpdatedAt) {
        taskMap.set(task.id, {
          ...task,
          createdAt: task.createdAt || Date.now(),
          updatedAt: nextUpdatedAt || Date.now(),
        });
      }
    });

    return Array.from(taskMap.values())
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      .slice(0, 100);
  }

  function normalizeUser(existingUser, incomingUser, options = {}) {
    const preferRemote = !!options.preferRemote;
    const baseUser = preferRemote
      ? { ...(incomingUser || {}), ...(existingUser || {}) }
      : { ...(existingUser || {}), ...(incomingUser || {}) };
    const createdAt = (existingUser && existingUser.createdAt) || baseUser.createdAt || nowIso();

    return {
      nickname: baseUser.nickname || "Toolbox User",
      points: Number.isFinite(Number(baseUser.points)) ? Number(baseUser.points) : 0,
      freeQuota: Number.isFinite(Number(baseUser.freeQuota)) ? Number(baseUser.freeQuota) : 0,
      memberPlan: String(baseUser.memberPlan || ""),
      memberExpire: String(baseUser.memberExpire || ""),
      memberActive: Boolean(baseUser.memberActive),
      userId: String(baseUser.userId || existingUser && existingUser.userId || makeUserId()),
      deviceId: String(baseUser.deviceId || existingUser && existingUser.deviceId || ""),
      authMode: String(baseUser.authMode || existingUser && existingUser.authMode || "guest"),
      avatarUrl: String(baseUser.avatarUrl || existingUser && existingUser.avatarUrl || ""),
      lastSyncedAt: String(baseUser.lastSyncedAt || existingUser && existingUser.lastSyncedAt || ""),
      syncStatus: String(baseUser.syncStatus || "cloud"),
      createdAt,
      updatedAt: nowIso(),
    };
  }

  async function getCollection() {
    if (!config.mongodb.uri) {
      return null;
    }

    if (!collectionPromise) {
      collectionPromise = (async () => {
        client = new MongoClient(config.mongodb.uri);
        await client.connect();
        const db = client.db(config.mongodb.dbName);
        const collection = db.collection(config.mongodb.clientStateCollectionName);
        await collection.createIndex({ userId: 1 }, { unique: true });
        await collection.createIndex({ "identifiers.deviceId": 1 });
        await collection.createIndex({ updatedAt: -1 });
        return collection;
      })();
    }

    return collectionPromise;
  }

  function readLocalFile() {
    if (!fs.existsSync(config.clientStatePath)) {
      return {
        records: [],
      };
    }

    try {
      return JSON.parse(fs.readFileSync(config.clientStatePath, "utf8"));
    } catch (error) {
      return {
        records: [],
      };
    }
  }

  function writeLocalFile(state) {
    fs.writeFileSync(config.clientStatePath, JSON.stringify(state, null, 2), "utf8");
  }

  function findLocalRecord(records, identity) {
    return (records || []).find((record) => {
      if (identity.userId && record.userId === identity.userId) {
        return true;
      }

      if (
        identity.deviceId &&
        record.identifiers &&
        record.identifiers.deviceId === identity.deviceId
      ) {
        return true;
      }

      return false;
    });
  }

  async function findRecord(identity) {
    const collection = await getCollection();
    const query = [];

    if (identity.userId) {
      query.push({ userId: identity.userId });
    }

    if (identity.deviceId) {
      query.push({ "identifiers.deviceId": identity.deviceId });
    }

    if (collection) {
      if (!query.length) {
        return null;
      }

      return collection.findOne(query.length === 1 ? query[0] : { $or: query });
    }

    const state = readLocalFile();
    return findLocalRecord(state.records, identity) || null;
  }

  function buildStateRecord(payload, existingRecord) {
    const preferRemote = !!payload.preferRemote;
    const existing = existingRecord || {};
    const incomingUser = {
      ...(payload.user || {}),
      userId: payload.userId || payload.user && payload.user.userId || "",
      deviceId: payload.deviceId || payload.user && payload.user.deviceId || "",
      authMode: payload.authMode || payload.user && payload.user.authMode || "guest",
    };
    const user = normalizeUser(existing.user, incomingUser, { preferRemote });
    const now = nowIso();

    return {
      userId: user.userId,
      identifiers: {
        deviceId: payload.deviceId || user.deviceId || existing.identifiers && existing.identifiers.deviceId || "",
      },
      authMode: user.authMode,
      user,
      tasks: normalizeTasks([].concat(existing.tasks || [], payload.tasks || [])),
      favorites: payload.preferRemote && (existing.favorites || []).length
        ? normalizeStringArray(existing.favorites, 12)
        : normalizeStringArray(
            Array.isArray(payload.favorites) ? payload.favorites : existing.favorites,
            12
          ),
      recentToolIds: payload.preferRemote && (existing.recentToolIds || []).length
        ? normalizeStringArray(existing.recentToolIds, 8)
        : normalizeStringArray(
            Array.isArray(payload.recentToolIds) ? payload.recentToolIds : existing.recentToolIds,
            8
          ),
      createdAt: existing.createdAt || now,
      updatedAt: now,
      lastSeenAt: now,
    };
  }

  function toClientState(record) {
    if (!record) {
      return null;
    }

    return {
      user: {
        ...(record.user || {}),
        userId: record.userId,
        deviceId:
          record.identifiers && record.identifiers.deviceId
            ? record.identifiers.deviceId
            : record.user && record.user.deviceId
              ? record.user.deviceId
              : "",
      },
      tasks: normalizeTasks(record.tasks || []),
      favorites: normalizeStringArray(record.favorites, 12),
      recentToolIds: normalizeStringArray(record.recentToolIds, 8),
      syncedAt: record.updatedAt || nowIso(),
    };
  }

  async function upsertRecord(nextRecord) {
    const collection = await getCollection();

    if (collection) {
      await collection.updateOne(
        { userId: nextRecord.userId },
        {
          $set: nextRecord,
        },
        { upsert: true }
      );
      return nextRecord;
    }

    const state = readLocalFile();
    const nextRecords = (state.records || []).filter((item) => item.userId !== nextRecord.userId);
    nextRecords.push(nextRecord);
    writeLocalFile({
      records: nextRecords,
    });
    return nextRecord;
  }

  async function getState(identity) {
    const record = await findRecord(identity);
    return toClientState(record);
  }

  async function syncState(payload) {
    const existingRecord = await findRecord({
      userId: payload.userId || payload.user && payload.user.userId || "",
      deviceId: payload.deviceId || payload.user && payload.user.deviceId || "",
    });
    const nextRecord = buildStateRecord(payload, existingRecord);
    await upsertRecord(nextRecord);
    return toClientState(nextRecord);
  }

  function getHealth() {
    return {
      provider: config.mongodb.uri ? "mongodb" : "local-file",
      path: config.mongodb.uri ? "" : config.clientStatePath,
      collectionName: config.mongodb.clientStateCollectionName,
    };
  }

  async function close() {
    if (client) {
      await client.close();
      client = null;
      collectionPromise = null;
    }
  }

  return {
    getState,
    syncState,
    getHealth,
    close,
  };
}

module.exports = {
  createClientStateRepository,
};
