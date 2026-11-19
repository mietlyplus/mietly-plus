"use strict";

// Checkout for recurring (fixed-term) and one-time rentals, through the real
// route with the Stripe client stubbed. Nothing here talks to Stripe.
process.env.JWT_SECRET = "test-secret-for-checkout-recurring";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.FRONTEND_URL = "https://www.leihfluss.example";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const app = require("./index");
const { stripe } = require("./index");
const Product = require("./models/Product");
const User = require("./models/User");
const Order = require("./models/Order");
const { earliestStartDate } = require("./lib/delivery-lead-time");

const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const id = (n) => String(n).repeat(24).slice(0, 24);

const base = {
  slug: "p", imageUrl: "", brand: "", isActive: true,
  buyerPrice: 0, offerPrice: 0, monthlyPrice: 0, monthlyBuyerPrice: 0, monthlyOfferPrice: 0,
  minimumRentalWeeks: 1, maximumRentalWeeks: 12, minimumRentalMonths: 1, maximumRentalMonths: 12,
  minimumRentalDays: 7, maximumRentalDays: 30, maxRentalQuantity: 3,
  deliveryFee: 0, depositEnabled: false, securityDeposit: 0, verificationRequired: false,
  categoryId: null, brandId: null,
};
const CATALOGUE = {
  [id(1)]: { ...base, _id: id(1), title: "Camera", buyerPrice: 20, monthlyBuyerPrice: 50, deliveryFee: 5, depositEnabled: true, securityDeposit: 40 },
  [id(2)]: { ...base, _id: id(2), title: "Drone", buyerPrice: 30, monthlyBuyerPrice: 90 },
  [id(3)]: { ...base, _id: id(3), title: "Castle", rentalMode: "occasion", occasionDailyRate: 50, deliveryFee: 10, depositEnabled: true, securityDeposit: 30, maxRentalQuantity: 1 },
  [id(4)]: { ...base, _id: id(4), title: "Gone", isActive: false, buyerPrice: 10, monthlyBuyerPrice: 30 },
};

let sessionParams;
let createdOrder;

test.before(() => {
  Product.find = (filter) => {
    const docs = (filter?._id?.$in || []).map((value) => CATALOGUE[String(value)]).filter(Boolean);
    const query = { select: () => query, populate: () => query, lean: async () => docs };
    return query;
  };
  User.findById = () => {
    const doc = { _id: USER_ID, name: "Test User", email: "test@example.test", phone: "", identityVerified: true, stripeCustomerId: "cus_x", async save() {} };
    doc.select = () => doc;
    doc.lean = async () => doc;
    return Promise.resolve(doc);
  };
  Order.create = async (doc) => {
    createdOrder = { _id: id(9), ...doc, async save() {} };
    return createdOrder;
  };
  stripe.checkout.sessions.create = async (params) => {
    sessionParams = params;
    return { id: "cs_test_1", url: "https://checkout.example/cs_test_1" };
  };
});

test.beforeEach(() => {
  sessionParams = undefined;
  createdOrder = undefined;
});

const token = () => jwt.sign({ sub: USER_ID, email: "test@example.test", role: "user" }, process.env.JWT_SECRET);
const SHIPPING = { fullName: "Test User", phone: "+4915100000000", line1: "Teststrasse 1", city: "Berlin", postalCode: "10115", country: "Germany" };

const line = (productId, durationUnit, durationValue, extra = {}) => ({
  id: `line-${productId}-${durationUnit}-${durationValue}`, productId, quantity: 1, durationValue, durationUnit,
  startDate: earliestStartDate(30), ...extra,
});

async function checkout(items, extra = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments/checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ items, shippingAddress: SHIPPING, ...extra }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("3-week rental: a weekly subscription, first week due today, delivery and deposit once", async () => {
  const { status, body } = await checkout([line(id(1), "week", 3)]);
  assert.equal(status, 201, JSON.stringify(body));

  assert.equal(sessionParams.mode, "subscription");
  const [recurring, oneTime] = sessionParams.line_items;
  assert.equal(recurring.price_data.unit_amount, 2000, "20 per week, not 60 upfront");
  assert.deepEqual(recurring.price_data.recurring, { interval: "week", interval_count: 1 });
  assert.equal(recurring.price_data.product_data.metadata.leihflussLine, "0");
  assert.equal(oneTime.price_data.recurring, undefined, "delivery + deposit are not recurring");
  assert.equal(oneTime.price_data.unit_amount, 4500, "5 delivery + 40 deposit, once");
  assert.equal(sessionParams.line_items.length, 2);
  assert.equal(sessionParams.subscription_data.metadata.orderId, id(9));
  assert.equal(sessionParams.metadata.orderId, id(9));

  assert.equal(createdOrder.billingMode, "recurring");
  assert.equal(createdOrder.paymentStatus, "unpaid");
  assert.equal(createdOrder.recurring.billingCycles, 3);
  assert.equal(createdOrder.recurring.interval, "week");
  assert.equal(createdOrder.recurring.recurringAmount, 20);
  assert.equal(createdOrder.recurring.totalRentalCommitment, 60);
  assert.equal(createdOrder.recurring.oneTimeCharges, 45);
  assert.equal(createdOrder.recurring.dueToday, 65);
  assert.equal(createdOrder.total, 105);
  assert.equal(body.dueToday, 65);
});

test("multi-month rental: a monthly subscription for the booked number of months", async () => {
  const { status } = await checkout([line(id(1), "month", 6)]);
  assert.equal(status, 201);
  assert.equal(sessionParams.mode, "subscription");
  assert.deepEqual(sessionParams.line_items[0].price_data.recurring, { interval: "month", interval_count: 1 });
  assert.equal(sessionParams.line_items[0].price_data.unit_amount, 5000);
  assert.equal(createdOrder.recurring.billingCycles, 6);
  assert.equal(createdOrder.recurring.totalRentalCommitment, 300);
});

test("quantity scales the recurring rental and the one-time fees, never the term", async () => {
  await checkout([line(id(1), "week", 2, { quantity: 2 })]);
  assert.equal(sessionParams.line_items[0].quantity, 2);
  assert.equal(sessionParams.line_items[0].price_data.unit_amount, 2000);
  assert.equal(sessionParams.line_items[1].quantity, 2);
  assert.equal(createdOrder.recurring.dueToday, 2 * 20 + 2 * 45);
});

test("a one-week rental is a single payment, not a subscription", async () => {
  await checkout([line(id(1), "week", 1)]);
  assert.equal(sessionParams.mode, "payment");
  assert.equal(sessionParams.line_items.length, 1);
  assert.equal(sessionParams.line_items[0].price_data.unit_amount, 6500, "20 + 5 + 40 once");
  assert.equal(createdOrder.billingMode, "one_time");
  assert.equal(createdOrder.recurring, undefined);
});

test("occasion rental: daily rate x days charged once, no subscription", async () => {
  const { status } = await checkout([line(id(3), "day", 3)]);
  assert.equal(status, 201);
  assert.equal(sessionParams.mode, "payment");
  assert.equal(sessionParams.subscription_data, undefined);
  assert.equal(sessionParams.line_items[0].price_data.recurring, undefined);
  assert.equal(sessionParams.line_items[0].price_data.unit_amount, 15000 + 1000 + 3000, "3 x 50 + delivery 10 + deposit 30");
  assert.equal(createdOrder.billingMode, "one_time");
  assert.equal(createdOrder.total, 190);
});

test("a tampered browser price, interval or amount changes nothing", async () => {
  const tampered = line(id(1), "week", 3, { unitPrice: 0.01, baseUnitPrice: 0.01, lineTotal: 0.01, deliveryFee: 0, securityDeposit: 0, interval: "day", billingMode: "one_time" });
  const { status } = await checkout([tampered]);
  assert.equal(status, 201);
  assert.equal(sessionParams.line_items[0].price_data.unit_amount, 2000);
  assert.equal(sessionParams.line_items[1].price_data.unit_amount, 4500);
  assert.equal(sessionParams.mode, "subscription");

  // The amount the customer approved must match, and so must the amount due today.
  const stale = await checkout([line(id(1), "week", 3)], { expectedTotal: 60 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "PRICE_CHANGED");
  const staleToday = await checkout([line(id(1), "week", 3)], { expectedTotal: 105, expectedDueToday: 105 });
  assert.equal(staleToday.status, 409, "paying the whole term upfront was not what was approved");
  const fine = await checkout([line(id(1), "week", 3)], { expectedTotal: 105, expectedDueToday: 65 });
  assert.equal(fine.status, 201);
});

test("weekly and monthly subscriptions cannot share one checkout; a one-period line can join either", async () => {
  const mixed = await checkout([line(id(1), "week", 3), line(id(2), "month", 3)]);
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.issues[0].code, "MIXED_BILLING_INTERVALS");
  assert.equal(sessionParams, undefined, "no Stripe session is created");

  const withSingle = await checkout([line(id(1), "week", 3), line(id(2), "month", 1)]);
  assert.equal(withSingle.status, 201);
  assert.equal(sessionParams.mode, "subscription");
  const oneTimeLine = sessionParams.line_items.find((item) => item.price_data.product_data.name === "Drone");
  assert.equal(oneTimeLine.price_data.recurring, undefined);
  assert.equal(oneTimeLine.price_data.unit_amount, 9000, "the single month is paid on the first invoice");
});

test("inactive and missing products are refused before anything is created", async () => {
  const inactive = await checkout([line(id(4), "week", 3)]);
  assert.equal(inactive.status, 400);
  assert.equal(inactive.body.issues[0].code, "PRODUCT_INACTIVE");
  const missing = await checkout([line(id(8), "week", 3)]);
  assert.equal(missing.body.issues[0].code, "PRODUCT_NOT_FOUND");
  assert.equal(createdOrder, undefined);
  assert.equal(sessionParams, undefined);
});

test("durations outside the product's limits are refused", async () => {
  assert.equal((await checkout([line(id(1), "week", 13)])).body.issues[0].code, "INVALID_DURATION");
  assert.equal((await checkout([line(id(3), "day", 8)])).body.issues[0].code, "INVALID_DURATION");
});
