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
  if (url.includes("/rich")) return { html: RICH_PAGE, finalUrl: url, redirectChain: [url] };
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

// ---------------------------------------------------------------------------
// The retailer photo is a reference, not a listing image
// ---------------------------------------------------------------------------

test("a retailer photo never takes a slot from the generated set", async () => {
  // The fixture page carries two source images and the owner uploads none.
  const draft = await createDraft();

  assert.equal(draft.provenance.sourceImages.length, 2, "the page did offer source images");
  assert.ok(!draft.images.some((image) => image.origin === "source"), "no retailer photo is in the listing");
  assert.equal(draft.images.length, 5, "all five slots are available for generated images");
  assert.ok(draft.images.every((image) => image.status === "pending"));
});

test("a draft with nothing generated yet is not reported as complete", async () => {
  const draft = await createDraft();
  assert.equal(draft.imageCompleteness.ready, 0);
  assert.equal(draft.imageCompleteness.complete, false);
  assert.equal(draft.imageCompleteness.missing, 5);
});

test("until the first image exists the cover is the placeholder, not the retailer photo", async () => {
  const draft = await createDraft();
  const product = await Product.findById(draft.productId);
  assert.ok(product.imageUrl.startsWith("data:image/svg+xml"), "placeholder cover");
  assert.ok(!product.imageUrl.includes("cdn.example.com"), "must not borrow the retailer's photo");
});

test("the stale 'no image yet' warning disappears once an image exists", async () => {
  const draft = await createDraft();
  assert.ok(draft.warnings.some((warning) => warning.code === "no_image_yet"));

  await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, {
    method: "PATCH", body: JSON.stringify({ action: "replace", imageId: draft.images[0].id, url: "https://cdn.test/mine.jpg" }),
  });
  const reread = await asAdmin(`/api/admin/product-drafts/${draft.id}`);
  assert.ok(!reread.body.warnings.some((warning) => warning.code === "no_image_yet"));
});

// ---------------------------------------------------------------------------
// Failure recovery: needs source information, resume, taxonomy, image rebuild
// ---------------------------------------------------------------------------

const fixtureProvider = require(path.join(ROOT, "lib/ai/fixture-provider"));
const realGenerate = fixtureProvider.fixtureTextProvider.generateListing;
let textCalls = 0;
fixtureProvider.fixtureTextProvider.generateListing = async (...args) => {
  textCalls += 1;
  return realGenerate.apply(fixtureProvider.fixtureTextProvider, args);
};

const DENIED_URL = "https://example.com/denied";
const resume = (id, body) =>
  asAdmin(`/api/admin/product-drafts/${id}/resume`, { method: "POST", body: JSON.stringify(body || {}) });

test("a blocked source waits for the owner: status needs_source, nothing generated, nothing spent", async () => {
  const productsBefore = await Product.countDocuments();
  const callsBefore = textCalls;

  const draft = await createDraft({ sourceUrl: DENIED_URL, weeklyPrice: 45, monthlyPrice: 120 });

  assert.equal(draft.status, "needs_source", "never 'ready' without a source");
  assert.equal(draft.needs.source, true);
  assert.equal(draft.productId, null, "no product is invented from the link");
  assert.equal(textCalls, callsBefore, "no provider call: a link alone is not source material");
  assert.equal(await Product.countDocuments(), productsBefore);
  assert.equal(draft.weeklyPrice, 45, "the owner's prices are kept");
  assert.equal(draft.monthlyPrice, 120);
  assert.ok(draft.warnings.some((w) => w.code === "extraction_access_denied"));
  assert.ok(draft.warnings.some((w) => w.code === "needs_source_information"));
});

test("pasted details turn a needs_source draft into a real draft, keeping prices and inputs", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL, weeklyPrice: 45, monthlyPrice: 120, instruction: "Black." });
  const callsBefore = textCalls;

  const resumed = await resume(draft.id, { details: "Gigabyte Gaming A16\nAMD Ryzen 7 260, 16 GB RAM, 1 TB SSD, RTX 5060" });

  assert.equal(resumed.status, 200, JSON.stringify(resumed.body).slice(0, 200));
  assert.equal(resumed.body.status, "ready");
  assert.ok(resumed.body.productId);
  assert.equal(resumed.body.weeklyPrice, 45);
  assert.equal(resumed.body.monthlyPrice, 120);
  assert.equal(resumed.body.instruction, "Black.");
  assert.equal(textCalls, callsBefore + 1, "exactly one text generation");
  assert.equal(resumed.body.product.buyerPrice, 45);
  assert.equal(resumed.body.product.monthlyBuyerPrice, 120);
});

test("an unmatched category and brand stay unresolved, never replaced with the first ones", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL });
  const resumed = await resume(draft.id, { details: "Gigabyte Gaming A16 laptop, 16 inch, 16 GB RAM" });

  const product = await Product.findById(resumed.body.productId);
  assert.equal(product.categoryId, null, "no 'Cameras' substitution");
  assert.equal(product.brandId, null, "no 'Sony' substitution");
  assert.equal(resumed.body.taxonomy.categoryResolved, false);
  assert.equal(resumed.body.taxonomy.brandResolved, false);
  assert.equal(resumed.body.needs.taxonomy, true);
  assert.ok(resumed.body.warnings.some((w) => w.code === "category_unresolved"));
  assert.ok(!resumed.body.warnings.some((w) => w.code === "placeholder_taxonomy"));
});

test("publication is blocked until category and brand are chosen, then allowed", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL });
  const resumed = await resume(draft.id, { details: "Gigabyte Gaming A16 laptop" });
  await makePublishable(draft.id);
  const product = await Product.findById(resumed.body.productId);
  product.buyerPrice = 45; product.monthlyBuyerPrice = 120; await product.save();

  const blocked = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, { method: "POST", body: JSON.stringify({ confirm: true }) });
  assert.equal(blocked.status, 400);
  assert.ok(blocked.body.blockers.some((b) => /category/i.test(b)));
  assert.ok(blocked.body.blockers.some((b) => /brand/i.test(b)));

  const viaEditor = await asAdmin(`/api/admin/products/${product._id}`, {
    method: "PUT",
    body: JSON.stringify({ title: product.title, slug: product.slug, imageUrl: "https://cdn.test/own-photo.jpg", categoryId, brandId, monthlyPrice: 120, buyerPrice: 45, monthlyBuyerPrice: 120, isActive: true }),
  });
  assert.equal(viaEditor.status, 200, "the editor assigned both, so its own check passes");

  // Choose through the draft route instead, and publish.
  const picked = await asAdmin(`/api/admin/product-drafts/${draft.id}/taxonomy`, { method: "PATCH", body: JSON.stringify({ categoryId, brandId }) });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.taxonomy.confirmed, true);
  assert.equal(picked.body.needs.taxonomy, false);
});

test("a taxonomy choice must be an existing category and brand", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL });
  await resume(draft.id, { details: "Some product" });
  const missing = "cccccccccccccccccccccccc";

  assert.equal((await asAdmin(`/api/admin/product-drafts/${draft.id}/taxonomy`, { method: "PATCH", body: JSON.stringify({ categoryId: missing }) })).status, 400);
  assert.equal((await asAdmin(`/api/admin/product-drafts/${draft.id}/taxonomy`, { method: "PATCH", body: JSON.stringify({ brandId: missing }) })).status, 400);
  assert.equal((await asAdmin(`/api/admin/product-drafts/${draft.id}/taxonomy`, { method: "PATCH", body: JSON.stringify({ categoryId: "not-an-id" }) })).status, 400);
});

test("a confirmed choice is not overwritten by a later regeneration", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL });
  await resume(draft.id, { details: "First details" });
  await asAdmin(`/api/admin/product-drafts/${draft.id}/taxonomy`, { method: "PATCH", body: JSON.stringify({ categoryId, brandId }) });

  const again = await resume(draft.id, { details: "Better details with a spec sheet" });
  assert.equal(again.status, 200);
  assert.equal(String(again.body.product.categoryId), categoryId, "the owner's choice survives");
  assert.equal(String(again.body.product.brandId), brandId);
});

test("an alternate link on the same draft finishes it, reusing prices and the draft id", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL, weeklyPrice: 15, monthlyPrice: 40 });
  assert.equal(draft.status, "needs_source");

  const resumed = await resume(draft.id, { sourceUrl: "https://example.com/a7m4" });

  assert.equal(resumed.body.id, draft.id, "same draft, not a new one");
  assert.equal(resumed.body.status, "ready");
  assert.equal(resumed.body.sourceUrl, "https://example.com/a7m4");
  assert.equal(resumed.body.weeklyPrice, 15);
  assert.equal(resumed.body.product.buyerPrice, 15);
  assert.equal(String(resumed.body.product.categoryId), categoryId, "matched from the new source");
});

test("an older draft saved 'ready' from a blocked link reads as needs_source and cannot publish", async () => {
  const legacy = await ProductDraft.create({
    createdByAdminId: new mongoose.Types.ObjectId(),
    sourceUrl: DENIED_URL, weeklyPrice: 45, monthlyPrice: 120, status: "ready",
    steps: { extraction: { status: "failed", error: "ACCESS_DENIED" }, text: { status: "done" }, images: { status: "skipped" } },
    providers: { text: { id: "gemini", model: "m", real: true }, image: { id: "gemini", model: "m", real: true } },
    warnings: [{ code: "placeholder_taxonomy", field: "categoryId", message: "placeholder" }],
    images: [{ url: "https://cdn.test/mine.jpg", origin: "user", role: "user-upload", status: "ready" }],
  });
  const product = await Product.create({
    title: "Guessed from the URL", slug: `legacy-${Date.now()}`, imageUrl: "https://cdn.test/mine.jpg",
    categoryId, brandId, monthlyPrice: 120, buyerPrice: 45, monthlyBuyerPrice: 120, isActive: false,
  });
  legacy.productId = product._id; await legacy.save();

  const shown = await asAdmin(`/api/admin/product-drafts/${legacy._id}`);
  assert.equal(shown.body.status, "needs_source", "not 'ready'");
  assert.ok(!shown.body.warnings.some((w) => w.code === "placeholder_taxonomy"));

  const publish = await asAdmin(`/api/admin/product-drafts/${legacy._id}/publish`, { method: "POST", body: JSON.stringify({ confirm: true }) });
  assert.equal(publish.status, 400);
  assert.ok(publish.body.blockers.some((b) => /verified source/i.test(b)));

  const fixed = await resume(String(legacy._id), { details: "Real details from the spec sheet" });
  assert.equal(fixed.body.status, "ready");
  const reread = await Product.findById(product._id);
  assert.equal(reread.buyerPrice, 45, "prices untouched");
  assert.equal(reread.categoryId, null, "the unconfirmed placeholder is cleared, not kept");
  assert.notEqual(reread.title, "Guessed from the URL");
});

test("reference photos fill missing image slots without a text call and without touching existing images", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL });
  const first = await resume(draft.id, { details: "A product described by the owner" });
  // No photo and no source image: only views that need no reference can be planned.
  assert.ok(first.body.imageCompleteness.missing > 0);
  assert.equal(first.body.imageCompleteness.complete, false);
  const callsBefore = textCalls;

  const withPhoto = await resume(draft.id, { imageUrls: ["https://cdn.test/reference-1.jpg"] });

  assert.equal(textCalls, callsBefore, "adding a photo must not trigger paid text generation");
  const imgs = withPhoto.body.images;
  assert.ok(imgs.some((i) => i.url === "https://cdn.test/reference-1.jpg" && i.origin === "user"));
  assert.equal(imgs.length, 5, "the missing slots were rebuilt up to five");
  assert.equal(imgs.filter((i) => i.status === "pending").length, 4);

  const again = await asAdmin(`/api/admin/product-drafts/${draft.id}/rebuild-images`, { method: "POST", body: "{}" });
  assert.equal(again.body.addedSlots, 0, "rebuilding is idempotent");
  assert.equal(again.body.images.length, 5);
});

test("rebuilding keeps ready and failed images and only adds what is absent", async () => {
  const draft = await createDraft();               // five pending slots from the JSON-LD page
  const record = await ProductDraft.findById(draft.id);
  record.images[0].url = "https://cdn.test/done.jpg"; record.images[0].status = "ready"; record.images[0].origin = "ai";
  record.images[1].status = "failed"; record.images[1].error = "provider error";
  record.images.splice(3);                          // drop two slots to simulate a shortfall
  await record.save();

  const result = await asAdmin(`/api/admin/product-drafts/${draft.id}/rebuild-images`, { method: "POST", body: "{}" });
  const imgs = result.body.images;
  assert.equal(imgs.length, 5);
  assert.equal(imgs[0].url, "https://cdn.test/done.jpg", "the successful image is preserved");
  assert.equal(imgs[1].status, "failed", "a failure stays visible; retrying is the owner's call");
  assert.equal(result.body.addedSlots, 2);
});

test("a live listing cannot be re-sourced from the draft screen", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, { method: "POST", body: JSON.stringify({ confirm: true }) });
  const response = await resume(draft.id, { details: "New details" });
  assert.equal(response.status, 409, "changes to a live listing go through a pending revision");
});

test("category and brand are required for an active product, but not for a private draft", async () => {
  const active = new Product({ title: "x", slug: "req-active", imageUrl: "u", monthlyPrice: 1, isActive: true });
  await assert.rejects(() => active.validate(), /categoryId|brandId/);

  const draftProduct = new Product({ title: "x", slug: "req-draft", imageUrl: "u", monthlyPrice: 1, isActive: false });
  await assert.doesNotReject(() => draftProduct.validate());

  const viaRoute = await asAdmin("/api/admin/products", {
    method: "POST", body: JSON.stringify({ title: "No taxonomy", slug: "no-taxonomy", imageUrl: "u", monthlyPrice: 5, isActive: true }),
  });
  assert.equal(viaRoute.status, 400, "the manual/CSV create route still demands both");
});

test("a draft whose model proposed only two views reaches five once the owner adds a photo", async () => {
  const draft = await createDraft({ sourceUrl: DENIED_URL });
  await resume(draft.id, { details: "A product described by the owner" });
  const record = await ProductDraft.findById(draft.id);
  record.imageBriefs = [{ role: "hero", prompt: "front", requiresReference: false }, { role: "detail", prompt: "panel", requiresReference: true }];
  record.images = [
    { url: "https://cdn.test/g1.jpg", origin: "ai", role: "hero", status: "ready" },
    { url: "https://cdn.test/g2.jpg", origin: "ai", role: "detail", status: "ready" },
  ];
  await record.save();
  const callsBefore = textCalls;

  const result = await resume(draft.id, { imageUrls: ["https://cdn.test/owner.jpg"] });

  assert.equal(textCalls, callsBefore, "no paid text call");
  assert.equal(result.body.images.length, 5);
  assert.deepEqual(result.body.images.slice(0, 2).map((i) => i.url), ["https://cdn.test/g1.jpg", "https://cdn.test/g2.jpg"], "generated images preserved");
  assert.equal(result.body.images.filter((i) => i.status === "pending").length, 2);
  assert.equal(result.body.imageCompleteness.ready, 3);
});

// ---------------------------------------------------------------------------
// Refreshing a published listing from its source -> a reviewable pending revision
// ---------------------------------------------------------------------------

const RICH_PAGE = `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Sony Alpha 7 IV","brand":{"name":"Sony"},"category":"Cameras","description":"Full-frame camera."}</script></head><body>
<h3>Standardinformationen</h3><ul><li>Gewicht: 658 g</li><li>Garantie: 24 Monate</li></ul></body></html>`;

test("a published listing can be refreshed from its source without changing what is live", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  const published = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, { method: "POST", body: JSON.stringify({ confirm: true }) });
  const slug = published.body.draft.product.slug;
  const liveBefore = await call(`/api/products/${slug}`);
  const liveSpecKeys = liveBefore.body.specifications.map((x) => x.key).sort();
  assert.ok(!liveSpecKeys.includes("Gewicht"), "the live listing does not have the new specs yet");

  // The page has since gained spec lists (or the extractor improved).
  await ProductDraft.updateOne({ _id: draft.id }, { $set: { sourceUrl: "https://example.com/rich" } });
  const callsBefore = textCalls;
  const refreshed = await asAdmin(`/api/admin/product-drafts/${draft.id}/regenerate-text`, { method: "POST", body: JSON.stringify({ reextract: true }) });

  assert.equal(refreshed.status, 200);
  assert.equal(textCalls, callsBefore + 1, "exactly one text generation");
  assert.deepEqual(refreshed.body.provenance.extractedFacts.specifications.map((s) => s.key), ["Gewicht", "Garantie"], "source data was refreshed");

  const proposed = refreshed.body.pendingRevision.proposed;
  assert.ok(proposed, "the owner can see what approving would publish");
  assert.deepEqual(proposed.specifications.map((s) => s.key), ["Gewicht", "Garantie"]);

  const liveAfter = await call(`/api/products/${slug}`);
  assert.deepEqual(liveAfter.body.specifications, liveBefore.body.specifications, "the live listing is unchanged until approval");
  assert.equal(liveAfter.body.title, liveBefore.body.title);
});

test("a failed re-read never replaces source data that already worked", async () => {
  const draft = await createDraft();
  const before = (await asAdmin(`/api/admin/product-drafts/${draft.id}`)).body.provenance.extractedFacts.name;

  await ProductDraft.updateOne({ _id: draft.id }, { $set: { sourceUrl: DENIED_URL } });
  const result = await asAdmin(`/api/admin/product-drafts/${draft.id}/regenerate-text`, { method: "POST", body: JSON.stringify({ reextract: true }) });

  assert.equal(result.body.provenance.extractedFacts.name, before, "good source data is kept");
});

test("adding the owner's photo to a published listing plans the missing views as a pending revision, free of charge", async () => {
  const draft = await createDraft();
  await makePublishable(draft.id);
  const published = await asAdmin(`/api/admin/product-drafts/${draft.id}/publish`, { method: "POST", body: JSON.stringify({ confirm: true }) });
  const slug = published.body.draft.product.slug;
  const liveBefore = await call(`/api/products/${slug}`);

  const record = await ProductDraft.findById(draft.id);
  record.imageBriefs = [{ role: "hero", prompt: "front", requiresReference: false }];
  record.images = [{ url: "https://cdn.test/own-photo.jpg", origin: "user", role: "user-upload", status: "ready" }];
  await record.save();
  const callsBefore = textCalls;

  const added = await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, { method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/second-owner-photo.jpg" }) });

  assert.equal(added.status, 200);
  assert.equal(textCalls, callsBefore, "no provider call: planning slots is free");
  assert.equal(added.body.images.length, 5, "the set is topped up to five slots");
  assert.equal(added.body.images.filter((i) => i.status === "pending").length, 3, "three views are waiting for a deliberate generate");
  assert.equal(added.body.pendingRevision.hasChanges, true);

  const liveAfter = await call(`/api/products/${slug}`);
  assert.equal(liveAfter.body.imageUrl, liveBefore.body.imageUrl, "the live images do not change until approval");
});

test("adding a photo when every slot is planned replaces a never-generated slot, not a finished image", async () => {
  const draft = await createDraft();                 // five pending slots
  const record = await ProductDraft.findById(draft.id);
  record.images[0].url = "https://cdn.test/done.jpg"; record.images[0].status = "ready"; record.images[0].origin = "ai";
  await record.save();

  const added = await asAdmin(`/api/admin/product-drafts/${draft.id}/images`, { method: "PATCH", body: JSON.stringify({ action: "add", url: "https://cdn.test/mine.jpg" }) });

  assert.equal(added.status, 200);
  assert.equal(added.body.images.length, 5);
  assert.ok(added.body.images.some((i) => i.url === "https://cdn.test/done.jpg"), "the finished image is preserved");
  assert.ok(added.body.images.some((i) => i.url === "https://cdn.test/mine.jpg" && i.origin === "user"));
});
