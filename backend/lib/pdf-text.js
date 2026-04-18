function decodePdfTextToken(value) {
  const text = String(value || "");

  try {
    return decodeURIComponent(text);
  } catch (error) {
    if (error instanceof URIError) {
      return text;
    }
    throw error;
  }
}

module.exports = {
  decodePdfTextToken,
};
