"use strict";

// Recurring-billing state and the Stripe webhook route, with Stripe stubbed.
process.env.JWT_SECRET = "test-secret-recurring-webhook";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_recurring";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const app = require("./index");
const { stripe, applyPaidCheckoutSession } = require("./index");
const Order = require("./models/Order");
const StripeWebhookEvent = require("./models/StripeWebhookEvent");
const { ensureFixedTermSchedule } = require("./lib/recurring-billing");
const { planBilling, buildPaymentSchedule, buildSchedulePhases } = require("./lib/billing");

const ORDER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

// A stand-in for a Mongoose Order with the recurring block, counting saves.
function recurringOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    orderNumber: "ORD-1",
    userId: USER_ID,
    billingMode: "recurring",
    status: "pending_payment",
    fulfillmentStatus: "pending",
    paymentStatus: "unpaid",
    paymentConfirmedAt: null,
    stripeSubscriptionId: "",
    stripeSubscriptionScheduleId: "",
    items: [{ billingType: "recurring", durationValue: 3, durationUnit: "week" }],
    recurring: {
      interval: "week", billingCycles: 3, successfulCycles: 0, recurringAmount: 20,
      totalRentalCommitment: 60, oneTimeCharges: 0, dueToday: 20, nextBillingDate: null,
      status: "pending", lastPaymentAt: null, lastPaymentFailedAt: null, paidInvoiceIds: [],
    },
    saveCount: 0,
    async save() { this.saveCount += 1; },
    ...overrides,
  };
}

const invoicePaid = (invoiceId, extra = {}) => ({
  id: `evt_${invoiceId}`, type: "invoice.paid", created: 1_800_000_000,
  data: { object: { id: invoiceId, parent: { subscription_details: { subscription: "sub_1", metadata: { orderId: ORDER_ID } } }, lines: { data: [{ period: { start: 1, end: 1_800_604_800 } }] }, ...extra } },
});
const invoiceFailed = (invoiceId) => ({ ...invoicePaid(invoiceId), id: `evt_f_${invoiceId}`, type: "invoice.payment_failed" });
const subscriptionDeleted = () => ({ id: "evt_del", type: "customer.subscription.deleted", created: 1_800_000_000, data: { object: { id: "sub_1", metadata: { orderId: ORDER_ID } } } });

// Fake of the Stripe calls the schedule step makes.
function fakeStripe({ schedule = null } = {}) {
  const calls = { create: 0, update: [] };
  return {
    calls,
    subscriptions: {
      retrieve: async () => ({
        id: "sub_1",
        schedule,
        items: { data: [{ quantity: 1, price: { id: "price_a", product: { metadata: { leihflussLine: "0" } } } }] },
      }),
    },
    subscriptionSchedules: {
      create: async () => { calls.create += 1; return { id: "sub_sched_1", phases: [{ start_date: 1_700_000_000 }] }; },
      retrieve: async (scheduleId) => ({ id: scheduleId, phases: [{ start_date: 1_700_000_000 }] }),
      update: async (scheduleId, params) => { calls.update.push({ scheduleId, params }); return {}; },
    },
  };
}

// --- planning -----------------------------------------------------------------

const item = (durationValue, durationUnit, perPeriod, quantity = 1) => ({
  billingType: durationValue > 1 ? "recurring" : "one_time", durationValue, durationUnit,
  recurringPerUnit: durationValue > 1 ? perPeriod : 0, quantity,
});

test("billing plan: 3 weeks at 20 is a weekly fixed term of 3 payments of 20", () => {
  const plan = planBilling([item(3, "week", 20)]);
  assert.equal(plan.mode, "recurring");
  assert.equal(plan.interval, "week");
  assert.equal(plan.cycles, 3);
  assert.deepEqual(plan.schedule, [{ payments: 3, amount: 20 }]);
});

test("billing plan: lines of different lengths drop out as they end", () => {
  const plan = planBilling([item(3, "month", 50), item(2, "month", 10)]);
  assert.deepEqual(plan.schedule, [{ payments: 2, amount: 60 }, { payments: 1, amount: 50 }]);
  const phases = buildSchedulePhases([
    { cycles: 3, quantity: 1, priceId: "p_long" },
    { cycles: 2, quantity: 2, priceId: "p_short" },
  ]);
  assert.deepEqual(phases, [
    { iterations: 2, items: [{ price: "p_long", quantity: 1 }, { price: "p_short", quantity: 2 }] },
    { iterations: 1, items: [{ price: "p_long", quantity: 1 }] },
  ]);
});

test("billing plan: single-period rentals are one-time and mixed intervals are refused", () => {
  assert.equal(planBilling([item(1, "week", 20)]).mode, "one_time");
  assert.equal(planBilling([]).mode, "one_time");
  const mixed = planBilling([item(3, "week", 20), item(3, "month", 50)]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, "MIXED_BILLING_INTERVALS");
  assert.deepEqual(buildPaymentSchedule([item(2, "week", 5, 2)]), [{ payments: 2, amount: 10 }]);
});

// --- fixed-term ending ----------------------------------------------------------

test("the subscription is put on a schedule that cancels itself after the booked cycles", async () => {
  const fake = fakeStripe();
  const order = recurringOrder();
  const result = await ensureFixedTermSchedule({ stripe: fake, order, subscriptionId: "sub_1" });

  assert.equal(result.created, true);
  assert.equal(fake.calls.create, 1);
  const { scheduleId, params } = fake.calls.update[0];
  assert.equal(scheduleId, "sub_sched_1");
  assert.equal(params.end_behavior, "cancel", "billing stops automatically");
  assert.equal(params.phases.length, 1);
  assert.equal(params.phases[0].iterations, 3, "exactly 3 weekly payments");
  assert.equal(params.phases[0].start_date, 1_700_000_000, "the running period is kept");
  assert.deepEqual(params.phases[0].items, [{ price: "price_a", quantity: 1 }]);
  assert.equal(order.stripeSubscriptionScheduleId, "sub_sched_1");
});

test("scheduling is idempotent: a repeat does not call Stripe again, an existing schedule is reused", async () => {
  const fake = fakeStripe();
  const order = recurringOrder();
  await ensureFixedTermSchedule({ stripe: fake, order, subscriptionId: "sub_1" });
  const again = await ensureFixedTermSchedule({ stripe: fake, order, subscriptionId: "sub_1" });
  assert.equal(again.created, false);
  assert.equal(fake.calls.update.length, 1);

  const reuse = fakeStripe({ schedule: "sub_sched_existing" });
  await ensureFixedTermSchedule({ stripe: reuse, order: recurringOrder(), subscriptionId: "sub_1" });
  assert.equal(reuse.calls.create, 0, "no second schedule is created for the same subscription");
  assert.equal(reuse.calls.update[0].scheduleId, "sub_sched_existing");
});

// --- payment state --------------------------------------------------------------

test("the first payment does NOT mean the whole rental is paid", async () => {
  const order = recurringOrder();
  const result = await applyPaidCheckoutSession(order, { subscription: "sub_1", invoice: "in_1", payment_status: "paid" });

  assert.equal(result.changed, true);
  assert.equal(order.status, "paid", "the order is confirmed and can be fulfilled");
  assert.equal(order.paymentStatus, "partially_paid");
  assert.equal(order.recurring.status, "active");
  assert.equal(order.recurring.successfulCycles, 1);
  assert.equal(order.recurring.billingCycles, 3);
  assert.equal(order.stripeSubscriptionId, "sub_1");
  assert.equal(order.fulfillmentStatus, "processing");
});

test("the same first payment arriving again, or as invoice.paid, is not counted twice", async () => {
  const { processRecurringEvent } = require("./index");
  const order = recurringOrder();
  const session = { subscription: "sub_1", invoice: "in_1", payment_status: "paid" };
  await applyPaidCheckoutSession(order, session);
  const replay = await applyPaidCheckoutSession(order, session);
  assert.equal(replay.changed, false);

  await processRecurringEvent(invoicePaid("in_1"), order, fakeStripe());
  assert.equal(order.recurring.successfulCycles, 1);
  assert.equal(order.paymentStatus, "partially_paid");
});

test("recurring payments are counted one by one until the term is paid", async () => {
  const { processRecurringEvent } = require("./index");
  const order = recurringOrder();
  const fake = fakeStripe();
  await applyPaidCheckoutSession(order, { subscription: "sub_1", invoice: "in_1" });

  await processRecurringEvent(invoicePaid("in_2"), order, fake);
  assert.equal(order.recurring.successfulCycles, 2);
  assert.equal(order.paymentStatus, "partially_paid");
  assert.ok(order.recurring.nextBillingDate instanceof Date);

  await processRecurringEvent(invoicePaid("in_3"), order, fake);
  assert.equal(order.recurring.successfulCycles, 3);
  assert.equal(order.paymentStatus, "paid", "only now is the whole rental paid");
  assert.equal(order.recurring.status, "completed");
  assert.equal(order.recurring.nextBillingDate, null);

  // A late redelivery of an earlier invoice changes nothing.
  await processRecurringEvent(invoicePaid("in_2"), order, fake);
  assert.equal(order.recurring.successfulCycles, 3);
});

test("a failed recurring payment marks the order past due and the next success recovers it", async () => {
  const { processRecurringEvent } = require("./index");
  const order = recurringOrder();
  const fake = fakeStripe();
  await applyPaidCheckoutSession(order, { subscription: "sub_1", invoice: "in_1" });

  await processRecurringEvent(invoiceFailed("in_2"), order, fake);
  assert.equal(order.recurring.status, "past_due");
  assert.equal(order.paymentStatus, "partially_paid", "money already paid is not forgotten");
  assert.ok(order.recurring.lastPaymentFailedAt instanceof Date);

  await processRecurringEvent(invoicePaid("in_2"), order, fake);
  assert.equal(order.recurring.status, "active");
  assert.equal(order.recurring.lastPaymentFailedAt, null);
  assert.equal(order.recurring.successfulCycles, 2);
});

test("subscription ending: completed when every cycle was paid, cancelled when it stopped early", async () => {
  const { processRecurringEvent } = require("./index");
  const fake = fakeStripe();

  const full = recurringOrder();
  await applyPaidCheckoutSession(full, { subscription: "sub_1", invoice: "in_1" });
  await processRecurringEvent(invoicePaid("in_2"), full, fake);
  await processRecurringEvent(invoicePaid("in_3"), full, fake);
  await processRecurringEvent(subscriptionDeleted(), full, fake);
  assert.equal(full.recurring.status, "completed");
  assert.equal(full.paymentStatus, "paid");

  const early = recurringOrder();
  await applyPaidCheckoutSession(early, { subscription: "sub_1", invoice: "in_1" });
  await processRecurringEvent(subscriptionDeleted(), early, fake);
  assert.equal(early.recurring.status, "cancelled");
  assert.equal(early.paymentStatus, "partially_paid", "an early stop never reads as fully paid");
  assert.equal(early.recurring.nextBillingDate, null);

  // A failed-payment event after the term ended does not reopen it.
  await processRecurringEvent(invoiceFailed("in_9"), early, fake);
  assert.equal(early.recurring.status, "cancelled");
});

test("historical one-time orders behave exactly as before", async () => {
  const order = { saveCount: 0, status: "pending_payment", fulfillmentStatus: "pending", paymentStatus: "unpaid", async save() { this.saveCount += 1; } };
  await applyPaidCheckoutSession(order, { payment_intent: "pi_1" });
  assert.equal(order.paymentStatus, "paid");
  assert.equal(order.stripePaymentIntentId, "pi_1");
});

// --- webhook route: signature, order matching, event-level idempotency -----------

function installEventStore() {
  const rows = new Map();
  StripeWebhookEvent.create = async (doc) => {
    if (rows.has(doc.eventId)) { const error = new Error("dup"); error.code = 11000; throw error; }
    rows.set(doc.eventId, { ...doc, status: doc.status || "processing", claimedAt: doc.claimedAt || new Date() });
    return rows.get(doc.eventId);
  };
  StripeWebhookEvent.findOne = async (filter) => rows.get(filter.eventId) || null;
  StripeWebhookEvent.findOneAndUpdate = async () => null;
  StripeWebhookEvent.updateOne = async (filter, update) => { Object.assign(rows.get(filter.eventId) || {}, update.$set); return {}; };
  StripeWebhookEvent.deleteOne = async (filter) => { rows.delete(filter.eventId); return {}; };
  return rows;
}

async function deliver(event) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/stripe-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": header },
      body: payload,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("webhook route: recurring events are verified, applied once and duplicates are ignored", async () => {
  const rows = installEventStore();
  const order = recurringOrder({ stripeSubscriptionId: "sub_1" });
  Order.findOne = async (filter) => (filter.stripeSubscriptionId === "sub_1" ? order : null);
  Order.findById = async () => order;
  const fake = fakeStripe();
  Object.assign(stripe, { subscriptions: fake.subscriptions, subscriptionSchedules: fake.subscriptionSchedules });

  const first = await deliver(invoicePaid("in_1"));
  assert.equal(first.status, 200);
  assert.equal(order.recurring.successfulCycles, 1);
  assert.equal(order.paymentStatus, "partially_paid");
  assert.equal(rows.get("evt_in_1").status, "completed");

  const second = await deliver(invoicePaid("in_1"));
  assert.equal(second.body.duplicate, true, "the same Stripe event is a duplicate");
  assert.equal(order.recurring.successfulCycles, 1);

  const next = await deliver(invoicePaid("in_2"));
  assert.equal(next.status, 200);
  assert.equal(order.recurring.successfulCycles, 2);

  const failed = await deliver(invoiceFailed("in_3"));
  assert.equal(failed.status, 200);
  assert.equal(order.recurring.status, "past_due");

});

test("webhook route: a forged signature is rejected and touches nothing", async () => {
  installEventStore();
  const order = recurringOrder({ stripeSubscriptionId: "sub_1" });
  Order.findOne = async () => order;
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/stripe-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify(invoicePaid("in_forged")),
    });
    assert.equal(response.status, 400);
  } finally {
    server.close();
  }
  assert.equal(order.recurring.successfulCycles, 0);
});

test("webhook route: an event that belongs to no recurring order is acknowledged and changes nothing", async () => {
  installEventStore();
  Order.findOne = async () => null;
  Order.findById = async () => null;
  Object.assign(stripe, { subscriptions: { retrieve: async () => ({ metadata: {} }) } });

  const old = { ...invoicePaid("in_x"), created: Math.floor(Date.now() / 1000) - 3600 };
  const result = await deliver(old);
  assert.equal(result.status, 200);
  assert.equal(result.body.matched, false);
});

// --- /checkout-confirm fallback ---------------------------------------------------

test("checkout-confirm attaches the fixed-term schedule for a recurring order, once, and skips one-time orders", async () => {
  const jwt = require("jsonwebtoken");
  const User = require("./models/User");
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: USER_ID }) }) });
  const fake = fakeStripe();
  Object.assign(stripe, {
    subscriptions: fake.subscriptions,
    subscriptionSchedules: fake.subscriptionSchedules,
    checkout: { sessions: { retrieve: async () => ({ payment_status: "paid", subscription: "sub_1", invoice: "in_1" }) } },
  });

  const confirm = async (order) => {
    Order.findOne = async () => order;
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/checkout-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ sub: USER_ID, role: "user" }, process.env.JWT_SECRET)}` },
        body: JSON.stringify({ sessionId: "cs_1" }),
      });
      return response.status;
    } finally {
      server.close();
    }
  };

  const order = recurringOrder();
  assert.equal(await confirm(order), 200);
  assert.equal(order.paymentStatus, "partially_paid");
  assert.equal(fake.calls.update.length, 1);
  assert.equal(fake.calls.update[0].params.end_behavior, "cancel");
  assert.equal(order.stripeSubscriptionScheduleId, "sub_sched_1");

  // Confirming again (or the webhook arriving later) does not create a second schedule.
  assert.equal(await confirm(order), 200);
  assert.equal(fake.calls.update.length, 1);

  // A paid order whose schedule step failed earlier is repaired on the next confirm.
  const unscheduled = recurringOrder({ stripeSubscriptionId: "sub_1", paymentStatus: "partially_paid" });
  assert.equal(await confirm(unscheduled), 200);
  assert.equal(fake.calls.update.length, 2);

  // One-time orders never touch the schedule API.
  const oneTime = { ...recurringOrder(), billingMode: "one_time", recurring: undefined, paymentStatus: "unpaid", status: "pending_payment" };
  assert.equal(await confirm(oneTime), 200);
  assert.equal(fake.calls.update.length, 2);
  assert.equal(oneTime.paymentStatus, "paid");
});
