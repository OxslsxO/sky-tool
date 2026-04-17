const { hasBackendService } = require("../services/backend-tools");
const { syncClientState, fetchClientState } = require("../services/state-sync");
const {
  seedUserState,
  getUserState,
  updateUserState,
  getSyncSnapshot,
  applyRemoteState,
  hasDirtySyncState,
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
    preferRemote:
      options.preferRemote !== undefined
        ? !!options.preferRemote
        : !snapshot.user.lastSyncedAt,
  });
  const syncedAt =
    response.sync && response.sync.syncedAt
      ? response.sync.syncedAt
      : response.state && response.state.syncedAt
        ? response.state.syncedAt
        : new Date().toISOString();
  const appliedState = applyRemoteState({
    ...(response.state || {}),
    user: {
      ...((response.state && response.state.user) || snapshot.user),
      lastSyncedAt: syncedAt,
      syncStatus: "synced",
    },
  });

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
      throw error;
    })
    .finally(() => {
      inflightSync = null;
    });

  return inflightSync;
}

async function pullCloudState() {
  if (!hasBackendService()) {
    return {
      ok: false,
      skipped: true,
      reason: "BACKEND_NOT_CONFIGURED",
    };
  }

  const user = seedUserState();
  const response = await fetchClientState({
    userId: user.userId,
    deviceId: user.deviceId,
  });
  const syncedAt =
    response.state && response.state.syncedAt
      ? response.state.syncedAt
      : new Date().toISOString();
  const appliedState = applyRemoteState({
    ...(response.state || {}),
    user: {
      ...((response.state && response.state.user) || user),
      lastSyncedAt: syncedAt,
      syncStatus: "synced",
    },
  });

  return {
    ok: true,
    skipped: false,
    state: appliedState,
    syncedAt,
  };
}

module.exports = {
  syncCloudState,
  pullCloudState,
};
