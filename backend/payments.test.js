"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyPaidCheckoutSession, markCheckoutSessionUnpaid } = require("./index");

// Minimal stand-in for a Mongoose Order document; `save` just records calls so
// the transition guards can be exercised without a database.
function buildOrder(overrides = {}) {
  return {
    saveCount: 0,
    status: "pending_payment",
    fulfillmentStatus: "pending",
    paymentStatus: "unpaid",
    stripePaymentIntentId: "",
    paymentConfirmedAt: null,
    async save() {
      this.saveCount += 1;
    },
    ...overrides,
  };
}

test("a completed session marks the order paid and records the payment intent", async () => {
  const order = buildOrder();
  const result = await applyPaidCheckoutSession(order, { payment_intent: "pi_123" });

  assert.equal(result.changed, true);
  assert.equal(order.status, "paid");
  assert.equal(order.paymentStatus, "paid");
  assert.equal(order.fulfillmentStatus, "processing");
  assert.equal(order.stripePaymentIntentId, "pi_123");
  assert.ok(order.paymentConfirmedAt instanceof Date);
  assert.equal(order.saveCount, 1);
});

test("replaying the same paid session is a no-op", async () => {
  const order = buildOrder();
  await applyPaidCheckoutSession(order, { payment_intent: "pi_123" });
  const confirmedAt = order.paymentConfirmedAt;

  const replay = await applyPaidCheckoutSession(order, { payment_intent: "pi_999" });

  assert.equal(replay.changed, false);
  assert.equal(order.saveCount, 1, "must not write again on redelivery");
  assert.equal(order.stripePaymentIntentId, "pi_123", "must not overwrite the original intent");
  assert.equal(order.paymentConfirmedAt, confirmedAt);
});

test("confirming does not regress fulfillment progress already made by an admin", async () => {
  const order = buildOrder({ fulfillmentStatus: "shipped" });
  await applyPaidCheckoutSession(order, { payment_intent: "pi_123" });
  assert.equal(order.fulfillmentStatus, "shipped");
});

test("a paid order is never downgraded to unpaid", async () => {
  const order = buildOrder();
  await applyPaidCheckoutSession(order, { payment_intent: "pi_123" });

  const result = await markCheckoutSessionUnpaid(order);

  assert.equal(result.changed, false);
  assert.equal(order.paymentStatus, "paid");
  assert.equal(order.status, "paid");
  assert.equal(order.saveCount, 1);
});

test("an order already awaiting payment is not rewritten", async () => {
  const order = buildOrder();
  const result = await markCheckoutSessionUnpaid(order);

  assert.equal(result.changed, false);
  assert.equal(order.saveCount, 0);
});

test("a failed async payment resets a non-paid order to awaiting payment", async () => {
  const order = buildOrder({ status: "failed", fulfillmentStatus: "processing" });
  const result = await markCheckoutSessionUnpaid(order);

  assert.equal(result.changed, true);
  assert.equal(order.status, "pending_payment");
  assert.equal(order.fulfillmentStatus, "pending");
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(order.saveCount, 1);
});

test("a missing payment intent leaves any existing intent untouched", async () => {
  const order = buildOrder({ stripePaymentIntentId: "pi_existing" });
  await applyPaidCheckoutSession(order, {});
  assert.equal(order.stripePaymentIntentId, "pi_existing");
});
