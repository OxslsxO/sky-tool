const CLIENT_TOOL_IDS = [
  "image-compress",
  "image-convert",
  "resize-crop",
  "image-to-pdf",
  "qr-maker",
  "unit-convert",
];

function isClientTool(toolId) {
  return CLIENT_TOOL_IDS.includes(toolId);
}

function requiresBackend(toolId) {
  return !isClientTool(toolId);
}

function getToolAvailability(toolId) {
  return isClientTool(toolId) ? "client" : "backend";
}

module.exports = {
  CLIENT_TOOL_IDS,
  isClientTool,
  requiresBackend,
  getToolAvailability,
};
