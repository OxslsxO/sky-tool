const fs = require("fs");
const { MongoClient } = require("mongodb");

function createOperationRepository(config) {
  let client = null;
  let collectionPromise = null;

  async function getCollection() {
    if (!config.mongodb.uri) {
      return null;
    }

    if (!collectionPromise) {
      collectionPromise = (async () => {
        client = new MongoClient(config.mongodb.uri);
        await client.connect();
        const db = client.db(config.mongodb.dbName);
        const collection = db.collection(config.mongodb.collectionName);
        await collection.createIndex({ createdAt: -1 });
        await collection.createIndex({ requestId: 1 });
        await collection.createIndex({ route: 1, createdAt: -1 });
        return collection;
      })();
    }

    return collectionPromise;
  }

  async function appendLocal(entry) {
    fs.appendFileSync(config.operationsLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async function record(entry) {
    const document = {
      ...entry,
      createdAt: new Date().toISOString(),
    };

    try {
      const collection = await getCollection();
      if (collection) {
        await collection.insertOne(document);
        return {
          provider: "mongodb",
        };
      }
    } catch (error) {
      document.persistenceError = error.message;
    }

    await appendLocal(document);
    return {
      provider: config.mongodb.uri ? "local-fallback" : "local-file",
    };
  }

  function getHealth() {
    return {
      provider: config.mongodb.uri ? "mongodb" : "local-file",
      mongodbEnabled: !!config.mongodb.uri,
      dbName: config.mongodb.dbName,
      collectionName: config.mongodb.collectionName,
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
    record,
    getHealth,
    close,
  };
}

module.exports = {
  createOperationRepository,
};
