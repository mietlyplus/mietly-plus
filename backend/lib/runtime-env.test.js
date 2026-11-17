"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getDatabaseIsolation, productUploadFolder, readEnv, resolveDatabaseTarget, PRODUCTION_DB_NAME,
} = require("./runtime-env");

const PROD = { MONGODB_URI: "mongodb://prod-host/x" };

test("production resolves exactly as before, ignoring any preview variables", () => {
  const env = { ...PROD, VERCEL_ENV: "production", MONGODB_URI_PREVIEW: "mongodb://preview-host/x" };
  const target = resolveDatabaseTarget(env);
  assert.equal(target.uri, "mongodb://prod-host/x");
  assert.equal(target.dbName, PRODUCTION_DB_NAME);
  assert.equal(target.usingPreviewDatabase, false);
  assert.equal(getDatabaseIsolation(env).isolated, true, "production is not subject to the preview guard");
});

test("a local run is unaffected", () => {
  const env = { ...PROD };
  assert.equal(resolveDatabaseTarget(env).uri, "mongodb://prod-host/x");
  assert.equal(getDatabaseIsolation(env).isolated, true);
});

test("an explicit MONGODB_DB_NAME is honoured outside preview", () => {
  const env = { ...PROD, VERCEL_ENV: "production", MONGODB_DB_NAME: "custom" };
  assert.equal(resolveDatabaseTarget(env).dbName, "custom");
});

test("a preview with its own database uses it, under a non-production name", () => {
  const env = { ...PROD, VERCEL_ENV: "preview", MONGODB_URI_PREVIEW: "mongodb://preview-host/x" };
  const target = resolveDatabaseTarget(env);
  assert.equal(target.uri, "mongodb://preview-host/x");
  assert.notEqual(target.dbName, PRODUCTION_DB_NAME);
  assert.equal(getDatabaseIsolation(env).isolated, true);
});

test("a preview with no database of its own is NOT isolated", () => {
  const env = { ...PROD, VERCEL_ENV: "preview" };
  const isolation = getDatabaseIsolation(env);
  assert.equal(isolation.isolated, false);
  assert.equal(isolation.preview, true);
  assert.match(isolation.reason, /production database/);
});

test("a preview database named like production is NOT isolated", () => {
  const env = {
    ...PROD, VERCEL_ENV: "preview",
    MONGODB_URI_PREVIEW: "mongodb://preview-host/x", MONGODB_DB_NAME_PREVIEW: PRODUCTION_DB_NAME,
  };
  assert.equal(getDatabaseIsolation(env).isolated, false);
});

test("a blank preview URI does not count as isolation", () => {
  const env = { ...PROD, VERCEL_ENV: "preview", MONGODB_URI_PREVIEW: "   " };
  assert.equal(getDatabaseIsolation(env).isolated, false);
});

test("the upload folder defaults to production's and is overridden only on preview", () => {
  assert.equal(productUploadFolder({}), "leihfluss/products");
  assert.equal(productUploadFolder({ VERCEL_ENV: "preview", CLOUDINARY_PRODUCT_FOLDER_PREVIEW: "leihfluss/preview-qa" }), "leihfluss/preview-qa");
  assert.equal(
    productUploadFolder({ VERCEL_ENV: "production", CLOUDINARY_PRODUCT_FOLDER_PREVIEW: "leihfluss/preview-qa" }),
    "leihfluss/products",
    "a preview override must never leak into production"
  );
});

test("readEnv only consults the preview variant on a preview deployment", () => {
  assert.equal(readEnv("X", { X: "shared", X_PREVIEW: "pv" }), "shared");
  assert.equal(readEnv("X", { VERCEL_ENV: "preview", X: "shared", X_PREVIEW: "pv" }), "pv");
  assert.equal(readEnv("X", { VERCEL_ENV: "preview", X: "shared" }), "shared");
});

const { applyPreviewOverrides } = require("./runtime-env");

test("a preview swaps in its own JWT secret", () => {
  const env = { VERCEL_ENV: "preview", JWT_SECRET: "shared", JWT_SECRET_PREVIEW: "preview-only" };
  assert.deepEqual(applyPreviewOverrides(env), ["JWT_SECRET"]);
  assert.equal(env.JWT_SECRET, "preview-only");
});

test("production and local runs never adopt a preview secret", () => {
  for (const vercelEnv of ["production", undefined]) {
    const env = { VERCEL_ENV: vercelEnv, JWT_SECRET: "shared", JWT_SECRET_PREVIEW: "preview-only" };
    assert.deepEqual(applyPreviewOverrides(env), []);
    assert.equal(env.JWT_SECRET, "shared", `VERCEL_ENV=${vercelEnv}`);
  }
});

test("a preview with no override keeps the shared secret, and a blank override is ignored", () => {
  const none = { VERCEL_ENV: "preview", JWT_SECRET: "shared" };
  assert.deepEqual(applyPreviewOverrides(none), []);
  assert.equal(none.JWT_SECRET, "shared");

  const blank = { VERCEL_ENV: "preview", JWT_SECRET: "shared", JWT_SECRET_PREVIEW: "   " };
  assert.deepEqual(applyPreviewOverrides(blank), []);
  assert.equal(blank.JWT_SECRET, "shared");
});
