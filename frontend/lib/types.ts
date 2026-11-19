export type Locale = "en" | "de";

export type Category = {
  id: string;
  name: {
    en: string;
    de: string;
  };
  slug: string;
  image: string | null;
  parentId: string | null;
  seo?: {
    metaTitle: string;
    metaDescription: string;
    metaKeywords: string[];
    canonicalUrl: string;
    contentHtml: {
      en: string;
      de: string;
    };
  };
  children?: Category[];
};

export type Banner = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  imageUrl: string;
  buttonText: string;
  buttonLink: string;
  position: string;
  device: "desktop" | "mobile";
  sortOrder: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Brand = {
  id: string;
  name: string;
  slug: string;
  image: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Product = {
  id: string;
  title: string;
  titleI18n: {
    en: string;
    de: string;
  };
  slug: string;
  description: string;
  descriptionI18n: {
    en: string;
    de: string;
  };
  shortDescription: string;
  shortDescriptionI18n: {
    en: string;
    de: string;
  };
  imageUrl: string;
  galleryImages: string[];
  sku: string;
  brandId: string;
  brand: string;
  brandData?: {
    id: string;
    name: string;
    slug: string;
    image: string | null;
  } | null;
  tags: string[];
  categoryId: string;
  category: {
    id: string;
    name: {
      en: string;
      de: string;
    };
    slug: string;
  } | null;
  monthlyPrice: number;
  buyerPrice: number;
  offerPrice: number;
  monthlyBuyerPrice: number;
  monthlyOfferPrice: number;
  stock: number;
  stockStatus: "in_stock" | "low_stock" | "out_of_stock" | "preorder";
  lowStockWarning: number;
  maxRentalQuantity: number;
  unit: string;
  weightKg: number;
  minimumRentalMonths: number;
  maximumRentalMonths: number;
  minimumRentalWeeks: number;
  maximumRentalWeeks: number;
  minimumRentalDays: number;
  maximumRentalDays: number;
  rentalPeriodUnit: "day" | "week" | "month";
  rentalMode?: "standard" | "occasion";
  deliveryLeadDays?: number;
  /** Occasion products: price per day. The total is daily rate x days, paid once. */
  occasionDailyRate?: number;
  /** Derived by the server (daily rate x 1..7 days); never edited directly. */
  occasionPricing?: { days: number; price: number }[];
  model?: string;
  series?: string;
  identifiers?: { ean: string; gtin: string; mpn: string };
  includedItems?: { de: string; en: string; quantity: number }[];
  imageAlts?: { de: string; en: string }[];
  deliveryFee: number;
  verificationRequired: boolean;
  depositEnabled: boolean;
  securityDeposit: number;
  replacementValue: number;
  refundable: boolean;
  specifications: Array<{ key: string; value: string; keyEn?: string; valueEn?: string }>;
  seo: {
    metaTitle?: string;
    metaDescription?: string;
    metaKeywords?: string[];
    canonicalUrl?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImageUrl?: string;
  };
  isMostPopular: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BlogPost = {
  id: string;
  titleI18n: {
    en: string;
    de: string;
  };
  excerptI18n: {
    en: string;
    de: string;
  };
  contentHtmlI18n: {
    en: string;
    de: string;
  };
  categoryId: string;
  category: {
    id: string;
    name: {
      en: string;
      de: string;
    };
    slug: string;
  } | null;
  slug: string;
  coverImageUrl: string;
  tags: string[];
  readingTimeMinutes: number;
  seo: {
    metaTitle?: string;
    metaDescription?: string;
    metaKeywords?: string[];
    canonicalUrl?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImageUrl?: string;
  };
  status: "draft" | "published";
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportRequest = {
  id: string;
  name: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  locale: "en" | "de";
  source: string;
  pageUrl: string;
  status: "new" | "in_progress" | "resolved";
  createdAt: string;
  updatedAt: string;
};

export type Order = {
  id: string;
  orderNumber: string;
  userId: string;
  customer: {
    name: string;
    email: string;
    phone: string;
  };
  shippingAddress: {
    fullName: string;
    phone: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  items: Array<{
    productId: string;
    title: string;
    slug: string;
    imageUrl: string;
    categoryName: string;
    brandName: string;
    quantity: number;
    unitPrice: number;
    baseUnitPrice: number;
    durationValue: number;
    durationUnit: "day" | "week" | "month";
    billingType?: "one_time" | "recurring";
    startDate: string;
    depositEnabled: boolean;
    securityDeposit: number;
    deliveryFee: number;
    lineSubtotal: number;
    lineDeposit: number;
    lineDelivery: number;
    lineTotal: number;
  }>;
  currency: string;
  subtotal: number;
  depositTotal: number;
  deliveryTotal: number;
  total: number;
  status: "pending_payment" | "paid" | "failed" | "cancelled";
  fulfillmentStatus: "pending" | "processing" | "shipped" | "delivered" | "cancelled" | "returned";
  paymentStatus: "unpaid" | "partially_paid" | "paid" | "refunded";
  /** Historical orders are all "one_time". */
  billingMode?: "one_time" | "recurring";
  recurring?: {
    interval: "week" | "month";
    billingCycles: number;
    successfulCycles: number;
    recurringAmount: number;
    totalRentalCommitment: number;
    oneTimeCharges: number;
    dueToday: number;
    nextBillingDate: string;
    status: "pending" | "active" | "past_due" | "completed" | "cancelled";
    lastPaymentAt: string;
  } | null;
  stripeSubscriptionId?: string;
  stripeSubscriptionScheduleId?: string;
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string;
  rentalEndDate: string;
  createdAt: string;
  updatedAt: string;
};

export type CartItem = {
  id: string;
  productId: string;
  slug: string;
  categorySlug?: string;
  title: string;
  /** Both languages, so the cart follows the language toggle. Absent on older carts. */
  titleI18n?: { en: string; de: string };
  imageUrl: string;
  categoryName: string;
  categoryNameI18n?: { en: string; de: string };
  brandName: string;
  unitPrice: number;
  baseUnitPrice: number;
  durationValue: number;
  durationUnit: "day" | "week" | "month";
  startDate: string;
  quantity: number;
  verificationRequired: boolean;
  depositEnabled: boolean;
  securityDeposit: number;
  deliveryFee: number;
  /** Snapshot of the product's rental cap at add-to-cart time. Absent on carts
   *  saved before this field existed; the checkout quote is authoritative. */
  maxRentalQuantity?: number;
  addedAt: string;
};


/** AI product-automation draft (product-link workflow). */
export type ProductDraftImage = {
  id: string;
  url: string;
  origin: "user" | "source" | "ai" | "fixture";
  role: string;
  prompt: string;
  providerId: string;
  isFixture: boolean;
  status: "pending" | "generating" | "ready" | "failed";
  error: string;
};

export type ProductDraftWarning = { code: string; field: string; message: string };

export type ProductDraftStep = {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error: string;
  completedAt: string | null;
};

export type ProductDraft = {
  id: string;
  productId: string | null;
  sourceUrl: string;
  weeklyPrice: number;
  monthlyPrice: number;
  instruction: string;
  pastedDetails: string;
  usableSource: boolean;
  needs: { source: boolean; taxonomy: boolean; images: boolean };
  taxonomy: { categoryResolved: boolean | null; brandResolved: boolean | null; confirmed: boolean } | null;
  status: "generating" | "needs_source" | "ready" | "failed" | "published" | "discarded";
  steps: { extraction: ProductDraftStep; text: ProductDraftStep; images: ProductDraftStep };
  warnings: ProductDraftWarning[];
  images: ProductDraftImage[];
  providers: {
    text: { id: string; model: string; real: boolean };
    image: { id: string; model: string; real: boolean };
  };
  imageCompleteness: {
    target: number;
    ready: number;
    missing: number;
    complete: boolean;
    failed: number;
    pending: number;
    hasReference: boolean;
    byOrigin: { user: number; source: number; ai: number; fixture: number };
    reasons: string[];
  };
  pendingRevision: {
    hasChanges: boolean;
    imagesChanged: boolean;
    hasListing: boolean;
    updatedAt: string | null;
    /** What approving would publish, so it can be reviewed first. */
    proposed: {
      titleDe: string;
      titleEn: string;
      shortDescription: string;
      description: string;
      specifications: Array<{ key: string; value: string }>;
      tags: string[];
    } | null;
  };
  sourceImageryConfirmed: boolean;
  provenance: {
    retailerPrice: { amount: number; currency: string } | null;
    extractionConfidence: string;
    usedStrategies: string[];
    finalUrl: string;
    sourceImages: string[];
    extractedFacts: Record<string, unknown> | null;
  };
  product: Product | null;
  createdAt: string;
  updatedAt: string;
  deduplicated?: boolean;
  recoverable?: boolean;
  imageError?: string;
  textError?: string;
  alreadyComplete?: boolean;
  imageNote?: string;
  addedSlots?: number;
  resumeRequired?: boolean;
  requiresSourceImageryConfirmation?: boolean;
};

export type AiProviderStatus = {
  text: { id: string; model: string; real: boolean };
  image: { id: string; model: string; real: boolean };
  geminiConfigured: boolean;
  environment?: {
    deployment: string;
    preview: boolean;
    databaseIsolated: boolean;
    databaseName: string;
    uploadFolder: string;
  };
};

/** Server-calculated pricing for a cart. The backend is the only source of
 *  chargeable amounts, so the UI renders these rather than its own arithmetic. */
export type CheckoutQuoteLimits = {
  maxQuantity: number;
  minDuration: number | null;
  maxDuration: number | null;
  availableUnits: Array<"day" | "week" | "month">;
  occasionOptions?: Array<{ days: number; price: number }>;
};

export type CheckoutQuoteIssue = {
  lineId: string;
  productId: string;
  code: string;
  message: string;
};

export type CheckoutQuoteLine = {
  lineId: string;
  productId: string;
  title: string;
  valid: boolean;
  limits: CheckoutQuoteLimits | null;
  issue?: CheckoutQuoteIssue;
  quantity?: number;
  durationValue?: number;
  durationUnit?: "day" | "week" | "month";
  billingType?: "one_time" | "recurring";
  /** Due at checkout for this line (first period + one-time delivery/deposit for a recurring line). */
  lineDueToday?: number;
  /** Rental price of each following period. 0 for one-time lines. */
  recurringPerPeriod?: number;
  remainingPayments?: number;
  unitPrice?: number;
  baseUnitPrice?: number;
  listUnitPrice?: number;
  depositEnabled?: boolean;
  securityDeposit?: number;
  deliveryFee?: number;
  lineSubtotal?: number;
  lineDeposit?: number;
  lineDelivery?: number;
  lineTotal?: number;
  verificationRequired?: boolean;
};

/** How the cart is billed, calculated by the server. */
export type CheckoutBilling = {
  mode: "one_time" | "recurring";
  interval: "" | "week" | "month";
  billingCycles: number;
  dueToday: number;
  totalRental: number;
  oneTimeCharges: number;
  /** Rental amount of the first and the following payments. */
  recurringAmount: number;
  /** Payments after today, as runs of an equal amount. */
  upcoming: Array<{ payments: number; amount: number }>;
};

export type CheckoutQuote = {
  currency: string;
  lines: CheckoutQuoteLine[];
  issues: CheckoutQuoteIssue[];
  totals: {
    subtotal: number;
    depositTotal: number;
    deliveryTotal: number;
    /** The whole commitment. */
    total: number;
    /** What is charged at checkout; below `total` for a recurring rental. */
    dueToday: number;
  };
  billing?: CheckoutBilling | null;
  requiresIdentityVerification: boolean;
  valid: boolean;
};
