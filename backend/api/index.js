const { app, initializeApp } = require("../index");

function normalizePathForExpress(req) {
  const routeOverride = Array.isArray(req.query?.__path) ? req.query.__path[0] : req.query?.__path;
  if (!routeOverride) return;

  const originalUrl = String(req.url || "");
  const queryString = originalUrl.includes("?") ? originalUrl.slice(originalUrl.indexOf("?") + 1) : "";
  const searchParams = new URLSearchParams(queryString);
  searchParams.delete("__path");
  const cleanQuery = searchParams.toString();

  req.url = cleanQuery ? `${routeOverride}?${cleanQuery}` : routeOverride;
}

module.exports = async (req, res) => {
  try {
    normalizePathForExpress(req);
    await initializeApp();
    return app(req, res);
  } catch (error) {
    console.error("Serverless handler failed:", error.message);
    return res.status(500).json({ message: "Server failed to initialize." });
  }
};
