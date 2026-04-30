const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("auth login no longer resurrects recent users or bind-phone flow", () => {
  const server = read("backend/server.js");

  assert.doesNotMatch(server, /recentActiveUser|auth\/bind-phone/);
  assert.match(server, /findOne\(\{ openid \}\)/);
});

test("client state repository no longer falls back to recent active users", () => {
  const repository = read("backend/lib/client-state-repository.js");

  assert.doesNotMatch(repository, /recentUsers|tryFindRecentState|limit\(5\)/);
  assert.match(repository, /findOne\(\{ userId: identity\.userId \}\)/);
});

test("payment backend no longer falls back to mock payment success", () => {
  const server = read("backend/server.js");

  assert.doesNotMatch(server, /mock:\s*true|SIM-\$\{Date\.now\(\)\}|收到模拟支付通知/);
  assert.match(server, /WECHAT_PAY_UNAVAILABLE/);
  assert.match(server, /wechat pay unavailable/);
});
