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
  assert.deepEqual(body.totals, { subtotal: 0, depositTotal: 0, deliveryTotal: 0, total: 0 });
});

test("a valid cart is priced from the catalogue, not from the request", async () => {
  const { status, body } = await postQuote([
    {
      id: "line-a",
      productId: CAMERA_ID,
      quantity: 2,
      durationValue: 3,
      durationUnit: "week",
      startDate: "2026-10-01",
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

  assert.deepEqual(body.totals, {
    subtotal: 90,
    depositTotal: 200,
    deliveryTotal: 10,
    total: 300,
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
