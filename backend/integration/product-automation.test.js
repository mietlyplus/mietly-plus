"use strict";

/**
 * Integration suite for the product-link workflow.
 *
 * Runs against an ephemeral in-process MongoDB. Providers are FIXTURE and the
 * retailer HTTP body is supplied from synthetic fixtures -- the real SSRF gate
 * still runs on every URL. No network call leaves the machine and no paid API
 * is used.
 *
 *   npm run test:integration
 */

process.env.AI_TEXT_PROVIDER = "fixture";
process.env.AI_IMAGE_PROVIDER = "fixture";
process.env.JWT_SECRET = "integration-suite-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const { MongoMemoryServer } = require("mongodb-memory-server");
const { JSON_LD_PAGE, INJECTION_PAGE, SPARSE_PAGE } = require("./fixtures/product-pages");
const csvFixture = require("./fixtures/csv-rows");

const ROOT = path.join(__dirname, "..");
const fetchSource = require(path.join(ROOT, "lib/source/fetch-source"));

// Serve fixture HTML instead of the internet; the SSRF gate is left intact.
const realFetchDocument = fetchSource.fetchSourceDocument;
fetchSource.fetchSourceDocument = async (url) => {
  await fetchSource.assertPublicUrl(url);
  if (url.includes("/denied")) throw new fetchSource.SourceFetchError("ACCESS_DENIED", "login required");
  if (url.includes("/injection")) return { html: INJECTION_PAGE, finalUrl: url, redirectChain: [url] };
  if (url.includes("/sparse")) return { html: SPARSE_PAGE, finalUrl: url, redirectChain: [url] };
  return { html: JSON_LD_PAGE, finalUrl: url, redirectChain: [url] };
};

const app = require(path.join(ROOT, "index.js"));
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Product = require(path.join(ROOT, "models/Product"));
const Category = require(path.join(ROOT, "models/Category"));
const Brand = require(path.join(ROOT, "models/Brand"));
const ProductDraft = require(path.join(ROOT, "models/ProductDraft"));

let mongod;
let server;
let base;
let adminToken;
let categoryId;
let brandId;

const SOURCE_URL = "https://example.com/a7m4";

async function call(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: response.status, body };
}

const asAdmin = (pathname, options = {}) =>
  call(pathname, { ...options, headers: { Authorization: `Bearer ${adminToken}`, ...(options.headers || {}) } });

async function createDraft(overrides = {}) {
  const response = await asAdmin("/api/admin/product-drafts", {
    method: "POST",
    body: JSON.stringify({
      sourceUrl: SOURCE_URL,
      weeklyPrice: 29,
      monthlyPrice: 89,
      submissionKey: `key-${Math.random().toString(36).slice(2)}`,
      ...overrides,
    }),
  });
  return response.body;
}

/** Replaces fixture content so a draft can legitimately reach publication. */
async function makePublishable(draftId) {
  const draft = await ProductDraft.findById(draftId);
  // Replace every generated/source image with one of the owner's own photos, so
  // these tests exercise revision separation rather than the fixture and
  // retailer-imagery gates (covered by their own tests).
  draft.images = [{ url: "https://cdn.test/own-photo.jpg", origin: "user", role: "user-upload", status: "ready" }];
  draft.providers.text.real = true;
  draft.providers.image.real = true;
  await draft.save();

  const product = await Product.findById(draft.productId);
  product.imageUrl = draft.images[0].url;
  product.isActive = false;
  await product.save();
  return draft;
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB_NAME = "leihfluss_integration";

  await app.initializeApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const category = await Category.create({ name: { en: "Cameras", de: "Kameras" }, slug: "cameras" });
  const brand = await Brand.create({ name: "Sony", slug: "sony", isActive: true });
  categoryId = String(category._id);
  brandId = String(brand._id);

  adminToken = jwt.sign(
    { sub: String(new mongoose.Types.ObjectId()), email: "admin@test", role: "admin", name: "IT" },
    process.env.JWT_SECRET
  );
});

test.after(async () => {
  fetchSource.fetchSourceDocument = realFetchDocument;
  server?.close();
  await mongoose.disconnect();
  await mongod?.stop();
});

// ---------------------------------------------------------------------------
// Draft creation, pricing and provenance
// ---------------------------------------------------------------------------

test("a product link becomes a private draft with the owner's rental prices", async () => {
  const draft = await createDraft();
  assert.equal(draft.status, "ready");

  const product = await Product.findById(draft.productId);
  assert.equal(product.isActive, false, "a draft is never public");
  assert.equal(product.buyerPrice, 29, "weekly -> buyerPrice");
  assert.equal(product.monthlyBuyerPrice, 89, "monthly -> monthlyBuyerPrice");
  assert.equal(product.monthlyPrice, 89);
  assert.equal(product.offerPrice, 0, "no invented discount");
});

test("the retailer's purchase price is provenance only", async () => {
  const draft = await createDraft();
  assert.equal(draft.provenance.retailerPrice.amount, 2499);

  const product = await Product.findById(draft.productId);
  for (const field of ["buyerPrice", "monthlyBuyerPrice", "monthlyPrice", "offerPrice", "monthlyOfferPrice"]) {
    assert.notEqual(product[field], 2499, `${field} must not take the retailer price`);
  }
});

test("prompt injection in the source page is data, never an instruction", async () => {
  const draft = await createDraft({ sourceUrl: "https://example.com/injection" });
  const product = await Product.findById(draft.productId);

  assert.equal(product.isActive, false, "the page asked to activate the listing; it must not happen");
  assert.equal(product.buyerPrice, 29, "the page asked for a 1 euro price; the owner's input stands");
});

test("a draft is invisible on every public route", async () => {
  const draft = await createDraft();
  const product = await Product.findById(draft.productId);

  const list = await call("/api/products");
  const bySlug = await call(`/api/products/${product.slug}`);
  const popular = await call("/api/products/popular");

  assert.ok(!list.body.some((entry) => entry.id === String(product._id)));
  assert.equal(bySlug.status, 404);
  assert.ok(!popular.body.some((entry) => entry.id === String(product._id)));
});

test("draft routes require admin authentication", async () => {
  const anonymous = await call("/api/admin/product-drafts");
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------------------
// Approval is preserved after publication (review finding 1)
// ---------------------------------------------------------------------------

test("regenerating text on a published product does not change the public listing", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);

  const published = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  assert.equal(published.status, 200, published.body.message);

  const liveBefore = await call(`/api/products/${published.body.draft.product.slug}`);
  assert.equal(liveBefore.status, 200);

  const regenerated = await asAdmin(`/api/admin/product-drafts/${draft.id}/regenerate-text`, {
    method: "POST", body: JSON.stringify({ instruction: "Completely different wording." }),
  });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.body.pendingRevision.hasChanges, true, "the new text is parked as a revision");

  const liveAfter = await call(`/api/products/${published.body.draft.product.slug}`);
  assert.equal(liveAfter.body.title, liveBefore.body.title, "the public title must not change");
  assert.equal(liveAfter.body.description, liveBefore.body.description);
});

test("image changes on a published product do not change the public listing", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  const published = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  const slug = published.body.draft.product.slug;
  const liveBefore = await call(`/api/products/${slug}`);

  await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/new-angle.jpg" }),
  });
  const reordered = await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "primary", imageId: null }),
  });

  const liveAfter = await call(`/api/products/${slug}`);
  assert.equal(liveAfter.body.imageUrl, liveBefore.body.imageUrl, "the public cover image must not change");
  assert.deepEqual(liveAfter.body.galleryImages, liveBefore.body.galleryImages);
  assert.equal(reordered.status, 404, "an unknown image id is rejected rather than applied");
});

test("a pending revision reaches the storefront only when explicitly applied", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  const published = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  const slug = published.body.draft.product.slug;

  await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/revised.jpg" }),
  });

  const noConfirm = await asAdmin(`/api/admin/product-drafts/${draft.id}/apply-revision`, {
    method: "POST", body: JSON.stringify({}),
  });
  assert.equal(noConfirm.status, 400, "applying a revision needs explicit confirmation");

  const liveBefore = await call(`/api/products/${slug}`);
  const applied = await asAdmin(`/api/admin/product-drafts/${draft.id}/apply-revision`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  assert.equal(applied.status, 200, applied.body.message);

  const liveAfter = await call(`/api/products/${slug}`);
  assert.notDeepEqual(
    [liveAfter.body.imageUrl, ...liveAfter.body.galleryImages],
    [liveBefore.body.imageUrl, ...liveBefore.body.galleryImages],
    "after approval the live images change"
  );
  assert.equal(applied.body.draft.pendingRevision.hasChanges, false);
});

test("discarding a revision keeps each image's real origin", async () => {
  const draft = await createDraft({ sourceUrl: "https://example.com/sparse" });
  const record = await ProductDraft.findById(draft.id);
  record.images = [{ url: "https://cdn.example.com/retailer.jpg", origin: "source", role: "source-reference", status: "ready" }];
  record.providers.text.real = true;
  record.providers.image.real = true;
  record.sourceImageryConfirmed = true;
  await record.save();

  const product = await Product.findById(record.productId);
  product.imageUrl = "https://cdn.example.com/retailer.jpg";
  product.categoryId = categoryId;
  product.brandId = brandId;
  await product.save();

  await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true, confirmSourceImagery: true }),
  });
  await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/extra.jpg" }),
  });

  const discarded = await asAdmin(`/api/admin/product-drafts/${draft.id}/discard-revision`, { method: "POST", body: "{}" });

  const restored = discarded.body.draft.images.find((image) => image.url === "https://cdn.example.com/retailer.jpg");
  assert.equal(restored.origin, "source", "a reused retailer photo must not be relabelled as the owner's upload");
});

test("a pending revision can be discarded, leaving the live product alone", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  const published = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  const slug = published.body.draft.product.slug;
  const liveBefore = await call(`/api/products/${slug}`);

  await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/unwanted.jpg" }),
  });
  const discarded = await asAdmin(`/api/admin/product-drafts/${draft.id}/discard-revision`, { method: "POST", body: "{}" });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.draft.pendingRevision.hasChanges, false);

  const liveAfter = await call(`/api/products/${slug}`);
  assert.equal(liveAfter.body.imageUrl, liveBefore.body.imageUrl);
});

// ---------------------------------------------------------------------------
// Publication rules enforced at every entry point (review finding 2)
// ---------------------------------------------------------------------------

test("the ordinary product editor cannot activate an AI draft that fails the checks", async () => {
  const draft = await createDraft();
  const product = await Product.findById(draft.productId);

  // The default draft still carries fixture text, so publication must be refused
  // through the editor exactly as it is through the draft route.
  const viaEditor = await asAdmin(`/api/admin/products/${product._id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: product.title, slug: product.slug, imageUrl: "https://cdn.test/real.jpg",
      categoryId, brandId, monthlyPrice: 89, buyerPrice: 29, monthlyBuyerPrice: 89,
      isActive: true,
    }),
  });

  assert.equal(viaEditor.status, 400, "the editor must not bypass the draft checks");
  assert.match(viaEditor.body.message, /fixture/i);
  assert.equal(viaEditor.body.draftId, draft.id);

  const reread = await Product.findById(product._id);
  assert.equal(reread.isActive, false, "the product stayed private");
});

test("the editor still activates an ordinary manual product", async () => {
  const created = await asAdmin("/api/admin/products", {
    method: "POST",
    body: JSON.stringify({
      title: "Manual Lamp", slug: "manual-lamp", imageUrl: "https://cdn.test/lamp.jpg",
      categoryId, brandId, monthlyPrice: 40, buyerPrice: 15, monthlyBuyerPrice: 40, isActive: false,
    }),
  });
  assert.equal(created.status, 201);

  const activated = await asAdmin(`/api/admin/products/${created.body.id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: "Manual Lamp", slug: "manual-lamp", imageUrl: "https://cdn.test/lamp.jpg",
      categoryId, brandId, monthlyPrice: 40, buyerPrice: 15, monthlyBuyerPrice: 40, isActive: true,
    }),
  });

  assert.equal(activated.status, 200, "a product with no draft is unaffected by the AI rules");
  assert.equal(activated.body.isActive, true);
});

test("publication requires an explicit confirmation", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  const response = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, { method: "POST", body: "{}" });
  assert.equal(response.status, 400);
});

test("fixture text and fixture images both block publication", async () => {
  const draft = await createDraft();
  const blocked = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  assert.equal(blocked.status, 400);
  assert.ok(blocked.body.blockers.some((entry) => /fixture/i.test(entry)));
});

test("reusing retailer imagery needs an explicit confirmation", async () => {
  const draft = await createDraft({ sourceUrl: "https://example.com/sparse" });
  const record = await ProductDraft.findById(draft.id);

  for (const image of [...record.images]) record.images.pull({ _id: image._id });
  record.images.push({ url: "https://cdn.example.com/retailer.jpg", origin: "source", role: "source-reference", status: "ready" });
  record.providers.text.real = true;
  record.providers.image.real = true;
  record.markModified("images");
  await record.save();

  const product = await Product.findById(record.productId);
  product.imageUrl = "https://cdn.example.com/retailer.jpg";
  product.categoryId = categoryId;
  product.brandId = brandId;
  await product.save();

  const refused = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true }),
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.requiresSourceImageryConfirmation, true);

  const accepted = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, {
    method: "POST", body: JSON.stringify({ confirm: true, confirmSourceImagery: true }),
  });
  assert.equal(accepted.status, 200, accepted.body.message);
});

// ---------------------------------------------------------------------------
// Recovery (review finding 3)
// ---------------------------------------------------------------------------

test("a draft whose generation failed can be resumed without re-entering anything", async () => {
  const orphan = await ProductDraft.create({
    createdByAdminId: new mongoose.Types.ObjectId(),
    sourceUrl: SOURCE_URL,
    weeklyPrice: 33,
    monthlyPrice: 99,
    instruction: "Black, not silver.",
    status: "failed",
    images: [{ url: "https://cdn.test/mine.jpg", origin: "user", role: "user-upload", status: "ready" }],
    providers: { text: { id: "fixture", model: "dev", real: false }, image: { id: "fixture", model: "dev", real: false } },
  });

  const resumed = await asAdmin(`/api/admin/product-drafts/${orphan._id}/resume`, { method: "POST", body: "{}" });

  assert.equal(resumed.status, 200);
  assert.ok(resumed.body.productId, "resuming creates the product");
  assert.equal(resumed.body.weeklyPrice, 33, "the prices are preserved");
  assert.equal(resumed.body.monthlyPrice, 99);
  assert.equal(resumed.body.instruction, "Black, not silver.");
  assert.ok(resumed.body.images.some((image) => image.url === "https://cdn.test/mine.jpg"), "uploaded photos survive");
});

test("regenerate-text on a draft with no product asks for a resume instead of failing", async () => {
  const orphan = await ProductDraft.create({
    createdByAdminId: new mongoose.Types.ObjectId(),
    sourceUrl: SOURCE_URL, weeklyPrice: 10, monthlyPrice: 30, status: "failed",
  });
  const response = await asAdmin(`/api/admin/product-drafts/${orphan._id}/regenerate-text`, { method: "POST", body: "{}" });

  assert.equal(response.status, 409);
  assert.equal(response.body.resumeRequired, true);
});

test("a job interrupted mid-flight is resumable once its lease expires", async () => {
  const stalled = await ProductDraft.create({
    createdByAdminId: new mongoose.Types.ObjectId(),
    sourceUrl: SOURCE_URL, weeklyPrice: 12, monthlyPrice: 36,
    status: "generating",
    jobLeaseAt: new Date(),
  });

  const tooSoon = await asAdmin(`/api/admin/product-drafts/${stalled._id}/resume`, { method: "POST", body: "{}" });
  assert.equal(tooSoon.status, 409, "a live lease is respected");

  // Age the lease as wall-clock time would.
  await ProductDraft.updateOne({ _id: stalled._id }, { $set: { jobLeaseAt: new Date(Date.now() - 10 * 60 * 1000) } });

  const recovered = await asAdmin(`/api/admin/product-drafts/${stalled._id}/resume`, { method: "POST", body: "{}" });
  assert.equal(recovered.status, 200);
  assert.ok(recovered.body.productId, "the interrupted job completes on resume");
});

test("resuming a draft that already has a product is a no-op", async () => {
  const draft = await createDraft();
  const response = await asAdmin(`/api/admin/product-drafts/${draft.id}/resume`, { method: "POST", body: "{}" });
  assert.equal(response.body.alreadyComplete, true);
  assert.equal(response.body.productId, draft.productId);
});

// ---------------------------------------------------------------------------
// Image workflow (review finding 6)
// ---------------------------------------------------------------------------

test("image completeness is reported honestly, never as complete when short", async () => {
  const draft = await createDraft({ sourceUrl: "https://example.com/sparse" });

  assert.equal(draft.imageCompleteness.target, 5);
  assert.ok(draft.imageCompleteness.ready < 5);
  assert.equal(draft.imageCompleteness.complete, false);
  assert.ok(draft.imageCompleteness.missing > 0);
  assert.ok(draft.imageCompleteness.reasons.length > 0, "the shortfall is explained");
});

test("image origins are reported separately so reused retailer photos are visible", async () => {
  const draft = await createDraft();
  const byOrigin = draft.imageCompleteness.byOrigin;
  assert.ok("user" in byOrigin && "source" in byOrigin && "ai" in byOrigin && "fixture" in byOrigin);
});

test("a second generate request for the same image is refused while one is in flight", async () => {
  const draft = await createDraft();
  const record = await ProductDraft.findById(draft.id);
  const target = record.images.find((image) => image.origin === "ai" || image.status === "pending");
  assert.ok(target, "expected a generatable image");

  target.status = "generating";
  target.generationStartedAt = new Date();
  await record.save();

  const duplicate = await asAdmin(
    `/api/admin/product-drafts/${draft.id}/images/${target._id}/generate`,
    { method: "POST", body: "{}" }
  );
  assert.equal(duplicate.status, 409, "a duplicate request must not pay for the same image twice");
});

test("the five-image cap is enforced", async () => {
  const draft = await createDraft();
  const record = await ProductDraft.findById(draft.id);
  while (record.images.length < 5) record.images.push({ url: "https://cdn.test/x.jpg", origin: "user", status: "ready" });
  await record.save();

  const overflow = await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/six.jpg" }),
  });
  assert.equal(overflow.status, 400);
});

// ---------------------------------------------------------------------------
// CSV compatibility (review finding 7)
// ---------------------------------------------------------------------------

test("a real CSV row imports through the shared product endpoint", async () => {
  const rows = csvFixture.parseCsv(csvFixture.toCsv());
  assert.equal(rows.length, 1);

  const payload = csvFixture.mapCsvRowToProduct(rows[0], {
    categoryId, brandId, imageUrl: "https://cdn.test/tripod.jpg",
  });
  const created = await asAdmin("/api/admin/products", { method: "POST", body: JSON.stringify(payload) });

  assert.equal(created.status, 201, created.body.message);
  assert.equal(created.body.slug, "csv-tripod");
  assert.equal(created.body.buyerPrice, 12, "weekly price from the CSV");
  assert.equal(created.body.monthlyBuyerPrice, 35, "monthly price from the CSV");
  assert.deepEqual(created.body.specifications.map((s) => s.key), ["Height"]);
  assert.deepEqual(created.body.tags, ["tripod", "camera"]);

  // And it is publicly visible, unlike an AI draft.
  const live = await call("/api/products/csv-tripod");
  assert.equal(live.status, 200);
  assert.equal(live.body.title, "CSV Tripod");
});

test("a CSV product has no draft and is untouched by the AI publication rules", async () => {
  const draftForCsv = await ProductDraft.findOne({ productId: null, sourceUrl: "csv" });
  assert.equal(draftForCsv, null);

  const product = await Product.findOne({ slug: "csv-tripod" });
  assert.equal(product.isActive, true, "CSV imports publish directly, as before");
});
