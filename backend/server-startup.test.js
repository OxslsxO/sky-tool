const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for exit. stdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    }

    function onStdout(chunk) {
      stdout += chunk.toString();
    }

    function onStderr(chunk) {
      stderr += chunk.toString();
    }

    function onExit(code, signal) {
      cleanup();
      resolve({ code, signal, stdout, stderr });
    }

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
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

test("starting a second server on the same port fails clearly instead of pretending to run", async () => {
  const port = 3217;
  const first = startServer(port);

  await waitForOutput(first, /sky-toolbox-backend running at http:\/\/127\.0\.0\.1:3217/, 8000);

  const second = startServer(port);
  const result = await waitForExit(second, 8000);

  first.kill("SIGTERM");
  await waitForExit(first, 8000);

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /sky-toolbox-backend running at http:\/\/127\.0\.0\.1:3217/);
  assert.match(`${result.stdout}\n${result.stderr}`, /EADDRINUSE|address already in use/);
});
