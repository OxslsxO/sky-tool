const GROUP_CONFIG = {
  长度: {
    units: ["毫米", "厘米", "米", "千米", "英寸", "英尺"],
    toBase: {
      毫米: 0.001,
      厘米: 0.01,
      米: 1,
      千米: 1000,
      英寸: 0.0254,
      英尺: 0.3048,
    },
    baseUnit: "米",
  },
  重量: {
    units: ["克", "千克", "斤", "磅"],
    toBase: {
      克: 0.001,
      千克: 1,
      斤: 0.5,
      磅: 0.45359237,
    },
    baseUnit: "千克",
  },
  面积: {
    units: ["平方米", "平方厘米", "平方公里", "亩", "公顷"],
    toBase: {
      平方厘米: 0.0001,
      平方米: 1,
      平方公里: 1000000,
      亩: 666.6666667,
      公顷: 10000,
    },
    baseUnit: "平方米",
  },
  存储: {
    units: ["B", "KB", "MB", "GB", "TB"],
    toBase: {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    },
    baseUnit: "B",
  },
};

const PRECISION_MAP = {
  整数: 0,
  两位小数: 2,
  四位小数: 4,
};

function getGroupUnits(group) {
  const config = GROUP_CONFIG[group] || GROUP_CONFIG.长度;
  return config.units;
}

function convertValue({ group, value, fromUnit, toUnit, precisionLabel }) {
  const config = GROUP_CONFIG[group];
  if (!config) {
    return null;
  }

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return null;
  }

  const baseValue = numericValue * config.toBase[fromUnit];
  const converted = baseValue / config.toBase[toUnit];
  const precision = PRECISION_MAP[precisionLabel] || 2;

  return {
    group,
    fromUnit,
    toUnit,
    input: numericValue,
    value: converted,
    text: `${numericValue} ${fromUnit} = ${converted.toFixed(precision)} ${toUnit}`,
    precision,
  };
}

module.exports = {
  GROUP_CONFIG,
  getGroupUnits,
  convertValue,
};
