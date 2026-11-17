const mongoose = require("mongoose");
const { resolveDatabaseTarget } = require("./lib/runtime-env");

let cachedConnectionPromise = null;

async function connectDatabase() {
  // On a preview deployment this prefers MONGODB_URI_PREVIEW / MONGODB_DB_NAME_PREVIEW;
  // everywhere else it resolves exactly as it always has.
  const { uri: mongoUri, dbName } = resolveDatabaseTarget();
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not configured.");
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  if (!cachedConnectionPromise) {
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
