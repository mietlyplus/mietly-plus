const mongoose = require("mongoose");

// A draft (isActive: false) may exist before its category and brand are chosen.
// Publication re-checks both (lib/publication-rules.js), and the manual and CSV
// create routes validate them explicitly, so nothing live can lack either.
const requiredWhenActive = function () {
  return this.isActive !== false;
};

const productSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    titleI18n: {
      en: { type: String, default: "", trim: true },
      de: { type: String, default: "", trim: true },
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    descriptionI18n: {
      en: { type: String, default: "", trim: true },
      de: { type: String, default: "", trim: true },
    },
    shortDescription: {
      type: String,
      default: "",
      trim: true,
    },
    shortDescriptionI18n: {
      en: { type: String, default: "", trim: true },
      de: { type: String, default: "", trim: true },
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    galleryImages: {
      type: [String],
      default: [],
    },
    sku: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    brand: {
      type: String,
      default: "",
      trim: true,
    },
    brandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
      required: requiredWhenActive,
    },
    tags: {
      type: [String],
      default: [],
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: requiredWhenActive,
    },
    monthlyPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    buyerPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    offerPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    monthlyBuyerPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    monthlyOfferPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    weeklyAutoDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    monthlyAutoDiscount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    stock: {
      type: Number,
      default: 0,
      min: 0,
    },
    stockStatus: {
      type: String,
      enum: ["in_stock", "low_stock", "out_of_stock", "preorder"],
      default: "in_stock",
    },
    lowStockWarning: {
      type: Number,
      default: 5,
      min: 0,
    },
    maxRentalQuantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    unit: {
      type: String,
      default: "piece",
      trim: true,
    },
    weightKg: {
      type: Number,
      default: 0,
      min: 0,
    },
    minimumRentalMonths: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    maximumRentalMonths: {
      type: Number,
      required: true,
      min: 1,
      default: 24,
    },
    minimumRentalWeeks: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    maximumRentalWeeks: {
      type: Number,
      required: true,
      min: 1,
      default: 4,
    },
    minimumRentalDays: {
      type: Number,
      required: true,
      min: 1,
      default: 7,
    },
    maximumRentalDays: {
      type: Number,
      required: true,
      min: 1,
      default: 30,
    },
    rentalPeriodUnit: {
      type: String,
      enum: ["day", "week", "month"],
      default: "week",
    },
    deliveryFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Days between ordering and the earliest rental start (preparation + delivery).
    // Applies to standard and occasion products alike. Default 2 is what the
    // storefront always assumed, so existing products behave as before.
    deliveryLeadDays: {
      type: Number,
      default: 2,
      min: 0,
      max: 30,
    },
    verificationRequired: {
      type: Boolean,
      default: true,
    },
    depositEnabled: {
      type: Boolean,
      default: false,
    },
    securityDeposit: {
      type: Number,
      default: 0,
      min: 0,
    },
    replacementValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    refundable: {
      type: Boolean,
      default: true,
    },
    specifications: {
      type: [
        {
          key: { type: String, trim: true },
          value: { type: String, trim: true },
          // Optional English wording; the storefront falls back to key/value.
          keyEn: { type: String, trim: true, default: "" },
          valueEn: { type: String, trim: true, default: "" },
        },
      ],
      default: [],
    },
    seo: {
      metaTitle: { type: String, default: "", trim: true },
      metaDescription: { type: String, default: "", trim: true },
      metaKeywords: { type: [String], default: [] },
      canonicalUrl: { type: String, default: "", trim: true },
      ogTitle: { type: String, default: "", trim: true },
      ogDescription: { type: String, default: "", trim: true },
      ogImageUrl: { type: String, default: "", trim: true },
    },
    // "standard" products rent by week/month. "occasion" products rent by the day
    // (1-7 days) at occasionDailyRate: price = daily rate x days, charged once.
    rentalMode: { type: String, enum: ["standard", "occasion"], default: "standard" },
    occasionDailyRate: { type: Number, min: 0, default: 0 },
    // Legacy: explicit per-length prices from drafts made before the daily rate.
    // Read only as a fallback to derive a daily rate; never written any more.
    occasionPricing: {
      type: [{ _id: false, days: { type: Number, min: 1, max: 7 }, price: { type: Number, min: 0 } }],
      default: [],
    },
    model: { type: String, default: "", trim: true },
    series: { type: String, default: "", trim: true },
    identifiers: {
      ean: { type: String, default: "", trim: true },
      gtin: { type: String, default: "", trim: true },
      mpn: { type: String, default: "", trim: true },
    },
    // For bundles and party packages: what is in the box.
    includedItems: {
      type: [{ _id: false, de: { type: String, trim: true }, en: { type: String, trim: true }, quantity: { type: Number, min: 1, default: 1 } }],
      default: [],
    },
    // Alt text aligned with [imageUrl, ...galleryImages].
    imageAlts: {
      type: [{ _id: false, de: { type: String, default: "", trim: true }, en: { type: String, default: "", trim: true } }],
      default: [],
    },
    // Which rental price the product CARD shows. Empty = derive (occasion: day,
    // otherwise week unless only a monthly price exists). Detail pages show all options.
    cardPriceUnit: { type: String, enum: ["", "week", "month", "day"], default: "" },
    isMostPopular: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.Product || mongoose.model("Product", productSchema);
