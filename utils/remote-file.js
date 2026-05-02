function getPreferredRemoteFileUrl(file) {
  if (!file) {
    return "";
  }

  return file.downloadUrl || file.fallbackUrl || file.url || file.externalUrl || "";
}

module.exports = {
  getPreferredRemoteFileUrl,
};
