const fs = require("fs");
const path = require("path");

const projectRoot = process.env.MINIAPP_IMPORT_CHECK_ROOT || process.cwd();
const roots = ["app.js", "pages", "components", "services", "utils"];
const offenders = [];

function walk(targetPath) {
  const stat = fs.statSync(targetPath);

  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      walk(path.join(targetPath, entry));
    }
    return;
  }

  if (!targetPath.endsWith(".js")) {
    return;
  }

  if (/[.-](test|spec)\.js$/.test(targetPath)) {
    return;
  }

  if (targetPath.includes(`${path.sep}vendor${path.sep}`)) {
    return;
  }

  const content = fs.readFileSync(targetPath, "utf8");
  const relativePath = path.relative(projectRoot, targetPath);

  if (/require\((["'`]).*node_modules\//.test(content)) {
    offenders.push(`${relativePath} (relative node_modules import)`);
  }

  const requireCalls = content.matchAll(/require\((["'`])([^"'`]+)\1\)/g);
  for (const match of requireCalls) {
    const specifier = match[2];

    if (
      specifier &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("plugin://")
    ) {
      offenders.push(`${relativePath} -> ${specifier} (bare package require)`);
    }
  }
}

for (const root of roots) {
  const targetPath = path.join(projectRoot, root);
  if (fs.existsSync(targetPath)) {
    walk(targetPath);
  }
}

if (offenders.length > 0) {
  console.error("Mini program source files must not use unsupported package imports:");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

console.log("Mini program imports look valid.");
