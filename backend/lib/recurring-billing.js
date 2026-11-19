"use strict";

// Stripe-side handling of fixed-term recurring rentals.
//
// Checkout (mode: "subscription") bills the first period plus the one-time
// delivery fee and deposit. Right after it completes, the subscription is put
// on a subscription schedule that ends it automatically after the booked number
// of periods (end_behavior: "cancel"), so billing stops by itself.
//
// Everything here is idempotent. Stripe redelivers events and several events can
// describe the same invoice, so a paid invoice is counted once by its id.

const { buildSchedulePhases } = require("./billing");

const RECURRING_EVENT_TYPES = ["invoice.paid", "invoice.payment_failed", "customer.subscription.deleted"];

function idOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value.id || "").trim();
}

// Stripe API versions put the subscription on the invoice in different places.
function subscriptionIdOfInvoice(invoice) {
  return idOf(invoice?.subscription) || idOf(invoice?.parent?.subscription_details?.subscription);
}

function metadataOfInvoice(invoice) {
  return invoice?.parent?.subscription_details?.metadata || invoice?.subscription_details?.metadata || {};
}

function subscriptionIdOfEvent(stripeEvent) {
  const object = stripeEvent?.data?.object || {};
  return stripeEvent?.type === "customer.subscription.deleted" ? idOf(object) : subscriptionIdOfInvoice(object);
}

function metadataOfEvent(stripeEvent) {
  const object = stripeEvent?.data?.object || {};
  return stripeEvent?.type === "customer.subscription.deleted" ? object.metadata || {} : metadataOfInvoice(object);
}

// End of the period an invoice paid for = the next billing date. One-time lines
// have an empty period and do not move it.
function nextBillingDateOfInvoice(invoice) {
  const ends = (invoice?.lines?.data || [])
    .map((line) => Number(line?.period?.end))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (ends.length === 0) return null;
  return new Date(Math.max(...ends) * 1000);
}

/**
 * Marks the order as running on its recurring plan after the first payment.
 * @returns {boolean} whether anything changed
 */
function activateRecurringOrder(order, now = new Date()) {
  let changed = false;
  if (order.status !== "paid") {
    order.status = "paid";
    changed = true;
  }
  if (order.fulfillmentStatus === "pending") {
    order.fulfillmentStatus = "processing";
    changed = true;
  }
  if (!order.paymentConfirmedAt) {
    order.paymentConfirmedAt = now;
    changed = true;
  }
  if (order.paymentStatus === "unpaid") {
    order.paymentStatus = "partially_paid";
    changed = true;
  }
  if (order.recurring.status === "pending" || order.recurring.status === "past_due") {
    order.recurring.status = "active";
    changed = true;
  }
  return changed;
}

/**
 * Counts a paid invoice once. The term is only fully paid when every cycle has
 * been paid; until then the order is "partially_paid".
 * @returns {boolean} whether the invoice was new
 */
function recordPaidInvoice(order, invoiceId, { paidAt = new Date(), nextBillingDate } = {}) {
  const id = String(invoiceId || "").trim();
  if (!id || order.recurring.paidInvoiceIds.includes(id)) return false;

  order.recurring.paidInvoiceIds.push(id);
  order.recurring.successfulCycles = order.recurring.paidInvoiceIds.length;
  order.recurring.lastPaymentAt = paidAt;
  order.recurring.lastPaymentFailedAt = null;

  const finished = order.recurring.successfulCycles >= order.recurring.billingCycles;
  order.recurring.nextBillingDate = finished ? null : nextBillingDate || order.recurring.nextBillingDate || null;
  order.paymentStatus = finished ? "paid" : "partially_paid";
  order.recurring.status = finished ? "completed" : "active";
  return true;
}

function recordFailedPayment(order, failedAt = new Date()) {
  // A term that is already fully paid or ended is not reopened by a late event.
  if (["completed", "cancelled"].includes(order.recurring.status)) return false;
  if (order.recurring.status === "past_due") return false;
  order.recurring.status = "past_due";
  order.recurring.lastPaymentFailedAt = failedAt;
  return true;
}

function recordSubscriptionEnded(order) {
  const paidInFull = order.recurring.successfulCycles >= order.recurring.billingCycles;
  const next = paidInFull ? "completed" : "cancelled";
  if (order.recurring.status === next && !order.recurring.nextBillingDate) return false;
  order.recurring.status = next;
  order.recurring.nextBillingDate = null;
  if (paidInFull) order.paymentStatus = "paid";
  return true;
}

/**
 * Puts the subscription on a schedule that ends it after the booked term.
 * Safe to call repeatedly and from several events.
 */
async function ensureFixedTermSchedule({ stripe, order, subscriptionId }) {
  if (order.stripeSubscriptionScheduleId) return { created: false };

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price.product"],
  });

  const lines = [];
  for (const item of subscription.items?.data || []) {
    const orderItem = order.items[Number(item.price?.product?.metadata?.leihflussLine)];
    if (!orderItem || orderItem.billingType !== "recurring") continue;
    lines.push({ cycles: orderItem.durationValue, quantity: item.quantity, priceId: item.price.id });
  }
  if (lines.length === 0) {
    throw new Error(`Subscription ${subscriptionId} has no recurring items matching order ${order.orderNumber}.`);
  }

  const existingScheduleId = idOf(subscription.schedule);
  const schedule = existingScheduleId
    ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    : await stripe.subscriptionSchedules.create(
        { from_subscription: subscriptionId },
        { idempotencyKey: `leihfluss-schedule-create-${order._id}` }
      );

  const phases = buildSchedulePhases(lines).map((phase, index) => ({
    items: phase.items,
    iterations: phase.iterations,
    // The running phase keeps its start; later phases follow it directly.
    ...(index === 0 ? { start_date: schedule.phases[0].start_date } : {}),
  }));

  await stripe.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases,
      metadata: { orderId: String(order._id), orderNumber: order.orderNumber },
    },
    { idempotencyKey: `leihfluss-schedule-update-${order._id}` }
  );

  order.stripeSubscriptionScheduleId = schedule.id;
  await order.save();
  return { created: true, scheduleId: schedule.id };
}

module.exports = {
  RECURRING_EVENT_TYPES,
  activateRecurringOrder,
  ensureFixedTermSchedule,
  idOf,
  metadataOfEvent,
  nextBillingDateOfInvoice,
  recordFailedPayment,
  recordPaidInvoice,
  recordSubscriptionEnded,
  subscriptionIdOfEvent,
  subscriptionIdOfInvoice,
};
