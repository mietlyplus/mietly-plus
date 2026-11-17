"use strict";

// Preview deployments share their environment variables with production unless
// someone scopes them apart in the Vercel dashboard. Rather than editing the
// shared production variables, a preview deployment prefers a *separately named*
// `<NAME>_PREVIEW` variable when one exists. In production and locally these
// resolve exactly as before, so production behaviour is unchanged.

const PRODUCTION_DB_NAME = "mietlyplus";
const DEFAULT_PREVIEW_DB_NAME = "leihfluss_preview_qa";
const DEFAULT_PRODUCT_UPLOAD_FOLDER = "leihfluss/products";

function isPreviewDeployment(env = process.env) {
  return env.VERCEL_ENV === "preview";
}

function readEnv(name, env = process.env) {
  if (isPreviewDeployment(env)) {
    const override = String(env[`${name}_PREVIEW`] || "").trim();
    if (override) return override;
  }
  return String(env[name] || "").trim();
}

/** Which database this process will connect to, and whether it is the shared one. */
function resolveDatabaseTarget(env = process.env) {
  const preview = isPreviewDeployment(env);
  const previewUri = String(env.MONGODB_URI_PREVIEW || "").trim();
  const usingPreviewDatabase = preview && Boolean(previewUri);

  if (usingPreviewDatabase) {
    return {
      uri: previewUri,
      dbName: String(env.MONGODB_DB_NAME_PREVIEW || "").trim() || DEFAULT_PREVIEW_DB_NAME,
      preview,
      usingPreviewDatabase,
    };
  }

  return {
    uri: String(env.MONGODB_URI || "").trim(),
    dbName: String(env.MONGODB_DB_NAME || "").trim() || PRODUCTION_DB_NAME,
    preview,
    usingPreviewDatabase,
  };
}

/**
 * A preview deployment is only safe for writes when it has its own database.
 * Production and local runs are not the concern of this check.
 */
function getDatabaseIsolation(env = process.env) {
  const target = resolveDatabaseTarget(env);

  if (!target.preview) {
    return { isolated: true, preview: false, dbName: target.dbName, reason: "" };
  }
  if (!target.usingPreviewDatabase) {
    return {
      isolated: false,
      preview: true,
      dbName: target.dbName,
      reason: "This preview has no MONGODB_URI_PREVIEW, so it would use the shared production database.",
    };
  }
  if (target.dbName === PRODUCTION_DB_NAME) {
    return {
      isolated: false,
      preview: true,
      dbName: target.dbName,
      reason: "The preview database name matches the production database.",
    };
  }
  return { isolated: true, preview: true, dbName: target.dbName, reason: "" };
}

function productUploadFolder(env = process.env) {
  return readEnv("CLOUDINARY_PRODUCT_FOLDER", env) || DEFAULT_PRODUCT_UPLOAD_FOLDER;
}

module.exports = {
  DEFAULT_PREVIEW_DB_NAME,
  DEFAULT_PRODUCT_UPLOAD_FOLDER,
  PRODUCTION_DB_NAME,
  getDatabaseIsolation,
  isPreviewDeployment,
  productUploadFolder,
  readEnv,
  resolveDatabaseTarget,
};
