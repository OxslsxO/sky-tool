const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("payment server persists pending orders across process restarts", () => {
  const server = read("backend/server.js");

  assert.match(server, /pending-orders\.json/);
  assert.match(server, /function loadPendingOrdersFromDisk\(/);
  assert.match(server, /function savePendingOrdersToDisk\(/);
  assert.match(server, /pendingOrders\.set\(orderId,\s*order\)/);
  assert.match(server, /savePendingOrdersToDisk\(pendingOrders\)/);
});
