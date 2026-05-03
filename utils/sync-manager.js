const { hasBackendService } = require("../services/backend-tools");
const { syncClientState, fetchClientState } = require("../services/state-sync");
const {
  seedUserState,
  getUserState,
  updateUserState,
  getSyncSnapshot,
  applyRemoteState,
  hasDirtySyncState,
  getSyncDirtyStamp,
} = require("./task-store");

let inflightSync = null;

function shouldSync(options) {
  if (options.force) {
    return true;
  }

  const user = getUserState();
  return !user.lastSyncedAt || hasDirtySyncState();
}

async function runSync(options = {}) {
  if (!hasBackendService()) {
    return {
      ok: false,
      skipped: true,
      reason: "BACKEND_NOT_CONFIGURED",
    };
  }

  if (!shouldSync(options)) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_LOCAL_CHANGES",
      state: getSyncSnapshot(),
    };
  }

  const dirtyStampAtStart = getSyncDirtyStamp();
  const hasLocalChanges = !!dirtyStampAtStart;
  const seededUser = seedUserState();
  updateUserState(
    {
      deviceId: seededUser.deviceId,
      syncStatus: "syncing",
    },
    { silent: true }
  );

  const snapshot = getSyncSnapshot();
  const response = await syncClientState({
    userId: snapshot.user.userId,
    deviceId: snapshot.user.deviceId,
    user: snapshot.user,
    tasks: snapshot.tasks,
    favorites: snapshot.favorites,
    recentToolIds: snapshot.recentToolIds,
    pointsRecords: snapshot.pointsRecords,
    orders: snapshot.orders,
    dailyFreeUsage: snapshot.dailyFreeUsage,
    preferRemote:
      options.preferRemote !== undefined
        ? !!options.preferRemote
        : !snapshot.user.lastSyncedAt && !hasLocalChanges,
  });
  const syncedAt =
    response.sync && response.sync.syncedAt
      ? response.sync.syncedAt
      : response.state && response.state.syncedAt
        ? response.state.syncedAt
        : new Date().toISOString();
  const dirtyStampBeforeApply = getSyncDirtyStamp();
  const appliedState = applyRemoteState({
    ...(response.state || {}),
    user: {
      ...((response.state && response.state.user) || snapshot.user),
      lastSyncedAt: syncedAt,
      syncStatus: "synced",
    },
  });

  if (dirtyStampBeforeApply && dirtyStampBeforeApply !== dirtyStampAtStart) {
    updateUserState(
      {
        syncStatus: "local",
      },
      { silent: false }
    );
  }

  return {
    ok: true,
    skipped: false,
    state: appliedState,
    syncedAt,
    summary: response.sync || {},
  };
}

function syncCloudState(options = {}) {
  if (inflightSync) {
    return inflightSync;
  }

  inflightSync = runSync(options)
    .catch((error) => {
      updateUserState(
        {
          syncStatus: "error",
        },
        { silent: true }
      );
      console.warn("[sync] 同步失败:", (error && error.message) || error);
      return {
        ok: false,
        skipped: true,
        reason: "SYNC_ERROR",
        error: (error && error.message) || "同步失败",
      };
    })
    .finally(() => {
      inflightSync = null;
    });

  return inflightSync;
}

async function pullCloudState() {
  if (!hasBackendService()) {
    console.log("⚠️ 后端服务未配置，跳过云端拉取");
    return {
      ok: false,
      skipped: true,
      reason: "BACKEND_NOT_CONFIGURED",
    };
  }

  console.log("🔍 尝试从云端拉取数据...");
  
  try {
    // 先尝试从本地存储读取可能遗留的标识
    let tryUserId = null;
    let tryDeviceId = null;
    
    try {
      const rawUser = wx.getStorageSync("sky_tools_user");
      if (rawUser) {
        tryUserId = rawUser.userId;
        tryDeviceId = rawUser.deviceId;
        console.log("📦 找到本地遗留标识:", { tryUserId, tryDeviceId });
      }
    } catch (e) {
      console.log("📦 没有本地遗留标识");
    }
    
    // 如果有本地标识，先尝试用这个查找
    let response = null;
    
    if (tryUserId || tryDeviceId) {
      try {
        console.log("🔍 尝试用遗留标识查找...");
        response = await fetchClientState({
          userId: tryUserId,
          deviceId: tryDeviceId,
        });
      } catch (e) {
        console.log("⚠️ 遗留标识查找失败:", e);
        response = null;
      }
    }
    
    // 如果没找到，再尝试用新初始化的用户
    if (!response || !response.state) {
      console.log("🔍 创建新用户标识并重试...");
      const newUser = seedUserState();
      try {
        response = await fetchClientState({
          userId: newUser.userId,
          deviceId: newUser.deviceId,
        });
      } catch (e) {
        console.log("⚠️ 新用户查找失败:", e);
        response = null;
      }
    }

    // 如果找到了云端数据，应用它
    if (response && response.state) {
      console.log("✅ 从云端找到数据，应用中...");
      const syncedAt =
        response.state && response.state.syncedAt
          ? response.state.syncedAt
          : new Date().toISOString();
      
      const appliedState = applyRemoteState({
        ...(response.state || {}),
        user: {
          ...((response.state && response.state.user)),
          lastSyncedAt: syncedAt,
          syncStatus: "synced",
        },
      });

      console.log("✅ 云端数据已应用");
      return {
        ok: true,
        skipped: false,
        state: appliedState,
        syncedAt,
      };
    }
    
    console.log("ℹ️ 云端没有找到数据，使用本地初始化");
    return {
      ok: false,
      skipped: true,
      reason: "NO_CLOUD_DATA",
    };
  } catch (error) {
    console.error("❌ 拉取云端数据失败:", error);
    return {
      ok: false,
      skipped: true,
      reason: "SYNC_ERROR",
      error: error.message,
    };
  }
}

module.exports = {
  syncCloudState,
  pullCloudState,
};
