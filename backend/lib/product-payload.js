"use strict";

// Canonical mapping from "what we know about a product" to a Leihfluss Product
// payload. All three creation paths (manual, CSV/XLSX, product-link + AI) write
// through POST /api/admin/products; this module holds the normalisation those
// paths should agree on — slug, rental price mapping, category/brand matching.

const RESERVED_SLUGS = new Set(["new", "edit", "create", "admin", "api"]);

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

function buildSlug(parts, fallbackSeed) {
  const base = slugify(parts.filter(Boolean).join(" "));
  if (base && !RESERVED_SLUGS.has(base)) return base;
  return `produkt-${String(fallbackSeed || Date.now()).slice(-8)}`;
}

function toMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100) / 100;
}

/**
 * Maps the admin's two rental inputs onto the existing Leihfluss price fields.
 *
 * The storefront ladder is: offer price (when it undercuts the buyer price) ->
 * buyer price -> monthlyPrice as a shared legacy fallback. The admin gives a
 * single rental rate per period, so it goes in the *buyer* slot and the offer
 * slot stays empty (no fake discount). `monthlyPrice` mirrors the monthly rate
 * so the legacy fallback can never resolve to something cheaper.
 *
 * A retailer's purchase price is NEVER an input here.
 */
function mapRentalPricing({ weeklyPrice, monthlyPrice }) {
  const weekly = toMoney(weeklyPrice);
  const monthly = toMoney(monthlyPrice);

  return {
    buyerPrice: weekly,
    offerPrice: 0,
    monthlyBuyerPrice: monthly,
    monthlyOfferPrice: 0,
    monthlyPrice: monthly,
    weeklyAutoDiscount: 0,
    monthlyAutoDiscount: 0,
  };
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Matches against existing categories only. Never invents one: an uncertain or
 * absent match is reported so the admin can decide.
 * @returns {{categoryId: string|null, confidence: "high"|"medium"|"low", reason: string}}
 */
function matchCategory(candidateName, categories, suggestedId) {
  if (suggestedId) {
    const byId = categories.find((c) => String(c.id) === String(suggestedId));
    if (byId) return { categoryId: byId.id, confidence: "high", reason: "model selected an existing category" };
  }

  const needle = normalizeKey(candidateName);
  if (!needle) return { categoryId: null, confidence: "low", reason: "no category hint available" };

  const exact = categories.find(
    (c) => normalizeKey(c.nameEn) === needle || normalizeKey(c.nameDe) === needle || normalizeKey(c.slug) === needle
  );
  if (exact) return { categoryId: exact.id, confidence: "high", reason: "exact name match" };

  const partial = categories.find((c) => {
    const en = normalizeKey(c.nameEn);
    const de = normalizeKey(c.nameDe);
    return (en && (en.includes(needle) || needle.includes(en))) || (de && (de.includes(needle) || needle.includes(de)));
  });
  if (partial) return { categoryId: partial.id, confidence: "medium", reason: "partial name match" };

  return { categoryId: null, confidence: "low", reason: "no existing category matched" };
}

/** Same contract as matchCategory. Never creates a brand. */
function matchBrand(candidateName, brands, suggestedId) {
  if (suggestedId) {
    const byId = brands.find((b) => String(b.id) === String(suggestedId));
    if (byId) return { brandId: byId.id, brandName: byId.name, confidence: "high", reason: "model selected an existing brand" };
  }

  const needle = normalizeKey(candidateName);
  if (!needle) return { brandId: null, brandName: "", confidence: "low", reason: "no brand hint available" };

  const exact = brands.find((b) => normalizeKey(b.name) === needle || normalizeKey(b.slug) === needle);
  if (exact) return { brandId: exact.id, brandName: exact.name, confidence: "high", reason: "exact name match" };

  const partial = brands.find((b) => {
    const key = normalizeKey(b.name);
    return key && (key.includes(needle) || needle.includes(key));
  });
  if (partial) return { brandId: partial.id, brandName: partial.name, confidence: "medium", reason: "partial name match" };

  return { brandId: null, brandName: String(candidateName || ""), confidence: "low", reason: "no existing brand matched" };
}

/**
 * Builds the Product payload for an AI draft. Always `isActive: false`:
 * publication is a separate, explicitly authorised action.
 */
function buildDraftProductPayload({ listing, pricing, categoryId, brandId, brandName, images, slug }) {
  const gallery = images.map((image) => image.url).filter(Boolean);
  const primary = gallery[0] || "";

  return {
    title: listing.titleDe || listing.titleEn || "Entwurf",
    titleI18n: { en: listing.titleEn || "", de: listing.titleDe || "" },
    slug,
    description: listing.descriptionDe || listing.descriptionEn || "",
    descriptionI18n: { en: listing.descriptionEn || "", de: listing.descriptionDe || "" },
    shortDescription: listing.shortDescriptionDe || listing.shortDescriptionEn || "",
    shortDescriptionI18n: { en: listing.shortDescriptionEn || "", de: listing.shortDescriptionDe || "" },
    imageUrl: primary,
    galleryImages: gallery.slice(1),
    sku: listing.sku || "",
    brand: brandName || listing.brandName || "",
    brandId,
    categoryId,
    tags: Array.isArray(listing.tags) ? listing.tags.slice(0, 20).map(String) : [],
    specifications: Array.isArray(listing.specifications)
      ? listing.specifications
          .filter((spec) => spec?.key && spec?.value)
          .slice(0, 40)
          .map((spec) => ({ key: String(spec.key), value: String(spec.value) }))
      : [],
    seo: {
      metaTitle: listing.seo?.metaTitle || "",
      metaDescription: listing.seo?.metaDescription || "",
      metaKeywords: Array.isArray(listing.seo?.metaKeywords) ? listing.seo.metaKeywords.map(String).slice(0, 20) : [],
      canonicalUrl: "",
      ogTitle: listing.seo?.ogTitle || "",
      ogDescription: listing.seo?.ogDescription || "",
      ogImageUrl: primary,
    },
    ...pricing,
    // Leihfluss defaults. Commercial terms are never inferred by the model.
    stock: 0,
    stockStatus: "in_stock",
    lowStockWarning: 5,
    maxRentalQuantity: 1,
    unit: "piece",
    weightKg: 0,
    minimumRentalWeeks: 1,
    maximumRentalWeeks: 4,
    minimumRentalMonths: 1,
    maximumRentalMonths: 24,
    minimumRentalDays: 7,
    maximumRentalDays: 30,
    rentalPeriodUnit: "week",
    deliveryFee: 0,
    verificationRequired: true,
    depositEnabled: false,
    securityDeposit: 0,
    replacementValue: 0,
    refundable: true,
    isMostPopular: false,
    // A draft is never publicly visible.
    isActive: false,
  };
}

module.exports = {
  buildDraftProductPayload,
  buildSlug,
  mapRentalPricing,
  matchBrand,
  matchCategory,
  slugify,
  toMoney,
};
