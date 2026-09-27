const mongoose = require("mongoose");

// One document per Stripe event id. The unique index is the idempotency lock:
// a duplicate delivery fails the insert and is acknowledged without reprocessing.
const stripeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    type: {
      type: String,
      default: "",
      trim: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.StripeWebhookEvent ||
  mongoose.model("StripeWebhookEvent", stripeWebhookEventSchema);
