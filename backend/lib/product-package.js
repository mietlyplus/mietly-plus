"use strict";

// The Leihfluss AI Product Package: a nested JSON document that ChatGPT Work (or
// any other preparer) produces, and Leihfluss validates and turns into a PRIVATE
// product draft. It is deliberately not a flat spreadsheet row: the number of
// specifications, images and sources varies per product, and new optional
// sections can be added without breaking older packages.
//
// Contract (schema "leihfluss.product-package/1"):
//   externalId      string   stable id for this product; re-sending replaces a not-yet-imported package
//   rentalMode      "standard" | "occasion"
//   identity        { brand, model, series, sku, identifiers:{ean,gtin,mpn}, category:{name} }
//   titles          { de, en }
//   descriptions    { shortDe, shortEn, longDe, longEn }
//   includedItems   [{ de, en, quantity }]            bundles / party packages
//   specifications  [{ key, value, keyEn?, valueEn? }] any number; keyEn/valueEn = English wording
//   delivery        { leadDays }                      optional, 0-30 (default 2)
//   tags            [string]
//   pricing         { weekly, monthly }               standard only
//                   { daily }                          occasion only (daily rate, 1-7 days; legacy { occasion:[{days,price}] } is converted)
//   seo             { metaTitle, metaDescription, keywords[], canonicalUrl, ogTitle, ogDescription }
//   images          [{ url | file, origin, role, altDe, altEn, license?, note?, primary? }]
//   sources         [{ type, url?, label?, note? }]   provenance
//   warnings        [{ message }]                      uncertain information, shown to the owner
//
// Nothing here publishes anything. Import always creates an inactive product.

const { normalizeDailyRate, dailyRateFromLegacyOptions, MAX_OCCASION_DAYS } = require("./occasion-pricing");
const { slugify, buildSlug, toMoney } = require("./product-payload");

const SCHEMA_ID = "leihfluss.product-package/1";
const RENTAL_MODES = ["standard", "occasion"];
const IMAGE_ORIGINS = ["owner_photo", "ai_generated", "licensed_asset", "reference_only"];
const SOURCE_TYPES = ["url", "pdf", "photo", "instruction", "other"];
const MAX_IMAGES = 12;
const MAX_SPECS = 80;

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates a package and returns a normalised copy. `errors` make the package
 * INVALID (it cannot be imported); `warnings` are shown but do not block.
 * @returns {{ok: boolean, errors: string[], warnings: string[], package: object|null}}
 */
function validateProductPackage(input) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["The package must be a JSON object."], warnings, package: null };
  }
  if (input.schema !== SCHEMA_ID) {
    errors.push(`"schema" must be "${SCHEMA_ID}".`);
  }

  const rentalMode = text(input.rentalMode || "standard");
  if (!RENTAL_MODES.includes(rentalMode)) errors.push(`"rentalMode" must be one of: ${RENTAL_MODES.join(", ")}.`);

  const identity = input.identity && typeof input.identity === "object" ? input.identity : {};
  const titles = input.titles && typeof input.titles === "object" ? input.titles : {};
  const descriptions = input.descriptions && typeof input.descriptions === "object" ? input.descriptions : {};
  const pricing = input.pricing && typeof input.pricing === "object" ? input.pricing : {};
  const seoIn = input.seo && typeof input.seo === "object" ? input.seo : {};

  const titleDe = text(titles.de, 200);
  const titleEn = text(titles.en, 200);
  if (!titleDe && !titleEn) errors.push("A title (titles.de or titles.en) is required.");
  else if (!titleDe) warnings.push("No German title. The storefront is German-first; add titles.de.");
  else if (!titleEn) warnings.push("No English title was provided.");

  const externalId = text(input.externalId, 120) || slugify(titleDe || titleEn);
  if (!externalId) errors.push('"externalId" is required (or provide a title to derive one).');

  // --- identity ---
  const brandName = text(identity.brand, 120);
  if (!brandName) warnings.push("No brand given. You will choose one when reviewing the draft.");
  const categoryName = text(identity.category?.name ?? identity.category, 120);
  if (!categoryName) warnings.push("No category given. You will choose one when reviewing the draft.");
  const identifiers = {
    ean: text(identity.identifiers?.ean, 32),
    gtin: text(identity.identifiers?.gtin, 32),
    mpn: text(identity.identifiers?.mpn, 64),
  };

  // --- descriptions ---
  const shortDe = text(descriptions.shortDe, 500);
  const shortEn = text(descriptions.shortEn, 500);
  const longDe = text(descriptions.longDe, 8000);
  const longEn = text(descriptions.longEn, 8000);
  if (!shortDe && !longDe && !shortEn && !longEn) warnings.push("No description was provided.");
  else if (!(longDe || longEn)) warnings.push("No long description was provided.");

  // --- specifications ---
  const specifications = [];
  list(input.specifications).slice(0, MAX_SPECS).forEach((spec, index) => {
    const key = text(spec?.key, 120);
    const value = text(spec?.value, 400);
    if (!key || !value) {
      warnings.push(`Specification ${index + 1} was skipped because it has no key or no value.`);
      return;
    }
    specifications.push({ key, value, keyEn: text(spec?.keyEn, 120), valueEn: text(spec?.valueEn, 400) });
  });
  if (list(input.specifications).length > MAX_SPECS) warnings.push(`Only the first ${MAX_SPECS} specifications are kept.`);

  // --- delivery lead time (optional; the product default is 2 days) ---
  let leadDays = null;
  if (input.delivery?.leadDays !== undefined) {
    const parsed = Number(input.delivery.leadDays);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 30) leadDays = parsed;
    else warnings.push("delivery.leadDays must be a whole number from 0 to 30 and was ignored.");
  }

  // --- pricing ---
  let weekly = 0;
  let monthly = 0;
  let dailyRate = 0;
  if (rentalMode === "occasion") {
    const result =
      pricing.daily === undefined && Array.isArray(pricing.occasion)
        ? dailyRateFromLegacyOptions(pricing.occasion)
        : { ...normalizeDailyRate(pricing.daily), warnings: [] };
    result.errors.forEach((message) => errors.push(message));
    result.warnings.forEach((message) => warnings.push(message));
    dailyRate = result.rate;
    if (pricing.weekly || pricing.monthly) warnings.push("Weekly/monthly prices are ignored for an occasion product.");
  } else if (rentalMode === "standard") {
    weekly = toMoney(pricing.weekly);
    monthly = toMoney(pricing.monthly);
    if (!(weekly > 0)) errors.push("A weekly rental price (pricing.weekly) greater than 0 is required.");
    if (!(monthly > 0)) errors.push("A monthly rental price (pricing.monthly) greater than 0 is required.");
    if (weekly > 0 && monthly > 0 && monthly > weekly * 5) {
      warnings.push("The monthly price is much higher than four weekly prices. Check both prices.");
    }
    if (pricing.daily !== undefined || pricing.occasion) warnings.push("The daily price is ignored for a standard product.");
  }

  // --- images ---
  const images = [];
  const referenceOnly = [];
  list(input.images).slice(0, MAX_IMAGES).forEach((image, index) => {
    const origin = text(image?.origin);
    const url = text(image?.url, 1000);
    const file = text(image?.file, 200);
    if (!IMAGE_ORIGINS.includes(origin)) {
      warnings.push(`Image ${index + 1} was skipped: "origin" must be one of ${IMAGE_ORIGINS.join(", ")}.`);
      return;
    }
    if (origin === "reference_only") {
      // Never becomes a listing image: retailer photos are not assumed publishable.
      if (url) referenceOnly.push({ url, note: text(image?.note, 300) });
      return;
    }
    if (!url && !file) {
      warnings.push(`Image ${index + 1} was skipped: it needs a "url" or an uploaded "file".`);
      return;
    }
    if (url && !isHttpsUrl(url)) {
      warnings.push(`Image ${index + 1} was skipped: the url must be https.`);
      return;
    }
    if (origin === "licensed_asset" && !text(image?.license, 300)) {
      warnings.push(`Image ${index + 1} is marked licensed but names no license. Confirm you may use it.`);
    }
    const altDe = text(image?.altDe, 200);
    const altEn = text(image?.altEn, 200);
    if (!altDe && !altEn) warnings.push(`Image ${index + 1} has no alt text.`);
    images.push({
      url, file, origin,
      role: text(image?.role, 40),
      altDe, altEn,
      license: text(image?.license, 300),
      note: text(image?.note, 300),
      primary: Boolean(image?.primary),
    });
  });
  if (images.length === 0) warnings.push("No usable images. Add photos before publishing; at least one real image is required.");
  if (images.length > 0 && images.length < 5) warnings.push(`${images.length} of 5 images. Five is a target, not a requirement.`);

  // --- sources / warnings ---
  const sources = list(input.sources).slice(0, 20).map((source) => ({
    type: SOURCE_TYPES.includes(text(source?.type)) ? text(source.type) : "other",
    url: text(source?.url, 1000),
    label: text(source?.label, 200),
    note: text(source?.note, 500),
  }));
  if (sources.length === 0) warnings.push("No sources recorded. Add where the information came from.");
  const preparerWarnings = list(input.warnings).map((w) => text(typeof w === "string" ? w : w?.message, 500)).filter(Boolean);

  const includedItems = list(input.includedItems).slice(0, 40).map((item) => ({
    de: text(item?.de, 200), en: text(item?.en, 200), quantity: Math.max(1, Math.floor(Number(item?.quantity) || 1)),
  })).filter((item) => item.de || item.en);

  const normalized = {
    schema: SCHEMA_ID,
    externalId,
    rentalMode: RENTAL_MODES.includes(rentalMode) ? rentalMode : "standard",
    identity: {
      brand: brandName,
      model: text(identity.model, 120),
      series: text(identity.series, 120),
      sku: text(identity.sku, 80),
      identifiers,
      category: { name: categoryName },
    },
    titles: { de: titleDe, en: titleEn },
    descriptions: { shortDe, shortEn, longDe, longEn },
    includedItems,
    specifications,
    tags: list(input.tags).map((tag) => text(tag, 60)).filter(Boolean).slice(0, 30),
    delivery: { leadDays },
    pricing: rentalMode === "occasion" ? { daily: dailyRate } : { weekly, monthly },
    seo: {
      metaTitle: text(seoIn.metaTitle, 120),
      metaDescription: text(seoIn.metaDescription, 320),
      keywords: list(seoIn.keywords).map((k) => text(k, 60)).filter(Boolean).slice(0, 20),
      canonicalUrl: text(seoIn.canonicalUrl, 500),
      ogTitle: text(seoIn.ogTitle, 120),
      ogDescription: text(seoIn.ogDescription, 320),
    },
    images,
    referenceImages: referenceOnly,
    sources,
    warnings: preparerWarnings,
  };

  if (normalized.seo.metaTitle.length > 70) warnings.push("seo.metaTitle is longer than 70 characters and may be cut off in search results.");
  if (!normalized.seo.metaTitle) warnings.push("No SEO meta title. One will be derived from the title.");
  if (!normalized.seo.metaDescription) warnings.push("No SEO meta description was provided.");
  else if (normalized.seo.metaDescription.length > 165) warnings.push("seo.metaDescription is longer than 165 characters and may be cut off.");

  return { ok: errors.length === 0, errors, warnings, package: normalized };
}

/**
 * Builds the Product document payload for a validated package. Always inactive.
 * `images` are already hosted: [{ url, altDe, altEn }] in display order.
 */
function buildPackageProductPayload(pkg, { categoryId, brandId, brandName, images, slug }) {
  const occasion = pkg.rentalMode === "occasion";
  const gallery = images.map((image) => image.url).filter(Boolean);
  const primary = gallery[0] || "";
  const title = pkg.titles.de || pkg.titles.en;

  return {
    title,
    titleI18n: { en: pkg.titles.en, de: pkg.titles.de },
    slug,
    description: pkg.descriptions.longDe || pkg.descriptions.longEn || "",
    descriptionI18n: { en: pkg.descriptions.longEn, de: pkg.descriptions.longDe },
    shortDescription: pkg.descriptions.shortDe || pkg.descriptions.shortEn || "",
    shortDescriptionI18n: { en: pkg.descriptions.shortEn, de: pkg.descriptions.shortDe },
    imageUrl: primary,
    galleryImages: gallery.slice(1),
    imageAlts: images.map((image) => ({ de: image.altDe || "", en: image.altEn || "" })),
    sku: pkg.identity.sku,
    brand: brandName || pkg.identity.brand,
    brandId,
    categoryId,
    model: pkg.identity.model,
    series: pkg.identity.series,
    identifiers: pkg.identity.identifiers,
    includedItems: pkg.includedItems,
    tags: pkg.tags,
    specifications: pkg.specifications,
    seo: {
      metaTitle: pkg.seo.metaTitle || `${title} mieten | Leihfluss`.slice(0, 70),
      metaDescription: pkg.seo.metaDescription,
      metaKeywords: pkg.seo.keywords,
      canonicalUrl: pkg.seo.canonicalUrl,
      ogTitle: pkg.seo.ogTitle || pkg.seo.metaTitle || title,
      ogDescription: pkg.seo.ogDescription || pkg.seo.metaDescription,
      ogImageUrl: primary,
    },
    rentalMode: pkg.rentalMode,
    occasionDailyRate: occasion ? pkg.pricing.daily : 0,
    occasionPricing: [],
    // Standard pricing keeps its existing meaning: weekly -> buyerPrice, monthly -> monthly fields.
    buyerPrice: occasion ? 0 : pkg.pricing.weekly,
    offerPrice: 0,
    monthlyBuyerPrice: occasion ? 0 : pkg.pricing.monthly,
    monthlyOfferPrice: 0,
    monthlyPrice: occasion ? 0 : pkg.pricing.monthly,
    weeklyAutoDiscount: 0,
    monthlyAutoDiscount: 0,
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
    minimumRentalDays: occasion ? 1 : 7,
    maximumRentalDays: occasion ? MAX_OCCASION_DAYS : 30,
    rentalPeriodUnit: occasion ? "day" : "week",
    deliveryFee: 0,
    ...(pkg.delivery?.leadDays !== null && pkg.delivery?.leadDays !== undefined ? { deliveryLeadDays: pkg.delivery.leadDays } : {}),
    verificationRequired: true,
    depositEnabled: false,
    securityDeposit: 0,
    replacementValue: 0,
    refundable: true,
    isMostPopular: false,
    isActive: false,
  };
}

module.exports = {
  SCHEMA_ID, IMAGE_ORIGINS, RENTAL_MODES,
  validateProductPackage, buildPackageProductPayload, buildSlug,
};
