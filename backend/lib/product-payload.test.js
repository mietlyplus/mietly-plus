"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDraftProductPayload, buildSlug, mapRentalPricing, matchBrand, matchCategory, slugify,
} = require("./product-payload");

const CATEGORIES = [
  { id: "c1", nameEn: "Cameras", nameDe: "Kameras", slug: "cameras" },
  { id: "c2", nameEn: "Power Tools", nameDe: "Elektrowerkzeuge", slug: "power-tools" },
];
const BRANDS = [
  { id: "b1", name: "Sony", slug: "sony" },
  { id: "b2", name: "Bosch", slug: "bosch" },
];

test("the admin's rental rates map onto the existing price fields", () => {
  const pricing = mapRentalPricing({ weeklyPrice: 29.9, monthlyPrice: 89 });
  assert.equal(pricing.buyerPrice, 29.9, "weekly -> buyerPrice");
  assert.equal(pricing.monthlyBuyerPrice, 89, "monthly -> monthlyBuyerPrice");
  assert.equal(pricing.monthlyPrice, 89, "legacy fallback mirrors the monthly rate");
  assert.equal(pricing.offerPrice, 0, "no fake discount is invented");
  assert.equal(pricing.monthlyOfferPrice, 0);
});

test("a retailer purchase price can never reach the rental fields", () => {
  // mapRentalPricing has no parameter for it; anything extra is ignored.
  const pricing = mapRentalPricing({
    weeklyPrice: 10, monthlyPrice: 30,
    retailerPrice: 2499, price: 2499, buyerPrice: 2499, monthlyBuyerPrice: 2499,
  });
  assert.equal(pricing.buyerPrice, 10);
  assert.equal(pricing.monthlyBuyerPrice, 30);
  assert.equal(pricing.monthlyPrice, 30);
  assert.ok(!Object.values(pricing).includes(2499), "the retailer price must not appear anywhere");
});

test("weekly and monthly rates never cross over", () => {
  const pricing = mapRentalPricing({ weeklyPrice: 15, monthlyPrice: 45 });
  assert.equal(pricing.buyerPrice, 15);
  assert.notEqual(pricing.buyerPrice, pricing.monthlyBuyerPrice);
  assert.equal(pricing.monthlyBuyerPrice, 45);
});

test("negative and junk prices floor at zero rather than inverting", () => {
  for (const bad of [-5, "abc", null, undefined, NaN]) {
    const pricing = mapRentalPricing({ weeklyPrice: bad, monthlyPrice: bad });
    assert.equal(pricing.buyerPrice, 0);
    assert.equal(pricing.monthlyBuyerPrice, 0);
  }
});

test("prices are rounded to cents", () => {
  const pricing = mapRentalPricing({ weeklyPrice: 19.999, monthlyPrice: 59.001 });
  assert.equal(pricing.buyerPrice, 20);
  assert.equal(pricing.monthlyBuyerPrice, 59);
});

test("German characters slugify predictably", () => {
  assert.equal(slugify("Bohrmaschine für Größe Öl"), "bohrmaschine-fuer-groesse-oel");
  assert.equal(slugify("Sony Alpha 7 IV"), "sony-alpha-7-iv");
  assert.equal(slugify("!!!"), "");
});

test("a slug always falls back to something usable", () => {
  assert.match(buildSlug([""], "abcd1234"), /^produkt-/);
  assert.match(buildSlug(["admin"], "abcd1234"), /^produkt-/, "reserved slugs are avoided");
  assert.equal(buildSlug(["Sony", "Alpha 7"], "x"), "sony-alpha-7");
});

test("an exact category name matches with high confidence", () => {
  const match = matchCategory("Cameras", CATEGORIES, null);
  assert.equal(match.categoryId, "c1");
  assert.equal(match.confidence, "high");
});

test("category matching is case and spacing insensitive", () => {
  assert.equal(matchCategory("power tools", CATEGORIES, null).categoryId, "c2");
  assert.equal(matchCategory("PowerTools", CATEGORIES, null).categoryId, "c2");
  assert.equal(matchCategory("Kameras", CATEGORIES, null).categoryId, "c1", "German name matches too");
});

test("a model-supplied category id wins when it exists", () => {
  const match = matchCategory("something else", CATEGORIES, "c2");
  assert.equal(match.categoryId, "c2");
  assert.equal(match.confidence, "high");
});

test("an unknown category is reported, never invented", () => {
  const match = matchCategory("Submarines", CATEGORIES, null);
  assert.equal(match.categoryId, null);
  assert.equal(match.confidence, "low");
});

test("a hallucinated category id does not create anything", () => {
  const match = matchCategory("", CATEGORIES, "does-not-exist");
  assert.equal(match.categoryId, null, "an unknown id must not be trusted");
});

test("brand matching mirrors category matching and never invents a brand", () => {
  assert.equal(matchBrand("Sony", BRANDS, null).brandId, "b1");
  assert.equal(matchBrand("SONY", BRANDS, null).brandId, "b1");
  assert.equal(matchBrand("Bosch Professional", BRANDS, null).confidence, "medium", "partial match");

  const unknown = matchBrand("Wibble", BRANDS, null);
  assert.equal(unknown.brandId, null);
  assert.equal(unknown.brandName, "Wibble", "the name is kept for the admin to resolve");
});

test("a draft payload is always inactive and carries no invented commercial terms", () => {
  const payload = buildDraftProductPayload({
    listing: {
      titleDe: "Sony Alpha 7 IV mieten", titleEn: "Rent the Sony Alpha 7 IV",
      descriptionDe: "Beschreibung", descriptionEn: "Description",
      shortDescriptionDe: "Kurz", shortDescriptionEn: "Short",
      brandName: "Sony", sku: "A7M4", tags: ["kamera"],
      specifications: [{ key: "Sensor", value: "33 MP" }],
      seo: { metaTitle: "t", metaDescription: "d", metaKeywords: ["k"], ogTitle: "o", ogDescription: "od" },
    },
    pricing: mapRentalPricing({ weeklyPrice: 29, monthlyPrice: 89 }),
    categoryId: "c1", brandId: "b1", brandName: "Sony",
    images: [{ url: "https://cdn.test/1.jpg" }, { url: "https://cdn.test/2.jpg" }],
    slug: "sony-alpha-7-iv",
  });

  assert.equal(payload.isActive, false, "a draft is never public");
  assert.equal(payload.imageUrl, "https://cdn.test/1.jpg");
  assert.deepEqual(payload.galleryImages, ["https://cdn.test/2.jpg"]);
  assert.equal(payload.buyerPrice, 29);
  assert.equal(payload.monthlyBuyerPrice, 89);

  // Commercial terms are Leihfluss defaults, never model output.
  assert.equal(payload.depositEnabled, false);
  assert.equal(payload.securityDeposit, 0);
  assert.equal(payload.replacementValue, 0);
  assert.equal(payload.deliveryFee, 0);
  assert.equal(payload.stock, 0);
  assert.equal(payload.isMostPopular, false);
});

test("only source-backed specifications survive into the payload", () => {
  const payload = buildDraftProductPayload({
    listing: {
      titleDe: "x", specifications: [
        { key: "Sensor", value: "33 MP" },
        { key: "", value: "orphan value" },
        { key: "Weight", value: "" },
      ],
      seo: {},
    },
    pricing: mapRentalPricing({ weeklyPrice: 1, monthlyPrice: 2 }),
    categoryId: "c1", brandId: "b1", brandName: "Sony",
    images: [], slug: "x",
  });

  assert.deepEqual(payload.specifications, [{ key: "Sensor", value: "33 MP" }]);
});
