const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateProductPackage, buildPackageProductPayload } = require("./product-package");
const { normalizeOccasionOptions, occasionPriceForDays } = require("./occasion-pricing");

const example = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/examples", name), "utf8"));

test("the documented standard example validates and keeps weekly/monthly meaning", () => {
  const result = validateProductPackage(example("package-standard.json"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.package.images.length, 1, "a reference_only image is never a listing image");
  assert.equal(result.package.referenceImages.length, 1);
  const payload = buildPackageProductPayload(result.package, { categoryId: null, brandId: null, brandName: "Medion", images: [{ url: "https://x/y.jpg", altDe: "a", altEn: "b" }], slug: "medion-md-15501" });
  assert.equal(payload.isActive, false);
  assert.equal(payload.buyerPrice, 15);
  assert.equal(payload.monthlyBuyerPrice, 40);
  assert.equal(payload.rentalMode, "standard");
  assert.deepEqual(payload.imageAlts[0], { de: "a", en: "b" });
});

test("the documented occasion example validates with explicit non-linear prices", () => {
  const result = validateProductPackage(example("package-occasion.json"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.package.pricing.occasion.map((o) => [o.days, o.price]).slice(0, 3), [[1, 50], [2, 80], [3, 105]]);
  const payload = buildPackageProductPayload(result.package, { categoryId: null, brandId: null, brandName: "", images: [], slug: "h" });
  assert.equal(payload.rentalPeriodUnit, "day");
  assert.equal(payload.maximumRentalDays, 7);
  assert.equal(payload.buyerPrice, 0);
});

test("invalid packages are rejected with useful messages instead of becoming products", () => {
  const bad = validateProductPackage({ schema: "wrong", rentalMode: "occasion", titles: {}, pricing: { occasion: [{ days: 9, price: 10 }, { days: 2, price: 0 }] } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("schema")));
  assert.ok(bad.errors.some((e) => e.includes("title")));
  assert.ok(bad.errors.some((e) => e.includes("1 to 7")));
  assert.equal(validateProductPackage({ schema: "leihfluss.product-package/1", titles: { de: "X" }, pricing: { weekly: 10 } }).ok, false, "standard needs a monthly price");
  assert.equal(validateProductPackage("nope").ok, false);
});

test("occasion options reject duplicates, flag a cheaper longer rental, and look up exact days only", () => {
  const dup = normalizeOccasionOptions([{ days: 1, price: 50 }, { days: 1, price: 60 }]);
  assert.ok(dup.errors.length > 0);
  const odd = normalizeOccasionOptions([{ days: 1, price: 50 }, { days: 2, price: 40 }]);
  assert.equal(odd.errors.length, 0);
  assert.equal(odd.warnings.length, 1);
  const product = { occasionPricing: [{ days: 1, price: 50 }, { days: 3, price: 105 }] };
  assert.equal(occasionPriceForDays(product, 3), 105);
  assert.equal(occasionPriceForDays(product, 2), null);
});

test("licensed images without a license and images without alt text produce warnings, not failures", () => {
  const pkg = example("package-standard.json");
  pkg.images = [{ url: "https://cdn.example/a.jpg", origin: "licensed_asset" }];
  const result = validateProductPackage(pkg);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("license")));
  assert.ok(result.warnings.some((w) => w.includes("alt text")));
});

test("occasion checkout lines are re-priced from stored options and unsupported day counts are refused", () => {
  const { applyOccasionPricing } = require("./occasion-pricing");
  const products = new Map([["p1", { title: "Castle", rentalMode: "occasion", occasionPricing: [{ days: 1, price: 50 }, { days: 2, price: 80 }] }]]);
  const line = { productId: "p1", durationValue: 2, durationUnit: "day", unitPrice: 1, baseUnitPrice: 1, quantity: 2, lineDeposit: 0, lineSubtotal: 2, lineTotal: 2 };
  assert.equal(applyOccasionPricing([line], products), null);
  assert.equal(line.unitPrice, 80, "the browser's price is ignored");
  assert.equal(line.lineSubtotal, 160);
  assert.match(applyOccasionPricing([{ ...line, durationValue: 3 }], products), /not offered/);
  assert.match(applyOccasionPricing([{ ...line, durationUnit: "week", durationValue: 1 }], products), /not offered/);
  const standard = { productId: "p2", durationValue: 1, durationUnit: "week", unitPrice: 9, quantity: 1 };
  assert.equal(applyOccasionPricing([standard], new Map([["p2", { rentalMode: "standard" }]])), null);
  assert.equal(standard.unitPrice, 9, "standard pricing is untouched");
});
