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

test("delivery lead time: exact Europe/Berlin calendar rule, no tolerance", () => {
  const { parseDeliveryLeadDays, checkStartDates, earliestStartDate, berlinToday } = require("./delivery-lead-time");
  assert.equal(parseDeliveryLeadDays(0), 0);
  assert.equal(parseDeliveryLeadDays("5"), 5);
  assert.equal(parseDeliveryLeadDays(31), null);
  assert.equal(parseDeliveryLeadDays(1.5), null);
  assert.equal(parseDeliveryLeadDays(-1), null);

  // 23:30 UTC on 20 Nov is already 00:30 on 21 Nov in Berlin (UTC+1).
  const lateUtc = new Date("2026-11-20T23:30:00Z");
  assert.equal(berlinToday(lateUtc), "2026-11-21");
  assert.equal(earliestStartDate(0, lateUtc), "2026-11-21", "0 = today");
  assert.equal(earliestStartDate(1, lateUtc), "2026-11-22", "1 = tomorrow");
  assert.equal(earliestStartDate(2, lateUtc), "2026-11-23", "2 = day after tomorrow");
  // Summer time (UTC+2): 22:30 UTC on 20 Jun is 00:30 on 21 Jun in Berlin.
  assert.equal(berlinToday(new Date("2026-06-20T22:30:00Z")), "2026-06-21");
  assert.equal(berlinToday(new Date("2026-06-20T21:30:00Z")), "2026-06-20");
  // Across the March DST change and a month end the arithmetic is still calendar days.
  assert.equal(earliestStartDate(2, new Date("2026-03-28T12:00:00Z")), "2026-03-30");
  assert.equal(earliestStartDate(3, new Date("2026-12-30T12:00:00Z")), "2027-01-02");

  const now = new Date("2026-11-20T12:00:00Z"); // Berlin 13:00, 20 Nov
  const products = new Map([["a", { title: "A", deliveryLeadDays: 3 }], ["b", { title: "B" }], ["z", { title: "Z", deliveryLeadDays: 0 }]]);
  const line = (productId, startDate) => ({ productId, startDate });
  assert.equal(checkStartDates([line("a", "2026-11-23")], products, now), null, "today + 3 is allowed");
  assert.match(checkStartDates([line("a", "2026-11-22")], products, now), /3 day/, "one day short is refused, no tolerance");
  assert.equal(checkStartDates([line("b", "2026-11-22")], products, now), null, "unset lead time defaults to 2");
  assert.match(checkStartDates([line("b", "2026-11-21")], products, now), /2 day/);
  assert.equal(checkStartDates([line("z", "2026-11-20")], products, now), null, "0 = today is allowed");
  assert.match(checkStartDates([line("z", "2026-11-19")], products, now), /earliest/);
  assert.match(checkStartDates([line("a", "not-a-date")], products, now), /not valid/);
  assert.equal(checkStartDates([line("zz", "2026-01-01"), { productId: "a" }], products, now), null, "unknown product / no date left to other checks");
});

test("the storefront date helper gives the same answers as the backend rule", async () => {
  const fs = require("node:fs");
  const ts = fs.readFileSync(path.join(__dirname, "../../frontend/lib/delivery-date.ts"), "utf8");
  const { stripTypeScriptTypes } = require("node:module");
  const js = stripTypeScriptTypes(ts).replace(/export function/g, "function");
  const front = new Function(`${js}; return { earliestStartDate, berlinToday, addDaysToDateString };`)();
  const back = require("./delivery-lead-time");
  for (const iso of ["2026-11-20T23:30:00Z", "2026-06-20T22:30:00Z", "2026-03-28T12:00:00Z", "2026-12-30T12:00:00Z", "2026-10-24T22:30:00Z"]) {
    for (const lead of [0, 1, 2, 5, 30]) {
      assert.equal(front.earliestStartDate(lead, new Date(iso)), back.earliestStartDate(lead, new Date(iso)), `${iso} +${lead}`);
    }
  }
});
