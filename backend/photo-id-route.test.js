const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

function waitForOutput(child, matcher, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for output ${matcher}. stdout=${stdout}\nstderr=${stderr}`
        )
      );
    }, timeoutMs);

    function onStdout(chunk) {
      stdout += chunk.toString();
      if (matcher.test(stdout)) {
        cleanup();
        resolve({ stdout, stderr });
      }
    }

    function onStderr(chunk) {
      stderr += chunk.toString();
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(`Process exited early with code=${code} signal=${signal}\nstdout=${stdout}\nstderr=${stderr}`)
      );
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for server exit"));
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function requestJson({ method, port, path: pathname, data }) {
  return new Promise((resolve, reject) => {
    const payload = data ? Buffer.from(JSON.stringify(data)) : null;
    const request = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path: pathname,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": payload.length,
            }
          : {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: body ? JSON.parse(body) : null,
          });
        });
      }
    );

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

function startServer(port) {
  const projectRoot = path.join(__dirname, "..");

  return spawn(process.execPath, ["backend/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      API_TOKEN: "",
      MONGODB_URI: "",
      QINIU_ACCESS_KEY: "",
      QINIU_SECRET_KEY: "",
      QINIU_BUCKET: "",
      QINIU_REGION: "",
      QINIU_PUBLIC_BASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("health exposes photo-id capability and the route is mounted", async () => {
  const port = 3221;
  const server = startServer(port);

  await waitForOutput(server, /sky-toolbox-backend running at http:\/\/127\.0\.0\.1:3221/, 8000);

  try {
    const health = await requestJson({
      method: "GET",
      port,
      path: "/health",
    });

    assert.equal(health.statusCode, 200);
    assert.equal(health.body.capabilities.photoId, true);

    const response = await requestJson({
      method: "POST",
      port,
      path: "/api/photo-id",
      data: {},
    });

    assert.notEqual(response.statusCode, 404);
    assert.equal(response.body.ok, false);
    assert.match(response.body.code, /PHOTO_ID|FILE|MISSING/i);
  } finally {
    server.kill("SIGTERM");
    await waitForExit(server, 8000);
  }
});
