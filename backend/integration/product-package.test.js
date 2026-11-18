// AI Product Queue: prepared JSON packages become private drafts, never live
// products, and occasion (day-based) products publish and serve correctly.
process.env.JWT_SECRET = process.env.JWT_SECRET || "integration-secret";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { MongoMemoryServer } = require("mongodb-memory-server");

const ROOT = path.join(__dirname, "..");
const app = require(path.join(ROOT, "index.js"));
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Admin = require(path.join(ROOT, "models/Admin"));
const Product = require(path.join(ROOT, "models/Product"));
const Category = require(path.join(ROOT, "models/Category"));
const Brand = require(path.join(ROOT, "models/Brand"));

const example = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "../docs/examples", name), "utf8"));
const HOSTED = "https://res.cloudinary.com/example/image/upload/photo.jpg";

let mongod; let server; let base; let token;

async function call(pathname, options = {}, auth = true) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const raw = await response.text();
  let body; try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: response.status, body };
}
const post = (p, b) => call(p, { method: "POST", body: JSON.stringify(b) });

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB_NAME = "leihfluss_package_it";
  await app.initializeApp();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await Category.create({ name: { en: "Kitchen", de: "Küche" }, slug: "kitchen" });
  await Brand.create({ name: "Medion", slug: "medion", isActive: true });
  const admin = await Admin.create({ name: "IT", email: "pkg@test.example", passwordHash: "x" });
  token = jwt.sign({ sub: String(admin._id), email: admin.email, role: "admin", name: "IT" }, process.env.JWT_SECRET);
});

test.after(async () => { server?.close(); await mongoose.disconnect(); await mongod?.stop(); });

test("packages are validated into a queue; invalid ones cannot be imported", async () => {
  const standard = example("package-standard.json");
  standard.images[0].url = HOSTED;
  const occasion = example("package-occasion.json");
  occasion.images = [{ url: HOSTED, origin: "owner_photo", altDe: "Hüpfburg", primary: true }];
  const invalid = { schema: "leihfluss.product-package/1", externalId: "broken", titles: { de: "Kaputt" }, pricing: { weekly: 5 } };

  const submitted = await post("/api/admin/product-packages", { packages: [standard, occasion, invalid] });
  assert.equal(submitted.status, 201);
  assert.deepEqual(submitted.body.results.map((r) => r.status), ["ready", "ready", "invalid"]);

  const list = await call("/api/admin/product-packages");
  const broken = list.body.items.find((i) => i.externalId === "broken");
  const imported = await post("/api/admin/product-packages/import", { ids: [broken.id] });
  assert.equal(imported.body.imported.length, 0, "an invalid package never imports");
  assert.equal(await Product.countDocuments({ isActive: { $ne: false } }), 0);
});

test("import creates PRIVATE drafts, matches only clear category/brand, and is not repeatable", async () => {
  const result = await post("/api/admin/product-packages/import", { allReady: true });
  assert.equal(result.body.imported.length, 2);
  assert.equal(result.body.remaining, 0);

  const products = await Product.find({});
  assert.equal(products.length, 2);
  assert.ok(products.every((p) => p.isActive === false), "imported products are private");

  const microwave = products.find((p) => p.rentalMode === "standard");
  assert.ok(microwave.categoryId, "Kitchen matched exactly");
  assert.ok(microwave.brandId, "Medion matched exactly");
  assert.equal(microwave.buyerPrice, 15);
  assert.equal(microwave.monthlyBuyerPrice, 40);
  assert.equal(microwave.imageAlts[0].de, "Medion MD 15501 Mikrowelle von vorn");

  const castle = products.find((p) => p.rentalMode === "occasion");
  assert.ok(!castle.categoryId, "'Kinderfeiern' does not exist, so it is left for the owner to choose");
  assert.equal(castle.occasionPricing.length, 7);

  const again = await post("/api/admin/product-packages", { packages: [example("package-standard.json")] });
  assert.equal(again.body.results[0].status, "imported");
  assert.equal(await Product.countDocuments({}), 2, "re-sending an imported package does not duplicate it");
});

test("publication still needs explicit approval and taxonomy; occasion products need day prices, not weekly/monthly", async () => {
  const list = await call("/api/admin/product-packages");
  const microwaveItem = list.body.items.find((i) => i.externalId === "medion-md-15501");
  const castleItem = list.body.items.find((i) => i.externalId === "huepfburg-regenbogen");

  const noConfirm = await post(`/api/admin/product-drafts/${microwaveItem.importedDraftId}/publish`, {});
  assert.equal(noConfirm.status, 400);

  const published = await post(`/api/admin/product-drafts/${microwaveItem.importedDraftId}/publish`, { confirm: true });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const blocked = await post(`/api/admin/product-drafts/${castleItem.importedDraftId}/publish`, { confirm: true });
  assert.equal(blocked.status, 400);
  assert.ok(blocked.body.blockers.some((b) => b.includes("category")));
  assert.ok(!blocked.body.blockers.some((b) => b.includes("weekly")), "occasion products are not asked for weekly prices");

  const cat = await Category.create({ name: { en: "Kids Parties", de: "Kinderfeiern" }, slug: "kinderfeiern" });
  const brand = await Brand.create({ name: "Leihfluss", slug: "leihfluss", isActive: true });
  await Product.updateOne({ _id: castleItem.importedProductId }, { categoryId: cat._id, brandId: brand._id });
  const ok = await post(`/api/admin/product-drafts/${castleItem.importedDraftId}/publish`, { confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const live = await call("/api/products/huepfburg-leihfluss-huepfburg-regenbogen", {}, false);
  const bySlug = live.status === 200 ? live.body : (await call("/api/products", {}, false)).body.find?.((p) => p.rentalMode === "occasion");
  const served = bySlug?.product || bySlug;
  assert.equal(served.rentalMode, "occasion");
  assert.deepEqual(served.occasionPricing.slice(0, 2), [{ days: 1, price: 50 }, { days: 2, price: 80 }]);
});

test("catalog archive hides active products without deleting, leaves drafts alone, and can be restored", async () => {
  const { archiveActiveProducts, restoreFromBackup } = require(path.join(ROOT, "lib/catalog-archive"));
  const before = await Product.countDocuments({});
  const activeBefore = await Product.countDocuments({ isActive: true });
  assert.ok(activeBefore >= 2);
  const result = await archiveActiveProducts(Product);
  assert.equal(result.archived, activeBefore);
  assert.equal(await Product.countDocuments({}), before, "nothing is deleted");
  assert.equal(await Product.countDocuments({ isActive: true }), 0);
  const storefront = await call("/api/products", {}, false);
  assert.equal((Array.isArray(storefront.body) ? storefront.body : storefront.body.items || []).length, 0);
  await restoreFromBackup(Product, { activeProductIds: result.ids });
  assert.equal(await Product.countDocuments({ isActive: true }), activeBefore);
});

test("occasion prices can be changed, added and removed after import, with server-side validation", async () => {
  const castle = await Product.findOne({ rentalMode: "occasion" });
  const patch = (id, body) => call(`/api/admin/products/${id}/rental-terms`, { method: "PATCH", body: JSON.stringify(body) });

  const changed = await patch(castle._id, { occasionPricing: [{ days: 1, price: 60 }, { days: 2, price: 90 }, { days: 5, price: 140 }] });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.occasionPricing, [{ days: 1, price: 60 }, { days: 2, price: 90 }, { days: 5, price: 140 }]);
  assert.equal((await Product.findById(castle._id)).occasionPricing.length, 3, "removed options are really gone");

  for (const bad of [
    [{ days: 8, price: 10 }], [{ days: 0, price: 10 }], [{ days: 2, price: 0 }], [{ days: 2, price: -5 }],
    [{ days: 2, price: 10 }, { days: 2, price: 12 }], [],
  ]) {
    assert.equal((await patch(castle._id, { occasionPricing: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await Product.findById(castle._id)).occasionPricing.length, 3, "a rejected edit changes nothing");

  const standard = await Product.findOne({ rentalMode: "standard" });
  assert.equal((await patch(standard._id, { occasionPricing: [{ days: 1, price: 5 }] })).status, 400, "standard products take no day prices");
  const before = [standard.buyerPrice, standard.monthlyBuyerPrice];

  assert.equal((await patch(standard._id, { deliveryLeadDays: 4 })).body.deliveryLeadDays, 4, "lead time works for standard products");
  assert.equal((await patch(castle._id, { deliveryLeadDays: 1 })).body.deliveryLeadDays, 1, "and for occasion products");
  assert.equal((await patch(castle._id, { deliveryLeadDays: 99 })).status, 400);
  const after = await Product.findById(standard._id);
  assert.deepEqual([after.buyerPrice, after.monthlyBuyerPrice], before, "weekly/monthly prices untouched");
});

test("a failed import leaves no orphan product or draft and the package stays ready", async () => {
  const pkg = example("package-standard.json");
  pkg.externalId = "rollback-case";
  pkg.titles = { de: "Rollback Testgerät", en: "Rollback test device" };
  pkg.identity.model = "RB-1";
  pkg.images = [{ url: HOSTED, origin: "owner_photo", altDe: "x", primary: true }];
  await post("/api/admin/product-packages", { packages: [pkg] });

  const ProductDraft = require(path.join(ROOT, "models/ProductDraft"));
  const originalCreate = ProductDraft.create;
  const products = await Product.countDocuments({});
  const drafts = await ProductDraft.countDocuments({});
  ProductDraft.create = async () => { throw new Error("simulated database failure"); };
  let result;
  try {
    result = await post("/api/admin/product-packages/import", { allReady: true });
  } finally {
    ProductDraft.create = originalCreate;
  }
  assert.equal(result.body.imported.length, 0);
  assert.equal(result.body.failed.length, 1);
  assert.equal(await Product.countDocuments({}), products, "no orphan product");
  assert.equal(await ProductDraft.countDocuments({}), drafts);
  const list = await call("/api/admin/product-packages");
  assert.equal(list.body.items.find((i) => i.externalId === "rollback-case").status, "ready");

  const retry = await post("/api/admin/product-packages/import", { allReady: true });
  assert.equal(retry.body.imported.length, 1, "retry succeeds once the fault is gone");
});
