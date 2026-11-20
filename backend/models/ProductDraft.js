const mongoose = require("mongoose");

// AI provenance for a product created via the product-link workflow.
//
// The listing itself is an ordinary Product document (isActive: false until
// published). This collection holds only what the Product model has no place
// for: the job's step state, the warnings the admin must review, where each
// image came from, and which provider produced what.

const draftImageSchema = new mongoose.Schema(
  {
    url: { type: String, default: "", trim: true },
    // Where the image came from. "user" uploads are the highest-trust reference.
    origin: { type: String, enum: ["user", "source", "ai", "fixture"], required: true },
    role: { type: String, default: "", trim: true },
    prompt: { type: String, default: "", trim: true },
    providerId: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    isFixture: { type: Boolean, default: false },
    // Free-text provenance: a license, or who made the photo.
    provenanceNote: { type: String, default: "", trim: true },
    status: { type: String, enum: ["pending", "generating", "ready", "failed"], default: "ready" },
    error: { type: String, default: "", trim: true },
    // Lease for an in-flight generation, so a duplicate request cannot pay for
    // the same image twice.
    generationStartedAt: { type: Date, default: null },
  },
  { _id: true }
);

const stepSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["pending", "running", "done", "failed", "skipped"], default: "pending" },
    error: { type: String, default: "", trim: true },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const warningSchema = new mongoose.Schema(
  {
    code: { type: String, default: "", trim: true },
    field: { type: String, default: "", trim: true },
    message: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const productDraftSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null, index: true },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true, index: true },

    sourceUrl: { type: String, default: "", trim: true },
    // "link" = created from a product URL; "package" = imported from a prepared AI Product Package.
    origin: { type: String, enum: ["link", "package"], default: "link" },
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductPackage", default: null },
    // Admin-entered rental rates. Authoritative; never derived from the source.
    weeklyPrice: { type: Number, default: 0, min: 0 },
    monthlyPrice: { type: Number, default: 0, min: 0 },
    instruction: { type: String, default: "", trim: true, maxlength: 2000 },
    // Details the owner typed or pasted (e.g. from a spec sheet). Treated as a
    // factual source alongside, or instead of, a fetched page.
    pastedDetails: { type: String, default: "", trim: true, maxlength: 8000 },
    // True once the owner has picked the category/brand. Until then they are
    // only suggestions and a later regeneration may replace them.
    taxonomyConfirmed: { type: Boolean, default: false },
    // The image briefs from the last text generation, kept so missing slots can
    // be rebuilt later without another paid text call.
    imageBriefs: { type: mongoose.Schema.Types.Mixed, default: [] },

    status: {
      type: String,
      enum: ["generating", "needs_source", "ready", "failed", "published", "discarded"],
      default: "generating",
      index: true,
    },
    steps: {
      extraction: { type: stepSchema, default: () => ({}) },
      text: { type: stepSchema, default: () => ({}) },
      images: { type: stepSchema, default: () => ({}) },
    },

    images: { type: [draftImageSchema], default: [] },
    warnings: { type: [warningSchema], default: [] },

    // Once a product is published, draft edits are held here instead of being
    // written straight to the live Product. They reach the storefront only when
    // the owner explicitly applies the revision.
    pendingRevision: {
      hasChanges: { type: Boolean, default: false },
      listing: { type: mongoose.Schema.Types.Mixed, default: null },
      images: { type: [draftImageSchema], default: [] },
      imagesChanged: { type: Boolean, default: false },
      updatedAt: { type: Date, default: null },
    },

    // Heartbeat for the create/resume job, so a request killed mid-flight can
    // be detected and resumed instead of stranding the draft.
    jobLeaseAt: { type: Date, default: null },

    // Read-only provenance, shown to the admin so every fact can be traced.
    provenance: {
      extractedFacts: { type: mongoose.Schema.Types.Mixed, default: null },
      sourceImages: { type: [String], default: [] },
      // Retailer purchase price, kept for reference ONLY. Never used in pricing.
      retailerPrice: {
        amount: { type: Number, default: 0 },
        currency: { type: String, default: "", trim: true },
      },
      extractionConfidence: { type: String, default: "", trim: true },
      usedStrategies: { type: [String], default: [] },
      finalUrl: { type: String, default: "", trim: true },
      // Fallback web-search sources: [{ url, role: manufacturer|retailer, used, note }].
      sources: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },

    providers: {
      text: { id: { type: String, default: "" }, model: { type: String, default: "" }, real: { type: Boolean, default: false } },
      image: { id: { type: String, default: "" }, model: { type: String, default: "" }, real: { type: Boolean, default: false } },
    },

    // Guards against a double-tap on the phone creating two drafts.
    submissionKey: { type: String, default: "", trim: true, index: true },

    // Set when the owner accepts reusing a retailer's own photography.
    sourceImageryConfirmed: { type: Boolean, default: false },

    publishedAt: { type: Date, default: null },
    publishedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ProductDraft || mongoose.model("ProductDraft", productDraftSchema);
