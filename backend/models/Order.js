const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      default: "",
      trim: true,
    },
    imageUrl: {
      type: String,
      default: "",
      trim: true,
    },
    categoryName: {
      type: String,
      default: "",
      trim: true,
    },
    brandName: {
      type: String,
      default: "",
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    baseUnitPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    durationValue: {
      type: Number,
      required: true,
      min: 1,
    },
    durationUnit: {
      type: String,
      enum: ["day", "week", "month"],
      default: "week",
    },
    startDate: {
      type: String,
      required: true,
      trim: true,
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
    deliveryFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    lineSubtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    lineDeposit: {
      type: Number,
      required: true,
      min: 0,
    },
    lineDelivery: {
      type: Number,
      required: true,
      min: 0,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    // "recurring": the rental price is billed per period for a fixed term.
    // "one_time": paid once (occasion rentals and single-period rentals).
    billingType: {
      type: String,
      enum: ["one_time", "recurring"],
      default: "one_time",
    },
  },
  { _id: false }
);

// Fixed-term recurring billing. Only present on recurring orders. Money is in
// euros like the rest of the order.
const recurringSchema = new mongoose.Schema(
  {
    interval: { type: String, enum: ["week", "month"], required: true },
    // Number of billing cycles in the term (longest line).
    billingCycles: { type: Number, required: true, min: 2 },
    // Invoices that Stripe has reported paid. Never decreases.
    successfulCycles: { type: Number, default: 0, min: 0 },
    // Rental amount of the first and of each following payment, in euros.
    recurringAmount: { type: Number, default: 0, min: 0 },
    // Rental over the whole term, excluding the one-time delivery fee and deposit.
    totalRentalCommitment: { type: Number, default: 0, min: 0 },
    // Delivery fee + deposit, charged once with the first payment.
    oneTimeCharges: { type: Number, default: 0, min: 0 },
    // What the customer paid at checkout.
    dueToday: { type: Number, default: 0, min: 0 },
    nextBillingDate: { type: Date, default: null },
    status: {
      type: String,
      enum: ["pending", "active", "past_due", "completed", "cancelled"],
      default: "pending",
    },
    lastPaymentAt: { type: Date, default: null },
    lastPaymentFailedAt: { type: Date, default: null },
    // Invoice ids already counted; makes counting idempotent even across
    // different events that describe the same invoice.
    paidInvoiceIds: { type: [String], default: [] },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    customer: {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true },
      phone: { type: String, default: "", trim: true },
    },
    shippingAddress: {
      fullName: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      line1: { type: String, required: true, trim: true },
      line2: { type: String, default: "", trim: true },
      city: { type: String, required: true, trim: true },
      state: { type: String, default: "", trim: true },
      postalCode: { type: String, required: true, trim: true },
      country: { type: String, required: true, trim: true },
    },
    items: {
      type: [orderItemSchema],
      default: [],
    },
    currency: {
      type: String,
      default: "eur",
      lowercase: true,
      trim: true,
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    depositTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    deliveryTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["pending_payment", "paid", "failed", "cancelled"],
      default: "pending_payment",
    },
    fulfillmentStatus: {
      type: String,
      enum: ["pending", "processing", "shipped", "delivered", "cancelled", "returned"],
      default: "pending",
    },
    paymentStatus: {
      type: String,
      // "partially_paid": a recurring rental whose term is not fully paid yet.
      enum: ["unpaid", "partially_paid", "paid", "refunded"],
      default: "unpaid",
    },
    billingMode: {
      type: String,
      enum: ["one_time", "recurring"],
      default: "one_time",
    },
    recurring: {
      type: recurringSchema,
      default: undefined,
    },
    stripeSubscriptionId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    stripeSubscriptionScheduleId: {
      type: String,
      default: "",
      trim: true,
    },
    rentalReminderSentForDates: {
      type: [String],
      default: [],
    },
    stripeCheckoutSessionId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    stripePaymentIntentId: {
      type: String,
      default: "",
      trim: true,
    },
    paymentConfirmedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.Order || mongoose.model("Order", orderSchema);
