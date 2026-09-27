"use strict";

// Single source of truth for "may this product go live?".
//
// Enforced from every entry point that can flip `isActive` to true -- the draft
// publish route AND the ordinary admin product editor -- so an AI-origin
// listing cannot be activated through the older path to skip these checks.
// Products with no draft (manual, CSV) are unaffected.

const IMAGE_TARGET = 5;

function isPlaceholderImage(url, placeholder) {
  const value = String(url || "").trim();
  if (!value) return true;
  if (placeholder && value === placeholder) return true;
  return value.startsWith("data:image/svg+xml");
}

/**
 * @returns {{blockers: string[], requiresSourceImageryConfirmation: boolean}}
 */
function evaluatePublicationBlockers({ product, draft, placeholderImage, confirmSourceImagery = false }) {
  const blockers = [];

  if (!String(product?.title || "").trim()) blockers.push("A title is required.");
  if (!product?.categoryId) blockers.push("A category is required.");
  if (!product?.brandId) blockers.push("A brand is required.");
  if (isPlaceholderImage(product?.imageUrl, placeholderImage)) blockers.push("At least one real image is required.");
  if (!(Number(product?.buyerPrice) > 0)) blockers.push("A weekly rental price is required.");
  if (!(Number(product?.monthlyBuyerPrice) > 0)) blockers.push("A monthly rental price is required.");

  let requiresSourceImageryConfirmation = false;

  if (draft) {
    const images = draft.images || [];

    // Nothing produced by the development fixture providers may go live.
    if (images.some((image) => image.isFixture && image.url)) {
      blockers.push("Development fixture images cannot be published. Replace or regenerate them with a real provider.");
    }
    if (draft.providers?.text?.real === false) {
      blockers.push(
        "This listing text came from the development fixture provider, not a real AI model. Configure a text provider and regenerate before publishing."
      );
    }

    // Reusing a retailer's own photography is a decision the owner must make
    // knowingly, so it needs an explicit confirmation rather than a default.
    const reusedSourceImages = images.filter((image) => image.origin === "source" && image.url);
    if (reusedSourceImages.length > 0 && !(confirmSourceImagery || draft.sourceImageryConfirmed)) {
      requiresSourceImageryConfirmation = true;
      blockers.push(
        `${reusedSourceImages.length} image(s) are reused from the retailer's page. Confirm you have the right to use them before publishing.`
      );
    }
  }

  return { blockers, requiresSourceImageryConfirmation };
}

/**
 * Describes how close the draft is to the five-image target, and what is still
 * needed. A short set is never reported as complete.
 */
function summariseImageCompleteness(draft) {
  const images = draft?.images || [];
  const ready = images.filter((image) => image.url && image.status === "ready");
  const failed = images.filter((image) => image.status === "failed");
  const pending = images.filter((image) => image.status === "pending" || image.status === "generating");

  const hasReference = images.some((image) => image.origin === "user" && image.url) ||
    (draft?.provenance?.sourceImages || []).length > 0;

  const missing = Math.max(0, IMAGE_TARGET - ready.length);
  const reasons = [];

  if (missing > 0) {
    if (pending.length > 0) reasons.push(`${pending.length} image(s) have not been generated yet.`);
    if (failed.length > 0) reasons.push(`${failed.length} image(s) failed to generate and can be retried.`);
    if (!hasReference) {
      reasons.push("No reference photo is available. Upload a photo of the product so the remaining views can be created safely.");
    } else if (pending.length === 0 && failed.length === 0) {
      reasons.push("Add another reference photo, or upload your own images, to reach five.");
    }
  }

  return {
    target: IMAGE_TARGET,
    ready: ready.length,
    missing,
    complete: missing === 0,
    failed: failed.length,
    pending: pending.length,
    hasReference,
    // Counted separately so the review screen can distinguish what was
    // generated from what was reused off the retailer's page.
    byOrigin: {
      user: images.filter((i) => i.origin === "user" && i.url).length,
      source: images.filter((i) => i.origin === "source" && i.url).length,
      ai: images.filter((i) => i.origin === "ai" && i.url).length,
      fixture: images.filter((i) => i.origin === "fixture" && i.url).length,
    },
    reasons,
  };
}

module.exports = { evaluatePublicationBlockers, summariseImageCompleteness, IMAGE_TARGET, isPlaceholderImage };
