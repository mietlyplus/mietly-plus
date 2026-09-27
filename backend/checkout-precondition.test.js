"use strict";

// Must be set before requiring the app: the Stripe client is built at module load.
process.env.JWT_SECRET = "test-secret-for-checkout-precondition";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const app = require("./index");
const Product = require("./models/Product");
const User = require("./models/User");
const Order = require("./models/Order");

const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const CAMERA_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

// buyerPrice 20/week, delivery 5, no deposit -> 3 weeks x1 = 60 + 5 = 65.
const CAMERA = {
  _id: CAMERA_ID,
  title: "Camera",
  slug: "camera",
  imageUrl: "",
  brand: "Acme",
  isActive: true,
  buyerPrice: 20,
  offerPrice: 0,
  monthlyPrice: 0,
  monthlyBuyerPrice: 0,
  monthlyOfferPrice: 0,
  minimumRentalWeeks: 1,
  maximumRentalWeeks: 4,
  minimumRentalMonths: 1,
  maximumRentalMonths: 24,
  minimumRentalDays: 7,
  maximumRentalDays: 30,
  maxRentalQuantity: 2,
  deliveryFee: 5,
  depositEnabled: false,
  securityDeposit: 0,
  verificationRequired: false,
  categoryId: null,
  brandId: null,
};

const AUTHORITATIVE_TOTAL = 65;

let orderCreateCalls = 0;

test.before(() => {
  Product.find = () => {
    const query = {
      select: () => query,
      populate: () => query,
      lean: async () => [CAMERA],
    };
    return query;
  };

  User.findById = () => {
    const doc = {
      _id: USER_ID,
      name: "Test User",
      email: "test@example.test",
      phone: "",
      identityVerified: true,
      stripeCustomerId: "cus_existing",
      async save() {},
    };
    // The route calls .select().lean() on some paths and awaits the doc on others.
    doc.select = () => doc;
    doc.lean = async () => doc;
    doc.then = undefined;
    return Promise.resolve(doc);
  };

  // If a 409 leaks through to order creation, this makes it visible.
  Order.create = async () => {
    orderCreateCalls += 1;
    throw new Error("Order.create must not be reached when pricing is refused.");
  };
});

const token = () => jwt.sign({ sub: USER_ID, email: "test@example.test", role: "user" }, process.env.JWT_SECRET);

const SHIPPING = {
  fullName: "Test User",
  phone: "+4915100000000",
  line1: "Teststrasse 1",
  city: "Berlin",
  postalCode: "10115",
  country: "Germany",
};

async function postCheckoutSession(body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/payments/checkout-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
        body: JSON.stringify(body),
      }
    );
    // A request that passes the precondition proceeds to the sentinel
    // Order.create, which throws and yields a non-JSON error page.
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  } finally {
    server.close();
  }
}

const cartLine = {
  id: "line-a",
  productId: CAMERA_ID,
  quantity: 1,
  durationValue: 3,
  durationUnit: "week",
  startDate: "2026-10-01",
};

test("a stale expected total is refused with a refreshed quote instead of charging", async () => {
  const before = orderCreateCalls;

  const { status, body } = await postCheckoutSession({
    items: [cartLine],
    shippingAddress: SHIPPING,
    // What the customer saw before the catalogue moved.
    expectedTotal: 45,
  });

  assert.equal(status, 409);
  assert.equal(body.code, "PRICE_CHANGED");
  assert.equal(body.totals.total, AUTHORITATIVE_TOTAL, "the refreshed quote carries the real total");
  assert.equal(body.currency, "eur");
  assert.ok(Array.isArray(body.lines) && body.lines.length === 1, "lines are returned for re-render");
  assert.equal(body.lines[0].lineTotal, AUTHORITATIVE_TOTAL);
  assert.equal(orderCreateCalls, before, "no order is created and no Stripe session is opened");
});

test("a tampered low expected total cannot lower the price, it only triggers a refusal", async () => {
  const { status, body } = await postCheckoutSession({
    items: [cartLine],
    shippingAddress: SHIPPING,
    expectedTotal: 0.01,
  });

  assert.equal(status, 409);
  assert.equal(body.code, "PRICE_CHANGED");
  assert.equal(body.totals.total, AUTHORITATIVE_TOTAL, "server price is unmoved by the client value");
  assert.notEqual(body.totals.total, 0.01);
});

test("a tampered high expected total cannot raise the price either", async () => {
  const { status, body } = await postCheckoutSession({
    items: [cartLine],
    shippingAddress: SHIPPING,
    expectedTotal: 99999,
  });

  assert.equal(status, 409);
  assert.equal(body.totals.total, AUTHORITATIVE_TOTAL);
});

test("a non-numeric expected total is refused rather than ignored", async () => {
  // NaN is absent from this list because JSON serialises it to null, which is
  // a legitimate "no precondition supplied" — covered separately below.
  for (const expectedTotal of ["abc", {}, [], true, -5]) {
    const { status, body } = await postCheckoutSession({
      items: [cartLine],
      shippingAddress: SHIPPING,
      expectedTotal,
    });

    assert.equal(status, 409, `expected refusal for ${JSON.stringify(expectedTotal)}`);
    assert.equal(body.totals.total, AUTHORITATIVE_TOTAL);
  }
});

test("chargeable fields in the payload remain inert alongside the precondition", async () => {
  // Matching expectedTotal, but every money field is tampered with. The
  // precondition passes on the server's own figure, proving the tampered
  // amounts never entered the calculation.
  const { status, body } = await postCheckoutSession({
    items: [
      {
        ...cartLine,
        unitPrice: 0.01,
        baseUnitPrice: 0.01,
        securityDeposit: 0,
        deliveryFee: 0,
        lineTotal: 0.01,
        currency: "usd",
      },
    ],
    shippingAddress: SHIPPING,
    expectedTotal: AUTHORITATIVE_TOTAL,
  });

  // Passes the precondition, then fails at the sentinel Order.create — which is
  // only reachable because the server priced the line at 65, not the 0.01 sent.
  assert.notEqual(status, 409, "a correct expected total must not be refused");
  assert.notEqual(body.code, "PRICE_CHANGED");
  assert.ok(orderCreateCalls > 0, "pricing agreed, so order creation was reached");
});

test("omitting the expected total preserves the previous behaviour", async () => {
  const { status, body } = await postCheckoutSession({
    items: [cartLine],
    shippingAddress: SHIPPING,
  });

  assert.notEqual(status, 409);
  assert.notEqual(body.code, "PRICE_CHANGED");
});

test("null means no precondition, which is safe because the server still prices", async () => {
  // Skipping the precondition only costs the customer the confirmation step;
  // it cannot change the amount, which is always recalculated server-side.
  const { status, body } = await postCheckoutSession({
    items: [cartLine],
    shippingAddress: SHIPPING,
    expectedTotal: null,
  });

  assert.notEqual(status, 409);
  assert.notEqual(body.code, "PRICE_CHANGED");
});

test("a rounding-level difference is tolerated", async () => {
  const { status } = await postCheckoutSession({
    items: [cartLine],
    shippingAddress: SHIPPING,
    expectedTotal: AUTHORITATIVE_TOTAL + 0.009,
  });

  assert.notEqual(status, 409, "sub-cent drift must not block a legitimate checkout");
});
