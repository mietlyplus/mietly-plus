"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const app = require("./index");
const Product = require("./models/Product");

const CAMERA_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TRIPOD_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

const CATALOGUE = {
  [CAMERA_ID]: {
    _id: CAMERA_ID,
    title: "Camera",
    slug: "camera",
    imageUrl: "https://example.test/camera.jpg",
    brand: "Acme",
    isActive: true,
    buyerPrice: 20,
    offerPrice: 15,
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
    depositEnabled: true,
    securityDeposit: 100,
    verificationRequired: true,
    categoryId: { _id: "c1", name: { en: "Cameras", de: "Kameras" }, slug: "cameras" },
    brandId: { _id: "b1", name: "Acme", slug: "acme" },
  },
  [TRIPOD_ID]: {
    _id: TRIPOD_ID,
    title: "Tripod",
    slug: "tripod",
    imageUrl: "",
    brand: "",
    isActive: true,
    buyerPrice: 10,
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
    maxRentalQuantity: 1,
    deliveryFee: 0,
    depositEnabled: false,
    securityDeposit: 0,
    verificationRequired: false,
    categoryId: null,
    brandId: null,
  },
};

// Chainable stand-in for the Mongoose query builder used by loadCartProducts.
function stubProductFind() {
  Product.find = (filter) => {
    const ids = filter?._id?.$in || [];
    const docs = ids.map((id) => CATALOGUE[String(id)]).filter(Boolean);
    const query = {
      select: () => query,
      populate: () => query,
      lean: async () => docs,
    };
    return query;
  };
}

async function postQuote(items) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/payments/checkout-quote`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      }
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test.before(() => stubProductFind());

test("an empty cart quotes to zero and is valid", async () => {
  const { status, body } = await postQuote([]);
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.deepEqual(body.totals, { subtotal: 0, depositTotal: 0, deliveryTotal: 0, total: 0, dueToday: 0 });
});

test("a valid cart is priced from the catalogue, not from the request", async () => {
  const { status, body } = await postQuote([
    {
      id: "line-a",
      productId: CAMERA_ID,
      quantity: 2,
      durationValue: 3,
      durationUnit: "week",
      startDate: require("./lib/delivery-lead-time").earliestStartDate(30),
      // Tampered amounts that must be ignored.
      unitPrice: 0.01,
      securityDeposit: 0,
      deliveryFee: 0,
    },
  ]);

  assert.equal(status, 200);
  assert.equal(body.valid, true);

  const [line] = body.lines;
  assert.equal(line.lineId, "line-a");
  assert.equal(line.title, "Camera");
  assert.equal(line.baseUnitPrice, 15, "offer price wins");
  assert.equal(line.unitPrice, 45, "15 x 3 weeks");
  assert.equal(line.lineSubtotal, 90);
  assert.equal(line.lineDeposit, 200);
  assert.equal(line.lineDelivery, 10);
  assert.equal(line.lineTotal, 300);
  assert.equal(line.categoryName, "Cameras");
  assert.equal(line.brandName, "Acme");

  // 3 weeks is a fixed-term recurring rental: only the first week is due today.
  assert.equal(line.billingType, "recurring");
  assert.equal(line.recurringPerPeriod, 30, "2 cameras x 15 per week");
  assert.equal(line.remainingPayments, 2);
  assert.equal(line.lineDueToday, 240, "first week 30 + one-time deposit 200 + one-time delivery 10");

  assert.deepEqual(body.totals, {
    subtotal: 90,
    depositTotal: 200,
    deliveryTotal: 10,
    total: 300,
    dueToday: 240,
  });
  assert.deepEqual(body.billing, {
    mode: "recurring", interval: "week", billingCycles: 3, dueToday: 240, totalRental: 90,
    oneTimeCharges: 210, recurringAmount: 30, upcoming: [{ payments: 2, amount: 30 }],
  });
  assert.equal(body.requiresIdentityVerification, true);
});

test("the quote exposes the quantity cap the backend enforces", async () => {
  const { body } = await postQuote([
    { id: "line-a", productId: CAMERA_ID, quantity: 1, durationValue: 1, durationUnit: "week" },
    { id: "line-b", productId: TRIPOD_ID, quantity: 1, durationValue: 1, durationUnit: "week" },
  ]);

  const byId = Object.fromEntries(body.lines.map((line) => [line.lineId, line]));
  assert.equal(byId["line-a"].limits.maxQuantity, 2);
  assert.equal(byId["line-b"].limits.maxQuantity, 1);
  assert.deepEqual(byId["line-a"].limits.availableUnits, ["week"]);
  assert.equal(byId["line-a"].limits.minDuration, 1);
  assert.equal(byId["line-a"].limits.maxDuration, 4);
});

test("an over-cap quantity is reported with the cap, so the cart can clamp", async () => {
  const { body } = await postQuote([
    { id: "line-b", productId: TRIPOD_ID, quantity: 5, durationValue: 1, durationUnit: "week" },
  ]);

  assert.equal(body.valid, false);
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].code, "INVALID_QUANTITY");
  assert.equal(body.issues[0].lineId, "line-b");

  const [line] = body.lines;
  assert.equal(line.valid, false);
  assert.equal(line.limits.maxQuantity, 1, "cap is still reported on an invalid line");
  assert.equal(line.issue.code, "INVALID_QUANTITY");

  // An invalid line contributes nothing to the total.
  assert.equal(body.totals.total, 0);
});

test("an unknown product is reported without failing the whole request", async () => {
  const { status, body } = await postQuote([
    { id: "line-a", productId: CAMERA_ID, quantity: 1, durationValue: 1, durationUnit: "week" },
    { id: "line-x", productId: "cccccccccccccccccccccccc", quantity: 1, durationValue: 1, durationUnit: "week" },
  ]);

  assert.equal(status, 200);
  assert.equal(body.valid, false);
  assert.equal(body.issues[0].code, "PRODUCT_NOT_FOUND");
  // The valid line is still priced so the cart can render the rest.
  assert.equal(body.totals.subtotal, 15);
});

test("a malformed product reference is reported as a line issue", async () => {
  const { body } = await postQuote([
    { id: "line-z", productId: "not-an-id", quantity: 1, durationValue: 1, durationUnit: "week" },
  ]);

  assert.equal(body.valid, false);
  assert.equal(body.issues[0].code, "INVALID_PRODUCT_REFERENCE");
  assert.equal(body.issues[0].lineId, "line-z");
});

test("identity verification is only required when a line demands it", async () => {
  const { body } = await postQuote([
    { id: "line-b", productId: TRIPOD_ID, quantity: 1, durationValue: 1, durationUnit: "week" },
  ]);

  assert.equal(body.valid, true);
  assert.equal(body.requiresIdentityVerification, false);
  assert.equal(body.totals.total, 10);
});

test("an oversized cart is rejected outright", async () => {
  const items = Array.from({ length: 51 }, (_, index) => ({
    id: `line-${index}`,
    productId: CAMERA_ID,
    quantity: 1,
    durationValue: 1,
    durationUnit: "week",
  }));

  const { status } = await postQuote(items);
  assert.equal(status, 400);
});

test("a quote does not require a start date", async () => {
  const { body } = await postQuote([
    { id: "line-a", productId: CAMERA_ID, quantity: 1, durationValue: 1, durationUnit: "week" },
  ]);
  assert.equal(body.valid, true);
});

// --- occasion products and delivery lead time through the real route ---------

const CASTLE_ID = "111111111111111111111111";
const { earliestStartDate } = require("./lib/delivery-lead-time");

test.before(() => {
  CATALOGUE[CASTLE_ID] = {
    _id: CASTLE_ID,
    title: "Rainbow Castle",
    slug: "rainbow-castle",
    imageUrl: "",
    brand: "Leihfluss",
    isActive: true,
    rentalMode: "occasion",
    occasionDailyRate: 50,
    deliveryLeadDays: 3,
    buyerPrice: 0, monthlyPrice: 0, monthlyBuyerPrice: 0,
    maxRentalQuantity: 1,
    deliveryFee: 10,
    depositEnabled: true,
    securityDeposit: 30,
    verificationRequired: false,
    categoryId: null,
    brandId: null,
  };
  CATALOGUE["222222222222222222222222"] = { ...CATALOGUE[TRIPOD_ID], _id: "222222222222222222222222", isActive: false };
});

const castleLine = (overrides = {}) => ({
  id: "castle", productId: CASTLE_ID, quantity: 1, durationValue: 2, durationUnit: "day",
  startDate: earliestStartDate(3), ...overrides,
});

test("occasion: the quote charges the stored price for the chosen days and ignores client amounts", async () => {
  const { status, body } = await postQuote([castleLine({ unitPrice: 1, securityDeposit: 0, deliveryFee: 0, lineTotal: 1 })]);
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  const [line] = body.lines;
  assert.equal(line.durationUnit, "day");
  assert.equal(line.unitPrice, 100, "2 days x 50 per day");
  assert.equal(line.lineDeposit, 30);
  assert.equal(line.lineDelivery, 10);
  assert.equal(body.totals.total, 140);
  assert.equal(body.totals.dueToday, 140, "an occasion rental is paid in full at checkout");
  assert.equal(body.billing.mode, "one_time");
});

test("occasion: an unoffered day count, the wrong unit, or a second unit over the limit is refused", async () => {
  for (const [overrides, code] of [
    [{ durationValue: 8 }, "INVALID_DURATION"],
    [{ durationUnit: "week", durationValue: 1 }, "INVALID_PERIOD_UNIT"],
    [{ quantity: 2 }, "INVALID_QUANTITY"],
  ]) {
    const { body } = await postQuote([castleLine(overrides)]);
    assert.equal(body.valid, false);
    assert.equal(body.issues[0].code, code);
  }
});

test("delivery lead time is enforced exactly for standard and occasion products", async () => {
  const tooEarly = await postQuote([castleLine({ startDate: earliestStartDate(2) })]);
  assert.equal(tooEarly.body.valid, false);
  assert.equal(tooEarly.body.issues[0].code, "START_DATE_TOO_EARLY");

  const onTheDay = await postQuote([castleLine({ startDate: earliestStartDate(3) })]);
  assert.equal(onTheDay.body.valid, true, "exactly the lead time is allowed");

  // Standard product: unset lead time means the default of 2 days.
  const standard = (days) => ({ id: "s", productId: TRIPOD_ID, quantity: 1, durationValue: 1, durationUnit: "week", startDate: earliestStartDate(days) });
  assert.equal((await postQuote([standard(1)])).body.issues[0].code, "START_DATE_TOO_EARLY");
  assert.equal((await postQuote([standard(2)])).body.valid, true);
});

test("an inactive or missing product can never be quoted for checkout", async () => {
  const inactive = await postQuote([{ id: "i", productId: "222222222222222222222222", quantity: 1, durationValue: 1, durationUnit: "week", startDate: earliestStartDate(30) }]);
  assert.equal(inactive.body.issues[0].code, "PRODUCT_INACTIVE");
  const missing = await postQuote([{ id: "m", productId: "333333333333333333333333", quantity: 1, durationValue: 1, durationUnit: "week", startDate: earliestStartDate(30) }]);
  assert.equal(missing.body.issues[0].code, "PRODUCT_NOT_FOUND");
});
