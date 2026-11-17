"use strict";

// Orchestrates the product-link workflow. Split into steps the client drives
// so each HTTP request stays inside the serverless time limit and one failed
// image never forces the text (or the other images) to be regenerated.

const { fetchSourceDocument, SourceFetchError } = require("../source/fetch-source");
const { extractProductFacts } = require("../source/extract-product");
const { resolveTextProvider, resolveImageProvider, describeProviders, ProviderError } = require("./providers");
const {
  buildDraftProductPayload,
  buildSlug,
  mapRentalPricing,
  matchBrand,
  matchCategory,
} = require("../product-payload");

const MAX_IMAGES = 5;

/** Extraction never fails the workflow: the admin can always fill in the gaps. */
async function runExtraction(sourceUrl, deps = {}) {
  const empty = {
    facts: { name: "", brand: "", model: "", sku: "", color: "", description: "", category: "", specifications: [] },
    sourceImages: [],
    retailerPrice: null,
    confidence: "low",
    usedStrategies: [],
    finalUrl: sourceUrl,
  };

  if (!sourceUrl) {
    return { ok: true, result: empty, warnings: [{ code: "no_source_url", field: "sourceUrl", message: "No product link supplied; enter the details manually." }] };
  }

  try {
    const fetcher = deps.fetchSourceDocument || fetchSourceDocument;
    const { html, finalUrl } = await fetcher(sourceUrl);
    const extracted = extractProductFacts(html, finalUrl);

    const warnings = [];
    if (extracted.confidence === "low") {
      warnings.push({
        code: "low_extraction_confidence",
        field: "sourceUrl",
        message: "Little structured product data was found on that page. Check every generated field.",
      });
    }
    if (!extracted.facts.name) {
      warnings.push({ code: "missing_product_name", field: "title", message: "No product name found on the source page." });
    }

    return { ok: true, result: { ...extracted, finalUrl }, warnings };
  } catch (error) {
    const isKnown = error instanceof SourceFetchError;
    // Degrade, never abort: price + photos + URL are preserved either way.
    return {
      ok: false,
      result: empty,
      warnings: [
        {
          code: isKnown ? `extraction_${error.code.toLowerCase()}` : "extraction_failed",
          field: "sourceUrl",
          message: isKnown ? error.message : "That page could not be read. Enter the product details manually.",
        },
      ],
      error: isKnown ? error.code : "EXTRACTION_FAILED",
    };
  }
}

async function runTextGeneration({ facts, adminDetails, instruction, categories, brands, hasUserPhotos }, deps = {}) {
  const provider = deps.textProvider || resolveTextProvider();
  try {
    const { listing, providerId, model } = await provider.generateListing({
      facts,
      adminDetails,
      adminInstruction: instruction,
      categories,
      brands,
      hasUserPhotos,
    });
    return { ok: true, listing, providerId, model, warnings: Array.isArray(listing.warnings) ? listing.warnings : [] };
  } catch (error) {
    const retryable = error instanceof ProviderError ? error.retryable : false;
    return {
      ok: false,
      error: error instanceof ProviderError ? error.code : "TEXT_GENERATION_FAILED",
      retryable,
      warnings: [{ code: "text_generation_failed", field: "*", message: error.message || "Listing text could not be generated." }],
    };
  }
}

/**
 * A listing may only be written from real source material: a fetched product
 * page that yielded a product name, or details the owner supplied. A link on
 * its own is not source material -- its text must never be mined for facts.
 */
function hasUsableSource({ facts, adminDetails }) {
  return Boolean(String(facts?.name || "").trim()) || Boolean(String(adminDetails || "").trim());
}

const DEFAULT_IMAGE_BRIEFS = [
  { role: "hero", prompt: "Clean primary product shot on a neutral background", requiresReference: false },
  { role: "angle", prompt: "A second, different supported angle of the same product", requiresReference: true },
  { role: "detail", prompt: "Close-up of a clearly visible feature or control", requiresReference: true },
  { role: "context", prompt: "The product in realistic everyday use", requiresReference: true },
  { role: "alt", prompt: "Another distinct, useful view of the product", requiresReference: true },
];

/**
 * Plans only the image slots that are missing, leaving everything already in the
 * draft untouched -- ready images, failed ones awaiting a deliberate retry, and
 * pending slots alike. Used both for a first plan and for a rebuild after the
 * owner supplies reference material.
 */
function planMissingImages({ existing, sourceImages, briefs }) {
  const current = existing || [];
  const missing = Math.max(0, MAX_IMAGES - current.length);
  const hasReference = current.some((image) => image.origin === "user" && image.url) || (sourceImages || []).length > 0;

  if (missing === 0) return { additions: [], hasReference, reason: "" };

  const takenRoles = new Set(current.map((image) => image.role));
  const hasOwnerPhoto = current.some((image) => image.origin === "user" && image.url);
  const modelBriefs = briefs && briefs.length ? briefs : [];

  // The model may propose fewer than five views when the reference is thin, and
  // that restraint is respected. Once the owner supplies their own photo the
  // missing views are legitimate to create, so the set is topped up with the
  // standard views rather than stopping at the model's shorter list.
  const candidates = modelBriefs.length === 0 || hasOwnerPhoto ? [...modelBriefs, ...DEFAULT_IMAGE_BRIEFS] : modelBriefs;
  const seen = new Set();
  const pool = candidates
    .filter((brief) => !takenRoles.has(brief.role) && !seen.has(brief.role) && seen.add(brief.role))
    .filter((brief) => !brief.requiresReference || hasReference)
    .slice(0, missing);

  const additions = pool.map((brief) => ({
    origin: "ai",
    url: "",
    role: brief.role || "image",
    prompt: brief.prompt || "",
    status: "pending",
    requiresReference: Boolean(brief.requiresReference),
  }));

  let reason = "";
  if (additions.length === 0 && !hasReference) {
    reason = "No reference photo is available. Add a photo of the product so the missing views can be created safely.";
  } else if (additions.length < missing && !hasReference) {
    reason = "Some views need a reference photo. Add one to create the rest.";
  }
  return { additions, hasReference, reason };
}

/**
 * Decides what to generate. Admin photos win: if five suitable photos were
 * uploaded, nothing is generated at all.
 */
function planImages({ userImages, sourceImages, briefs }) {
  const plan = [];

  for (const url of userImages.slice(0, MAX_IMAGES)) {
    plan.push({ origin: "user", url, role: "user-upload", status: "ready" });
  }

  if (plan.length >= MAX_IMAGES) {
    return { plan, generationNeeded: false, skippedReason: "admin supplied enough photos" };
  }

  const hasReference = userImages.length > 0 || sourceImages.length > 0;
  const remaining = MAX_IMAGES - plan.length;
  const usable = (briefs || []).filter((brief) => !brief.requiresReference || hasReference).slice(0, remaining);

  for (const brief of usable) {
    plan.push({
      origin: "ai",
      url: "",
      role: brief.role || "image",
      prompt: brief.prompt || "",
      status: "pending",
      requiresReference: Boolean(brief.requiresReference),
    });
  }

  return { plan, generationNeeded: usable.length > 0, hasReference };
}

async function generateOneImage({ brief, references }, deps = {}) {
  const provider = deps.imageProvider || resolveImageProvider();

  // Refuse rather than fabricate a view the references cannot support.
  if (brief.requiresReference && (!references || references.length === 0)) {
    return {
      ok: false,
      error: "INSUFFICIENT_REFERENCE",
      warning: {
        code: "insufficient_reference",
        field: "images",
        message: `Not enough reference imagery to create the "${brief.role}" view safely. Upload another photo of the product.`,
      },
    };
  }

  try {
    const fn = references?.length ? provider.editFromReferences : provider.generate;
    const image = await fn.call(provider, { brief, references: references || [] });
    return { ok: true, image, providerId: image.providerId, model: image.model, isFixture: Boolean(image.isFixture) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ProviderError ? error.code : "IMAGE_GENERATION_FAILED",
      retryable: error instanceof ProviderError ? error.retryable : false,
      warning: { code: "image_generation_failed", field: "images", message: error.message || "That image could not be generated." },
    };
  }
}

/** Assembles the Product payload. Pricing comes only from the admin's input. */
function assembleDraft({ listing, weeklyPrice, monthlyPrice, categories, brands, images, fallbackSeed, categoryHint }) {
  const categoryCandidate = listing.suggestedCategoryName || categoryHint || "";
  const category = matchCategory(categoryCandidate, categories, listing.suggestedCategoryId);
  const brand = matchBrand(listing.brandName, brands, listing.suggestedBrandId);

  const warnings = [];
  if (!category.categoryId) {
    warnings.push({ code: "category_unresolved", field: "categoryId", message: "No existing category matched. Pick one before publishing." });
  } else if (category.confidence !== "high") {
    warnings.push({ code: "category_uncertain", field: "categoryId", message: `Category suggested from a ${category.reason}. Confirm it.` });
  }
  if (!brand.brandId) {
    warnings.push({ code: "brand_unresolved", field: "brandId", message: "No existing brand matched. Pick one before publishing." });
  } else if (brand.confidence !== "high") {
    warnings.push({ code: "brand_uncertain", field: "brandId", message: `Brand suggested from a ${brand.reason}. Confirm it.` });
  }

  const pricing = mapRentalPricing({ weeklyPrice, monthlyPrice });
  const slug = listing.slug ? buildSlug([listing.slug], fallbackSeed) : buildSlug([brand.brandName, listing.titleDe], fallbackSeed);

  const payload = buildDraftProductPayload({
    listing,
    pricing,
    categoryId: category.categoryId,
    brandId: brand.brandId,
    brandName: brand.brandName,
    images,
    slug,
  });

  return { payload, warnings, category, brand, pricing, slug };
}

module.exports = {
  assembleDraft,
  describeProviders,
  DEFAULT_IMAGE_BRIEFS,
  generateOneImage,
  hasUsableSource,
  MAX_IMAGES,
  planImages,
  planMissingImages,
  runExtraction,
  runTextGeneration,
};
