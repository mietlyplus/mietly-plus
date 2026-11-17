"use strict";

/**
 * A preview deployment must not create drafts against the shared production
 * database. VERCEL_ENV is set BEFORE the app loads, as on a real preview.
 */

process.env.VERCEL_ENV = "preview";
process.env.AI_TEXT_PROVIDER = "fixture";
process.env.AI_IMAGE_PROVIDER = "fixture";
process.env.JWT_SECRET = "integration-suite-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.join(__dirname, "..");
const { JSON_LD_PAGE } = require("./fixtures/product-pages");
const fetchSource = require(path.join(ROOT, "lib/source/fetch-source"));
fetchSource.fetchSourceDocument = async (url) => ({ html: JSON_LD_PAGE, finalUrl: url, redirectChain: [url] });

let mongod, server, base, adminToken, previewUri;

async function call(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, ...(options.headers || {}) },
  });
  const raw = await response.text();
  let body; try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: response.status, body };
}

const create = () => call("/api/admin/product-drafts", {
  method: "POST",
  body: JSON.stringify({ sourceUrl: "https://example.com/a7m4", weeklyPrice: 29, monthlyPrice: 89, submissionKey: `k-${Math.random()}` }),
});

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  previewUri = mongod.getUri();
  // Stand-in for the shared production database: it must never be written to.
  process.env.MONGODB_URI = previewUri;
  process.env.MONGODB_URI_PREVIEW = previewUri;
  process.env.MONGODB_DB_NAME_PREVIEW = "leihfluss_preview_qa";

  const app = require(path.join(ROOT, "index.js"));
  const jwt = require("jsonwebtoken");
  const mongoose = require("mongoose");
  await app.initializeApp();

  const Category = require(path.join(ROOT, "models/Category"));
  const Brand = require(path.join(ROOT, "models/Brand"));
  await Category.create({ name: { en: "Cameras", de: "Kameras" }, slug: "cameras" });
  await Brand.create({ name: "Sony", slug: "sony", isActive: true });

  adminToken = jwt.sign({ sub: String(new mongoose.Types.ObjectId()), email: "a@t", role: "admin", name: "IT" }, process.env.JWT_SECRET);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await require("mongoose").disconnect();
  await mongod?.stop();
});

test("with its own database, a preview may create drafts", async () => {
  const response = await create();
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.status, "ready");
});

test("the connection really goes to the preview database, not the default one", async () => {
  const mongoose = require("mongoose");
  assert.equal(mongoose.connection.name, "leihfluss_preview_qa");
});

test("a preview WITHOUT its own database refuses to create a draft, and writes nothing", async () => {
  const ProductDraft = require(path.join(ROOT, "models/ProductDraft"));
  const Product = require(path.join(ROOT, "models/Product"));
  const draftsBefore = await ProductDraft.countDocuments();
  const productsBefore = await Product.countDocuments();

  const saved = process.env.MONGODB_URI_PREVIEW;
  delete process.env.MONGODB_URI_PREVIEW;
  try {
    const response = await create();
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "PREVIEW_DATABASE_NOT_ISOLATED");
    assert.equal(await ProductDraft.countDocuments(), draftsBefore, "no draft was written");
    assert.equal(await Product.countDocuments(), productsBefore, "no product was written");
  } finally {
    process.env.MONGODB_URI_PREVIEW = saved;
  }
});

test("every mutating draft route is guarded, not just creation", async () => {
  const saved = process.env.MONGODB_URI_PREVIEW;
  delete process.env.MONGODB_URI_PREVIEW;
  try {
    const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const attempts = [
      ["POST", `/api/admin/product-drafts/${id}/resume`],
      ["POST", `/api/admin/product-drafts/${id}/regenerate-text`],
      ["POST", `/api/admin/product-drafts/${id}/publish`],
      ["POST", `/api/admin/product-drafts/${id}/images/${id}/generate`],
      ["PATCH", `/api/admin/product-drafts/${id}/images`],
      ["DELETE", `/api/admin/product-drafts/${id}`],
    ];
    for (const [method, url] of attempts) {
      const response = await call(url, { method, body: "{}" });
      assert.equal(response.status, 503, `${method} ${url}`);
    }
  } finally {
    process.env.MONGODB_URI_PREVIEW = saved;
  }
});

test("reading is still allowed, and the environment is reported honestly", async () => {
  const saved = process.env.MONGODB_URI_PREVIEW;
  delete process.env.MONGODB_URI_PREVIEW;
  try {
    const response = await call("/api/admin/product-drafts/providers");
    assert.equal(response.status, 200);
    assert.equal(response.body.environment.preview, true);
    assert.equal(response.body.environment.databaseIsolated, false);
  } finally {
    process.env.MONGODB_URI_PREVIEW = saved;
  }

  const isolated = await call("/api/admin/product-drafts/providers");
  assert.equal(isolated.body.environment.databaseIsolated, true);
  assert.equal(isolated.body.environment.databaseName, "leihfluss_preview_qa");
});
