const crypto = require("crypto");
const fs = require("fs");

const CORE_KEY = Buffer.from("687A4852416D736F356B496E62617857", "hex");
const META_KEY = Buffer.from("2331346C6A6B5F215C5D2630553C2728", "hex");

function aes128EcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  const pad = decrypted[decrypted.length - 1];
  if (pad > 0 && pad <= 16) {
    const valid = decrypted.slice(-pad).every((b) => b === pad);
    if (valid) {
      decrypted = decrypted.slice(0, -pad);
    }
  }
  return decrypted;
}

function buildKeyBox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    box[i] = i;
  }

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + box[i] + key[i % key.length]) % 256;
    const temp = box[i];
    box[i] = box[j];
    box[j] = temp;
  }

  return box;
}

function detectAudioFormat(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const header = buffer.slice(0, 12);
  const hex = header.toString("hex");

  if (hex.startsWith("664c6143")) return "flac";
  if (hex.startsWith("494433")) return "mp3";
  if (hex.startsWith("fff9") || hex.startsWith("fffa") || hex.startsWith("fffb") || hex.startsWith("fff3") || hex.startsWith("fff2")) return "mp3";
  if (hex.startsWith("52494646") && header.slice(8, 12).toString("ascii") === "WAVE") return "wav";
  if (hex.startsWith("4f676753")) return "ogg";
  if (hex.startsWith("000000") && header.slice(4, 8).toString("hex") === "66747970") return "m4a";
  if (hex.startsWith("466f726d") && header.slice(8, 12).toString("ascii") === "AIFF") return "aiff";

  console.log("[NCM] 无法识别的音频格式，文件头(hex):", hex);
  return null;
}

function decryptNcm(inputBuffer) {
  let offset = 10;

  const keyLength = inputBuffer.readUInt32LE(offset);
  offset += 4;
  console.log("[NCM] keyLength:", keyLength, "offset after keyLen:", offset);

  const keyData = inputBuffer.slice(offset, offset + keyLength);
  offset += keyLength;
  console.log("[NCM] offset after keyData:", offset);

  const modifiedKeyData = keyData.map((b) => b ^ 0x64);
  const decryptedKeyData = aes128EcbDecrypt(modifiedKeyData, CORE_KEY);
  const actualKey = decryptedKeyData.slice(17);
  console.log("[NCM] 解密后 key 长度:", actualKey.length);
  const keyBox = buildKeyBox(actualKey);

  const metaLength = inputBuffer.readUInt32LE(offset);
  offset += 4;
  console.log("[NCM] metaLength:", metaLength, "offset after metaLen:", offset);

  let metaData = null;
  let coverData = null;

  if (metaLength > 0) {
    const rawMeta = inputBuffer.slice(offset, offset + metaLength);
    offset += metaLength;
    console.log("[NCM] offset after metaData:", offset);

    const modifiedMeta = rawMeta.slice(22).map((b) => b ^ 0x63);
    try {
      const decryptedMeta = aes128EcbDecrypt(modifiedMeta, META_KEY);
      const metaStr = decryptedMeta.toString("utf-8");
      const base64Data = metaStr.slice(6);
      const jsonStr = Buffer.from(base64Data, "base64").toString("utf-8");
      metaData = JSON.parse(jsonStr);
      console.log("[NCM] 元数据解析成功, 歌名:", metaData?.musicName || "未知");
    } catch (e) {
      console.warn("[NCM] 解析元数据失败:", e.message);
    }
  }

  // gap: 5 bytes unknown + 4 bytes CRC32 = 9 bytes total
  offset += 5;
  console.log("[NCM] offset after gap(5):", offset, "next 4 bytes (CRC32):", inputBuffer.slice(offset, offset + 4).toString("hex"));
  offset += 4;
  console.log("[NCM] offset after CRC32(4):", offset);

  const imageLength = inputBuffer.readUInt32LE(offset);
  offset += 4;
  console.log("[NCM] imageLength:", imageLength, "offset after imageLen:", offset);

  if (imageLength > 0 && imageLength < inputBuffer.length - offset) {
    coverData = inputBuffer.slice(offset, offset + imageLength);
    offset += imageLength;
  } else if (imageLength > 0) {
    console.warn("[NCM] imageLength 异常:", imageLength, "跳过图片读取");
  }
  console.log("[NCM] offset after image:", offset, "剩余数据:", inputBuffer.length - offset, "bytes");

  const musicData = inputBuffer.slice(offset);
  console.log("[NCM] 音频加密数据大小:", musicData.length, "bytes, 前16字节(hex):", musicData.slice(0, 16).toString("hex"));

  if (musicData.length === 0) {
    throw new Error("NCM 解密失败：未找到音频数据，偏移量计算可能有误");
  }

  const decryptedMusic = Buffer.alloc(musicData.length);

  for (let i = 0; i < musicData.length; i++) {
    const j = (i + 1) & 0xff;
    const k = (keyBox[j] + keyBox[(keyBox[j] + j) & 0xff]) & 0xff;
    decryptedMusic[i] = musicData[i] ^ keyBox[k];
  }

  const format = detectAudioFormat(decryptedMusic);
  console.log("[NCM] 解密后检测到的音频格式:", format || "未知");
  console.log("[NCM] 解密后数据大小:", decryptedMusic.length, "bytes, 前16字节(hex):", decryptedMusic.slice(0, 16).toString("hex"));

  return {
    musicData: decryptedMusic,
    format,
    metaData,
    coverData,
  };
}

function decryptNcmToFile(inputBuffer, outputPath) {
  const result = decryptNcm(inputBuffer);
  fs.writeFileSync(outputPath, result.musicData);
  return result;
}

module.exports = {
  decryptNcm,
  decryptNcmToFile,
  detectAudioFormat,
  isNcmFile: (fileName) => /\.ncm$/i.test(fileName),
};
