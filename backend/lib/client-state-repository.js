const fs = require("fs");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

function createClientStateRepository(config) {
  let client = null;
  let collectionsPromise = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function makeUserId() {
    return `usr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  }

  function getCollectionNames() {
    const mongodb = config.mongodb || {};
    return {
      snapshot: mongodb.clientStateCollectionName || "client_states",
      users: mongodb.usersCollectionName || "users",
      clientDevices: mongodb.clientDevicesCollectionName || "client_devices",
      preferences: mongodb.userPreferencesCollectionName || "user_preferences",
      tasks: mongodb.tasksCollectionName || "tasks",
      pointsRecords: mongodb.pointsRecordsCollectionName || "points_records",
      orders: mongodb.ordersCollectionName || "orders",
    };
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

  function normalizeRecords(records, limit) {
    const recordMap = new Map();

    (records || []).forEach((record) => {
      if (!record || !record.id) {
        return;
      }

      const previous = recordMap.get(record.id);
      const previousUpdatedAt = Number(
        previous && (previous.updatedAt || previous.createdAt)
          ? previous.updatedAt || previous.createdAt
          : 0
      );
      const nextUpdatedAt = Number(record.updatedAt || record.createdAt || 0);

      if (!previous || nextUpdatedAt >= previousUpdatedAt) {
        recordMap.set(record.id, {
          ...record,
          createdAt: record.createdAt || Date.now(),
          updatedAt: record.updatedAt || record.createdAt || Date.now(),
        });
      }
    });

    return Array.from(recordMap.values())
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
      .slice(0, limit);
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
      userId: String((baseUser.userId || existingUser && existingUser.userId || makeUserId())),
      deviceId: String(baseUser.deviceId || existingUser && existingUser.deviceId || ""),
      authMode: String(baseUser.authMode || existingUser && existingUser.authMode || "guest"),
      avatarUrl: String(baseUser.avatarUrl || existingUser && existingUser.avatarUrl || ""),
      lastSyncedAt: String(baseUser.lastSyncedAt || existingUser && existingUser.lastSyncedAt || ""),
      syncStatus: String(baseUser.syncStatus || "cloud"),
      createdAt,
      updatedAt: nowIso(),
    };
  }

  function stripMongoFields(document, extraKeys = []) {
    if (!document) {
      return null;
    }

    const next = { ...document };
    ["_id", ...extraKeys].forEach((key) => {
      delete next[key];
    });
    return next;
  }

  async function getCollections() {
    if (!config.mongodb.uri) {
      return null;
    }

    if (!collectionsPromise) {
      collectionsPromise = (async () => {
        client = new MongoClient(config.mongodb.uri);
        await client.connect();
        const db = client.db(config.mongodb.dbName);
        const names = getCollectionNames();
        const collections = {
          snapshots: db.collection(names.snapshot),
          users: db.collection(names.users),
          clientDevices: db.collection(names.clientDevices),
          preferences: db.collection(names.preferences),
          tasks: db.collection(names.tasks),
          pointsRecords: db.collection(names.pointsRecords),
          orders: db.collection(names.orders),
        };

        await Promise.all([
          collections.snapshots.createIndex({ userId: 1 }, { unique: true }),
          collections.snapshots.createIndex({ "identifiers.deviceId": 1 }),
          collections.snapshots.createIndex({ updatedAt: -1 }),
          collections.users.createIndex({ userId: 1 }, { unique: true }),
          collections.users.createIndex({ updatedAt: -1 }),
          collections.clientDevices.createIndex({ deviceId: 1 }, { unique: true, sparse: true }),
          collections.clientDevices.createIndex({ userId: 1 }),
          collections.clientDevices.createIndex({ lastSeenAt: -1 }),
          collections.preferences.createIndex({ userId: 1 }, { unique: true }),
          collections.tasks.createIndex({ userId: 1, id: 1 }, { unique: true }),
          collections.tasks.createIndex({ userId: 1, createdAt: -1 }),
          collections.tasks.createIndex({ userId: 1, toolId: 1, createdAt: -1 }),
          collections.pointsRecords.createIndex({ userId: 1, id: 1 }, { unique: true }),
          collections.pointsRecords.createIndex({ userId: 1, createdAt: -1 }),
          collections.orders.createIndex({ userId: 1, id: 1 }, { unique: true }),
          collections.orders.createIndex({ userId: 1, status: 1, createdAt: -1 }),
        ]);

        return collections;
      })();
    }

    return collectionsPromise;
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

  async function findSnapshot(collections, identity) {
    const query = [];

    if (identity.userId) {
      query.push({ userId: identity.userId });
    }

    if (identity.deviceId) {
      query.push({ "identifiers.deviceId": identity.deviceId });
    }

    if (!query.length) {
      return null;
    }

    return collections.snapshots.findOne(query.length === 1 ? query[0] : { $or: query });
  }

  async function findMongoRecord(collections, identity) {
    let user = null;
    let device = null;

    if (identity.userId) {
      user = await collections.users.findOne({ userId: identity.userId });
    }

    if (!user && identity.deviceId) {
      device = await collections.clientDevices.findOne({ deviceId: identity.deviceId });
      if (device && device.userId) {
        user = await collections.users.findOne({ userId: device.userId });
      }
    }

    if (!user) {
      const snapshot = await findSnapshot(collections, identity);
      return snapshot || null;
    }

    const userId = user.userId;
    if (!device && (identity.deviceId || user.deviceId)) {
      device = await collections.clientDevices.findOne({
        deviceId: identity.deviceId || user.deviceId,
      });
    }

    const [preferences, tasks, pointsRecords, orders] = await Promise.all([
      collections.preferences.findOne({ userId }),
      collections.tasks.find({ userId }).sort({ createdAt: -1 }).limit(100).toArray(),
      collections.pointsRecords.find({ userId }).sort({ createdAt: -1 }).limit(200).toArray(),
      collections.orders.find({ userId }).sort({ createdAt: -1 }).limit(100).toArray(),
    ]);

    return {
      userId,
      identifiers: {
        deviceId:
          (device && device.deviceId) ||
          user.deviceId ||
          identity.deviceId ||
          "",
      },
      authMode: user.authMode || "guest",
      user: stripMongoFields(user),
      tasks: tasks.map((item) => stripMongoFields(item, ["userId"])),
      pointsRecords: pointsRecords.map((item) => stripMongoFields(item, ["userId"])),
      orders: orders.map((item) => stripMongoFields(item, ["userId"])),
      favorites: preferences ? preferences.favoriteToolIds || [] : [],
      recentToolIds: preferences ? preferences.recentToolIds || [] : [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt || nowIso(),
      lastSeenAt: device && device.lastSeenAt ? device.lastSeenAt : user.updatedAt,
    };
  }

  async function findRecord(identity) {
    const collections = await getCollections();

    if (collections) {
      return findMongoRecord(collections, identity);
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
        deviceId:
          payload.deviceId ||
          user.deviceId ||
          existing.identifiers && existing.identifiers.deviceId ||
          "",
      },
      authMode: user.authMode,
      user,
      tasks: normalizeTasks([].concat(existing.tasks || [], payload.tasks || [])),
      pointsRecords: normalizeRecords(
        [].concat(existing.pointsRecords || [], payload.pointsRecords || []),
        200
      ),
      orders: normalizeRecords([].concat(existing.orders || [], payload.orders || []), 100),
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
      pointsRecords: normalizeRecords(record.pointsRecords || [], 200),
      orders: normalizeRecords(record.orders || [], 100),
      favorites: normalizeStringArray(record.favorites, 12),
      recentToolIds: normalizeStringArray(record.recentToolIds, 8),
      syncedAt: record.updatedAt || nowIso(),
    };
  }

  async function upsertSnapshot(collections, nextRecord) {
    await collections.snapshots.updateOne(
      { userId: nextRecord.userId },
      {
        $set: nextRecord,
      },
      { upsert: true }
    );
  }

  async function upsertManyByUser(collection, userId, records) {
    if (!records.length) {
      return;
    }

    await collection.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: {
            userId,
            id: record.id,
          },
          update: {
            $set: {
              ...record,
              userId,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  async function upsertMongoRecord(nextRecord) {
    const collections = await getCollections();
    if (!collections) {
      return false;
    }

    const userId = nextRecord.userId;
    const deviceId = nextRecord.identifiers && nextRecord.identifiers.deviceId
      ? nextRecord.identifiers.deviceId
      : nextRecord.user.deviceId || "";
    const { createdAt: userCreatedAt, ...userFields } = nextRecord.user;

    await Promise.all([
      collections.users.updateOne(
        { userId },
        {
          $set: {
            ...userFields,
            userId,
            deviceId,
            authMode: nextRecord.authMode,
            updatedAt: nextRecord.updatedAt,
          },
          $setOnInsert: {
            createdAt: userCreatedAt || nextRecord.createdAt,
          },
        },
        { upsert: true }
      ),
      collections.preferences.updateOne(
        { userId },
        {
          $set: {
            userId,
            favoriteToolIds: nextRecord.favorites,
            recentToolIds: nextRecord.recentToolIds,
            updatedAt: nextRecord.updatedAt,
          },
          $setOnInsert: {
            createdAt: nextRecord.createdAt,
          },
        },
        { upsert: true }
      ),
      upsertSnapshot(collections, nextRecord),
    ]);

    if (deviceId) {
      await collections.clientDevices.updateOne(
        { deviceId },
        {
          $set: {
            deviceId,
            userId,
            authMode: nextRecord.authMode,
            lastSeenAt: nextRecord.lastSeenAt,
            updatedAt: nextRecord.updatedAt,
          },
          $setOnInsert: {
            createdAt: nextRecord.createdAt,
          },
        },
        { upsert: true }
      );
    }

    await Promise.all([
      upsertManyByUser(collections.tasks, userId, nextRecord.tasks),
      upsertManyByUser(collections.pointsRecords, userId, nextRecord.pointsRecords),
      upsertManyByUser(collections.orders, userId, nextRecord.orders),
    ]);

    return true;
  }

  async function upsertLocalRecord(nextRecord) {
    const state = readLocalFile();
    const nextRecords = (state.records || []).filter((item) => item.userId !== nextRecord.userId);
    nextRecords.push(nextRecord);
    writeLocalFile({
      records: nextRecords,
    });
    return nextRecord;
  }

  async function upsertRecord(nextRecord) {
    const persistedToMongo = await upsertMongoRecord(nextRecord);
    if (persistedToMongo) {
      return nextRecord;
    }

    return upsertLocalRecord(nextRecord);
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
      collections: getCollectionNames(),
    };
  }

  async function close() {
    if (client) {
      await client.close();
      client = null;
      collectionsPromise = null;
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
