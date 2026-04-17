const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

process.env.PHOTO_ID_DISABLE_IMGLY = "1";

const { buildPhotoIdImage } = require("./lib/photo-id");

function hasNonBackgroundPixelNearBottom(image, background) {
  const { data, info } = image;
  const startRow = Math.max(0, info.height - 6);

  for (let y = startRow; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const pixel = Array.from(data.slice(offset, offset + 3));
      if (pixel[0] !== background[0] || pixel[1] !== background[1] || pixel[2] !== background[2]) {
        return true;
      }
    }
  }

  return false;
}

function hasNonBackgroundPixelInCenterBand(image, background) {
  const startX = Math.floor(image.info.width * 0.25);
  const endX = Math.ceil(image.info.width * 0.75);
  const startY = Math.floor(image.info.height * 0.35);
  const endY = Math.ceil(image.info.height * 0.72);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.info.width + x) * image.info.channels;
      const pixel = Array.from(image.data.slice(offset, offset + 3));
      if (pixel[0] !== background[0] || pixel[1] !== background[1] || pixel[2] !== background[2]) {
        return true;
      }
    }
  }

  return false;
}

function findNonBackgroundBounds(image, background) {
  const bounds = {
    left: image.info.width,
    right: -1,
    top: image.info.height,
    bottom: -1,
  };

  for (let y = 0; y < image.info.height; y += 1) {
    for (let x = 0; x < image.info.width; x += 1) {
      const offset = (y * image.info.width + x) * image.info.channels;
      const isBackground =
        image.data[offset] === background[0] &&
        image.data[offset + 1] === background[1] &&
        image.data[offset + 2] === background[2];

      if (isBackground) {
        continue;
      }

      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
  }

  if (bounds.right < bounds.left || bounds.bottom < bounds.top) {
    return null;
  }

  return {
    ...bounds,
    width: bounds.right - bounds.left + 1,
    height: bounds.bottom - bounds.top + 1,
  };
}

function countColorLikePixels(image, region, color, tolerance) {
  let count = 0;
  const startX = Math.max(0, Math.floor(image.info.width * region.startX));
  const endX = Math.min(image.info.width, Math.ceil(image.info.width * region.endX));
  const startY = Math.max(0, Math.floor(image.info.height * region.startY));
  const endY = Math.min(image.info.height, Math.ceil(image.info.height * region.endY));

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.info.width + x) * image.info.channels;
      const distance =
        Math.abs(image.data[offset] - color[0]) +
        Math.abs(image.data[offset + 1] - color[1]) +
        Math.abs(image.data[offset + 2] - color[2]);
      if (distance <= tolerance) {
        count += 1;
      }
    }
  }

  return count;
}

async function createSyntheticPortrait() {
  const width = 480;
  const height = 640;
  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#ffffff",
    },
  });

  const head = await sharp({
    create: {
      width: 130,
      height: 150,
      channels: 4,
      background: "#f2c39d",
    },
  })
    .png()
    .toBuffer();

  const body = await sharp({
    create: {
      width: 210,
      height: 270,
      channels: 4,
      background: "#1d3557",
    },
  })
    .png()
    .toBuffer();

  return base
    .composite([
      { input: head, left: 175, top: 120 },
      { input: body, left: 135, top: 250 },
    ])
    .png()
    .toBuffer();
}

async function createWhiteShirtOnWhiteBackgroundPortrait() {
  const width = 520;
  const height = 680;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <ellipse cx="260" cy="205" rx="80" ry="104" fill="#efc29d"/>
      <ellipse cx="260" cy="148" rx="82" ry="42" fill="#202020"/>
      <rect x="230" y="296" width="60" height="44" rx="18" fill="#efc29d"/>
      <path d="M128 334 C178 306 342 306 392 334 L438 620 L82 620 Z" fill="#f8f8f8"/>
      <path d="M226 338 L260 432 L294 338 Z" fill="#efc29d"/>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createEdgePortrait() {
  const width = 480;
  const height = 640;
  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#ffffff",
    },
  });

  const head = await sharp({
    create: {
      width: 150,
      height: 150,
      channels: 4,
      background: "#f2c39d",
    },
  })
    .png()
    .toBuffer();

  const body = await sharp({
    create: {
      width: 240,
      height: 330,
      channels: 4,
      background: "#1d3557",
    },
  })
    .png()
    .toBuffer();

  return base
    .composite([
      { input: head, left: 300, top: 110 },
      { input: body, left: 240, top: 250 },
    ])
    .png()
    .toBuffer();
}

async function createPortraitWithEarBleedBackground() {
  const width = 520;
  const height = 680;
  const sourceBackground = "#4d8fe6";
  const skin = "#f1c19a";
  const jacket = "#4f5965";
  const hair = "#2c241d";
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${sourceBackground}"/>
      <circle cx="182" cy="202" r="26" fill="${skin}"/>
      <circle cx="338" cy="202" r="26" fill="${skin}"/>
      <ellipse cx="260" cy="200" rx="92" ry="112" fill="${skin}"/>
      <ellipse cx="260" cy="148" rx="84" ry="42" fill="${hair}"/>
      <rect x="228" y="286" width="64" height="42" rx="24" fill="${skin}"/>
      <rect x="152" y="320" width="216" height="278" rx="88" fill="${jacket}"/>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createPortraitHoldingDocuments() {
  const width = 520;
  const height = 680;
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f7f7f7"/>
      <ellipse cx="260" cy="185" rx="82" ry="104" fill="#efc29d"/>
      <ellipse cx="260" cy="126" rx="86" ry="44" fill="#202020"/>
      <rect x="226" y="282" width="68" height="46" rx="20" fill="#efc29d"/>
      <path d="M118 330 C172 306 348 306 402 330 L462 650 L58 650 Z" fill="#f4f4f4"/>
      <rect x="34" y="420" width="180" height="190" fill="#fafafa" stroke="#eef3f4" stroke-width="4"/>
      <rect x="304" y="456" width="145" height="180" fill="#fff9ef" stroke="#f4eadf" stroke-width="3"/>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

test("photo-id replaces a plain background with the requested solid color", async () => {
  const input = await createSyntheticPortrait();
  const result = await buildPhotoIdImage(
    { tempDir: __dirname },
    input,
    { size: "一寸", background: "蓝底", retouch: "自然" }
  );

  const image = await sharp(result.buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.equal(result.width, 295);
  assert.equal(result.height, 413);
  assert.ok(result.subjectHeight / result.height > 0.55);

  const cornerOffset = 0;
  const background = [45, 110, 201];

  assert.deepEqual(
    Array.from(image.data.slice(cornerOffset, cornerOffset + 3)),
    background
  );
  assert.equal(hasNonBackgroundPixelInCenterBand(image, background), true);
  assert.equal(hasNonBackgroundPixelNearBottom(image, background), true);

  const subjectBounds = findNonBackgroundBounds(image, background);
  assert.ok(subjectBounds);
  assert.ok(subjectBounds.bottom >= result.height - 1);
  assert.ok(subjectBounds.width / result.width > 0.98);
  assert.ok(subjectBounds.top / result.height >= 0.08);
  assert.ok(subjectBounds.top / result.height < 0.15);
});

test("photo-id handles portraits near the image edge without extract errors", async () => {
  const input = await createEdgePortrait();
  const result = await buildPhotoIdImage(
    { tempDir: __dirname },
    input,
    { size: "一寸", background: "红底", retouch: "自然" }
  );

  assert.equal(result.width, 295);
  assert.equal(result.height, 413);
  assert.ok(result.subjectWidth > 0);
  assert.ok(result.subjectHeight > 0);
  assert.ok(result.subjectWidth / result.width > 0.75);
  assert.ok(result.subjectHeight / result.height > 0.45);
});

test("photo-id suppresses source background spill around ear edges", async () => {
  const input = await createPortraitWithEarBleedBackground();
  const result = await buildPhotoIdImage(
    { tempDir: __dirname },
    input,
    { size: "一寸", background: "白底", retouch: "自然" }
  );

  const image = await sharp(result.buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sourceBlue = [77, 143, 230];
  const blueishPixelCount = countColorLikePixels(
    image,
    {
      startX: 0.18,
      endX: 0.82,
      startY: 0.12,
      endY: 0.58,
    },
    sourceBlue,
    80
  );

  assert.ok(
    blueishPixelCount < 18,
    `expected ear-edge background spill to stay low, got ${blueishPixelCount} blueish pixels`
  );
});

test("photo-id does not gray out light foreground documents", async () => {
  const input = await createPortraitHoldingDocuments();
  const result = await buildPhotoIdImage(
    { tempDir: __dirname },
    input,
    { size: "一寸", background: "红底", retouch: "自然" }
  );

  const image = await sharp(result.buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let grayishPixels = 0;
  const startX = Math.floor(image.info.width * 0.02);
  const endX = Math.ceil(image.info.width * 0.44);
  const startY = Math.floor(image.info.height * 0.62);
  const endY = Math.ceil(image.info.height * 0.95);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.info.width + x) * image.info.channels;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      const range = Math.max(r, g, b) - Math.min(r, g, b);
      if (r >= 135 && r <= 215 && g >= 135 && g <= 215 && b >= 135 && b <= 215 && range < 45) {
        grayishPixels += 1;
      }
    }
  }

  assert.ok(
    grayishPixels < 300,
    `expected light foreground documents to avoid gray cleanup patches, got ${grayishPixels} gray pixels`
  );
});

test("photo-id keeps white clothes when the source background is also white", async () => {
  const input = await createWhiteShirtOnWhiteBackgroundPortrait();
  const result = await buildPhotoIdImage(
    { tempDir: __dirname },
    input,
    { size: "一寸", background: "蓝底", retouch: "自然" }
  );

  const image = await sharp(result.buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const blueBackground = [45, 110, 201];
  let nonBackgroundPixels = 0;
  const startX = Math.floor(image.info.width * 0.28);
  const endX = Math.ceil(image.info.width * 0.72);
  const startY = Math.floor(image.info.height * 0.55);
  const endY = Math.ceil(image.info.height * 0.9);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.info.width + x) * image.info.channels;
      const distance =
        Math.abs(image.data[offset] - blueBackground[0]) +
        Math.abs(image.data[offset + 1] - blueBackground[1]) +
        Math.abs(image.data[offset + 2] - blueBackground[2]);
      if (distance > 80) {
        nonBackgroundPixels += 1;
      }
    }
  }

  assert.ok(
    nonBackgroundPixels > 8000,
    `expected white clothing to remain visible, got ${nonBackgroundPixels} non-background pixels`
  );

  const upperSideBackgroundPixels = countColorLikePixels(
    image,
    {
      startX: 0.05,
      endX: 0.24,
      startY: 0.38,
      endY: 0.62,
    },
    blueBackground,
    45
  );

  assert.ok(
    upperSideBackgroundPixels > 1800,
    `expected shoulder-side source background to be replaced, got ${upperSideBackgroundPixels} blue pixels`
  );
});
