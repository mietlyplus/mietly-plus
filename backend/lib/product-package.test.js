const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateProductPackage, buildPackageProductPayload } = require("./product-package");
const { normalizeDailyRate, dailyRateFromLegacyOptions, occasionTotal } = require("./occasion-pricing");

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

test("the documented occasion example validates with a daily rate", () => {
  const result = validateProductPackage(example("package-occasion.json"));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.package.pricing.daily, 50);
  assert.equal(occasionTotal(50, 3), 150);
  const payload = buildPackageProductPayload(result.package, { categoryId: null, brandId: null, brandName: "", images: [], slug: "h" });
  assert.equal(payload.rentalPeriodUnit, "day");
  assert.equal(payload.maximumRentalDays, 7);
  assert.equal(payload.buyerPrice, 0);
  assert.equal(payload.occasionDailyRate, 50);
  assert.deepEqual(payload.occasionPricing, []);
});

test("a package that still lists per-length occasion prices is converted to a daily rate with a warning", () => {
  const legacy = example("package-occasion.json");
  legacy.pricing = { occasion: [{ days: 1, price: 50 }, { days: 2, price: 80 }] };
  const result = validateProductPackage(legacy);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.package.pricing.daily, 50);
  assert.ok(result.warnings.some((w) => w.includes("daily rate")));
});

test("invalid packages are rejected with useful messages instead of becoming products", () => {
  const bad = validateProductPackage({ schema: "wrong", rentalMode: "occasion", titles: {}, pricing: { daily: 0 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("schema")));
  assert.ok(bad.errors.some((e) => e.includes("title")));
  assert.ok(bad.errors.some((e) => e.includes("daily rental price")));
  assert.equal(validateProductPackage({ schema: "leihfluss.product-package/1", titles: { de: "X" }, pricing: { weekly: 10 } }).ok, false, "standard needs a monthly price");
  assert.equal(validateProductPackage("nope").ok, false);
});

test("a daily rate must be a positive amount and legacy lists convert predictably", () => {
  for (const bad of [0, -5, "abc", undefined, null, ""]) assert.ok(normalizeDailyRate(bad).errors.length > 0, String(bad));
  assert.equal(normalizeDailyRate("49.999").rate, 50);
  assert.equal(dailyRateFromLegacyOptions([{ days: 1, price: 50 }, { days: 3, price: 105 }]).rate, 50);
  assert.equal(dailyRateFromLegacyOptions([{ days: 2, price: 80 }]).rate, 40);
  assert.ok(dailyRateFromLegacyOptions([]).errors.length > 0);
  assert.equal(occasionTotal(50, 7), 350);
});

test("licensed images without a license and images without alt text produce warnings, not failures", () => {
  const pkg = example("package-standard.json");
  pkg.images = [{ url: "https://cdn.example/a.jpg", origin: "licensed_asset" }];
  const result = validateProductPackage(pkg);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("license")));
  assert.ok(result.warnings.some((w) => w.includes("alt text")));
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

test("a complete standard package keeps stock, verification, deposit, delivery, offers and display settings; always private", () => {
  const pkg = example("package-standard.json");
  pkg.inventory = { stock: 2, stockStatus: "low_stock", lowStockWarning: 1, maxRentalQuantity: 2, unit: "set", weightKg: 18.3 };
  pkg.rental = { minWeeks: 2, maxWeeks: 6, minMonths: 2, maxMonths: 12 };
  pkg.delivery = { leadDays: 5, fee: 9.9 };
  pkg.risk = { verificationRequired: false, depositEnabled: true, securityDeposit: 100, replacementValue: 250, refundable: false };
  pkg.pricing = { weekly: 15, monthly: 40, weeklyOffer: 12, monthlyOffer: 35 };
  pkg.display = { isMostPopular: true };
  const result = validateProductPackage(pkg);
  assert.equal(result.ok, true, result.errors.join("; "));
  const p = buildPackageProductPayload(result.package, { categoryId: "c", brandId: "b", brandName: "Medion", images: [], slug: "s" });
  assert.equal(p.isActive, false);
  assert.deepEqual([p.stock, p.stockStatus, p.lowStockWarning, p.maxRentalQuantity, p.unit, p.weightKg], [2, "low_stock", 1, 2, "set", 18.3]);
  assert.deepEqual([p.minimumRentalWeeks, p.maximumRentalWeeks, p.minimumRentalMonths, p.maximumRentalMonths], [2, 6, 2, 12]);
  assert.deepEqual([p.deliveryLeadDays, p.deliveryFee], [5, 9.9]);
  assert.deepEqual([p.verificationRequired, p.depositEnabled, p.securityDeposit, p.replacementValue, p.refundable], [false, true, 100, 250, false]);
  assert.deepEqual([p.buyerPrice, p.offerPrice, p.monthlyBuyerPrice, p.monthlyOfferPrice], [15, 12, 40, 35]);
  assert.equal(p.isMostPopular, true);
});

test("a basic package without the new sections keeps the old defaults and stays private", () => {
  const result = validateProductPackage(example("package-standard.json"));
  const p = buildPackageProductPayload(result.package, { categoryId: null, brandId: null, brandName: "", images: [], slug: "s" });
  assert.equal(p.isActive, false);
  assert.deepEqual([p.stock, p.verificationRequired, p.depositEnabled, p.deliveryFee, p.maxRentalQuantity], [0, true, false, 0, 1]);
  assert.equal("deliveryLeadDays" in p, false, "the product default lead time applies");
});

test("an occasion package still works with the new sections, and bad optional values are ignored with a warning", () => {
  const pkg = example("package-occasion.json");
  pkg.inventory = { stock: 3, stockStatus: "nonsense" };
  pkg.risk = { depositEnabled: "maybe" };
  const result = validateProductPackage(pkg);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.ok(result.warnings.some((w) => w.includes("stockStatus")));
  assert.ok(result.warnings.some((w) => w.includes("depositEnabled")));
  const p = buildPackageProductPayload(result.package, { categoryId: null, brandId: null, brandName: "", images: [], slug: "s" });
  assert.equal(p.stock, 3);
  assert.equal(p.stockStatus, "in_stock");
  assert.equal(p.depositEnabled, false);
  assert.equal(p.occasionDailyRate, 50);
});

test("category matching is exact and hierarchy-aware; ambiguous or partial names stay unresolved", () => {
  const { matchCategoryExact, matchBrandExact } = require("./product-payload");
  const cats = [
    { id: "1", nameEn: "Home", nameDe: "Haushalt", slug: "home", parentId: null },
    { id: "2", nameEn: "Kitchen", nameDe: "Küche", slug: "kitchen", parentId: "1" },
    { id: "3", nameEn: "Party", nameDe: "Feiern", slug: "party", parentId: null },
    { id: "4", nameEn: "Kitchen", nameDe: "Küche", slug: "party-kitchen", parentId: "3" },
  ];
  assert.equal(matchCategoryExact(["Haushalt", "Küche"], cats).categoryId, "2");
  assert.equal(matchCategoryExact("Feiern > Küche", cats).categoryId, "4");
  assert.equal(matchCategoryExact("Küche", cats).resolved, false, "same name under two parents is ambiguous");
  assert.equal(matchCategoryExact("Feiern", cats).categoryId, "3");
  assert.equal(matchCategoryExact("Kitch", cats).resolved, false, "no partial matching");
  assert.equal(matchCategoryExact(["Feiern", "Haushalt"], cats).resolved, false);
  const brands = [{ id: "b", name: "Medion", slug: "medion" }];
  assert.equal(matchBrandExact("medion", brands).brandId, "b");
  assert.equal(matchBrandExact("Medi", brands).resolved, false);
});
