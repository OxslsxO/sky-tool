const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");

function readFile(name) {
  return fs.readFileSync(path.join(projectRoot, name), "utf8");
}

function readReadmeMetadata() {
  const readme = readFile("README.md");
  const match = readme.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "README.md should start with Hugging Face Spaces metadata");

  return Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([^:#]+):\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1].trim(), match[2].trim()])
  );
}

test("Hugging Face Docker Space metadata exposes the backend port", () => {
  const metadata = readReadmeMetadata();
  const dockerfile = readFile("Dockerfile");

  assert.equal(metadata.sdk, "docker");
  assert.equal(metadata.app_port, "7860");
  assert.match(dockerfile, /^ENV PORT=7860$/m);
  assert.match(dockerfile, /^EXPOSE 7860$/m);
});

test("Docker Space runtime follows Hugging Face container conventions", () => {
  const dockerfile = readFile("Dockerfile");
  const dockerignore = readFile(".dockerignore");

  assert.match(dockerfile, /^WORKDIR \/home\/node\/app$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerignore, /^\.env$/m);
});
