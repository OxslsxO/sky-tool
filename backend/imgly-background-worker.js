const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { removeBackground } = require("@imgly/background-removal-node");

function getImglyPublicPath() {
  const packageDir = path.dirname(require.resolve("@imgly/background-removal-node"));
  return `${pathToFileURL(packageDir).href}/`;
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    throw new Error("Usage: node imgly-background-worker.js <input> <output>");
  }

  const inputBuffer = fs.readFileSync(inputPath);
  const result = await removeBackground(
    new Blob([inputBuffer], { type: "image/png" }),
    {
      publicPath: getImglyPublicPath(),
      model: "medium",
      output: { format: "image/png" },
    }
  );
  const transparentBuffer = Buffer.from(await result.arrayBuffer());
  fs.writeFileSync(outputPath, transparentBuffer);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
