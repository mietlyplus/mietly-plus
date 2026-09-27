const mongoose = require("mongoose");

// One document per Stripe event id. The unique index is the idempotency lock,
// but existence alone is not proof of completion: a worker can die after
// claiming and before the order is saved. `status` distinguishes a claim that
// is still in flight from one that finished, so a retry after a crash can take
// over a stale claim instead of being discarded as a duplicate.
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
    status: {
      type: String,
      enum: ["processing", "completed"],
      default: "processing",
      index: true,
    },
    // Start of the current processing lease. Refreshed when a worker takes over
    // a claim abandoned by a crashed one.
    claimedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.StripeWebhookEvent ||
  mongoose.model("StripeWebhookEvent", stripeWebhookEventSchema);
