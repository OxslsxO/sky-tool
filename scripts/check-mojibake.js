const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SHOULD_FIX = process.argv.includes("--fix");
const JS_ONLY = process.argv.includes("--js-only");

const IGNORE_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "miniprogram_npm",
  "coverage",
  "dist",
  "build",
  ".next",
]);

const IGNORE_PATH_PARTS = [
  "docs/superpowers/plans/",
  "scripts/check-mojibake.js",
  "utils/vendor/",
];

const TARGET_EXTENSIONS = new Set([
  ".js",
  ".json",
  ".wxml",
  ".wxss",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".env",
  ".example",
]);

const REPLACEMENTS = new Map([
  ["鏅寸┖宸ュ叿绠卞井淇″皬绋嬪簭", "晴空工具箱微信小程序"],
  ["鏀惰捣", "收起"],
  ["鏇村", "更多"],
  ["棰勮澶у浘", "预览大图"],
  ["棰勮", "预览"],
  ["淇濆瓨鍒扮浉鍐?", "保存到相册"],
  ["淇濆瓨", "保存"],
  ["澶嶅埗閾炬帴", "复制链接"],
  ["澶嶅埗", "复制"],
  ["澶勭悊涓?", "处理中"],
  ["宸插鍒?", "已复制"],
  ["鎵撳紑澶辫触", "打开失败"],
  ["鎾斁澶辫触", "播放失败"],
  ["PDF 鎷嗗垎澶辫触", "PDF 拆分失败"],
  ["瀵煎嚭鏍煎紡", "导出格式"],
  ["鏀瑰昂瀵哥粨鏋?", "改尺寸结果."],
  ["鍙傛暟", "参数"],
  ["缃俊搴?", "置信度 "],
  ["鏈夋晥鏈熻嚦", "有效期至"],
  ["澶у皬", "大小"],
  ["浠?PDF", "份 PDF"],
  ["鏈煡", "未知"],
  ["鈫?", "->"],
  ["楂樻竻", "高清"],
  ["璐ㄩ噺浼樺厛", "质量优先"],
  ["???????", "证件照生成失败"],
  ["灞呬腑瑁佸壀", "居中裁剪"],
  ["鑺傜渷", "节省"],
  ["閰嶇疆", "配置"],
  ["鏇存柊缁撴灉", "更新结果"],
  ["绫诲瀷", "类型"],
  ["绮惧害", "精度"],
  ["甯冨眬", "布局"],
]);

const SUSPICIOUS_PATTERNS = [
  /\uFFFD/,
  /[鐧钃绾闊鍥绋鏂杞寮瀹璇浣馃鈥銆锛脳€]/,
  /澶勭悊|鍔熻兘|棰勮|淇濆瓨|澶嶅埗|閾炬帴|鐩稿唽|鎵撳紑|澶辫触/,
  /娓呮櫚|瀵煎嚭|鏍煎紡|鏀瑰昂|粨鏋|宸插畬|鏃犳崯|鍧囪/,
  /浠\?PDF|鏈煡|鈫\?/,
  /楂樻竻|灞呬腑瑁佸壀|鑺傜渷|閰嶇疆|鏇存柊缁撴灉|绫诲瀷|绮惧害|甯冨眬|\?\?\?\?/,
  /璐ㄩ噺浼樺厛/,
  /鍙傛暟|缃俊搴\?/,
  /鏈夋晥鏈熻嚦|澶у皬/,
];

function toRelativePath(filePath) {
  return path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
}

function shouldIgnorePath(filePath) {
  const relativePath = toRelativePath(filePath);
  return IGNORE_PATH_PARTS.some((part) => relativePath.includes(part));
}

function shouldScanFile(filePath) {
  const baseName = path.basename(filePath);
  const ext = path.extname(filePath);

  if (shouldIgnorePath(filePath)) {
    return false;
  }

  if (JS_ONLY) {
    return ext === ".js";
  }

  if (baseName === ".env.example") {
    return true;
  }

  return TARGET_EXTENSIONS.has(ext);
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIR_NAMES.has(entry.name) && !shouldIgnorePath(fullPath)) {
        files.push(...listFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && shouldScanFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function applyKnownReplacements(text) {
  let next = text;
  for (const [bad, good] of REPLACEMENTS.entries()) {
    next = next.split(bad).join(good);
  }
  return next;
}

function isSuspicious(line) {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(line));
}

function scanFile(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  const fixed = SHOULD_FIX ? applyKnownReplacements(original) : original;

  if (SHOULD_FIX && fixed !== original) {
    fs.writeFileSync(filePath, fixed, "utf8");
  }

  return fixed
    .split(/\r?\n/)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => isSuspicious(line));
}

const findings = [];

for (const filePath of listFiles(ROOT_DIR)) {
  const hits = scanFile(filePath);
  for (const hit of hits) {
    findings.push({
      file: toRelativePath(filePath),
      ...hit,
    });
  }
}

if (findings.length) {
  const action = SHOULD_FIX ? "修复后仍发现疑似乱码" : "发现疑似乱码";
  console.log(`${action}: ${findings.length} 处`);
  for (const item of findings) {
    console.log(`${item.file}:${item.number}: ${item.line}`);
  }
  process.exitCode = 1;
} else {
  console.log(SHOULD_FIX ? "乱码检查完成，已修复已知乱码，未发现残留。" : "乱码检查完成，未发现疑似乱码。");
}
