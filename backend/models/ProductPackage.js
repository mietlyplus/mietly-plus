const mongoose = require("mongoose");

// The AI Product Queue. Each document is one prepared product package (see
// lib/product-package.js) waiting to be imported as a private draft.
const productPackageSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    title: { type: String, default: "", trim: true },
    rentalMode: { type: String, default: "standard" },
    // ready: valid, can be imported. invalid: has errors. imported: a draft exists.
    status: { type: String, enum: ["ready", "invalid", "imported"], required: true, index: true },
    problems: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
    // The normalised package as validated; the raw upload is not kept.
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    importedProductId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    importedDraftId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductDraft", default: null },
    importedAt: { type: Date, default: null },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ProductPackage || mongoose.model("ProductPackage", productPackageSchema);
