const mongoose = require("mongoose");

let cachedConnectionPromise = null;
const DEFAULT_DB_NAME = "mietlyplus";

async function connectDatabase() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!cachedConnectionPromise) {
    const configuredDbName = String(process.env.MONGODB_DB_NAME || "").trim();
    const dbName = configuredDbName || DEFAULT_DB_NAME;

    cachedConnectionPromise = mongoose
      .connect(mongoUri, {
        dbName,
      })
      .catch((error) => {
        cachedConnectionPromise = null;
        throw error;
      });
  }

  await cachedConnectionPromise;
  return mongoose.connection;
}

module.exports = { connectDatabase };
