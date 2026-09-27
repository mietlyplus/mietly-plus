"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveOrderForStripeEvent } = require("./index");
const Order = require("./models/Order");

const ORDER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ORDER_ID = "dddddddddddddddddddddddd";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_USER_ID = "cccccccccccccccccccccccc";

function buildOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    orderNumber: "ORD-20260927-1234",
    userId: USER_ID,
    stripeCheckoutSessionId: "",
    saveCount: 0,
    async save() {
      this.saveCount += 1;
    },
    ...overrides,
  };
}

function buildEvent({ sessionId = "cs_test_1", metadata, created } = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    created: created ?? Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        metadata:
          metadata === undefined
            ? { orderId: ORDER_ID, orderNumber: "ORD-20260927-1234", userId: USER_ID }
            : metadata,
      },
    },
  };
}

// Installs stubs for the two lookups resolveOrderForStripeEvent performs.
function stubOrderLookups({ bySessionId = null, byId = null } = {}) {
  Order.findOne = async () => bySessionId;
  Order.findById = async () => byId;
}

test("an order is matched by its stored checkout session id", async () => {
  const order = buildOrder({ stripeCheckoutSessionId: "cs_test_1" });
  stubOrderLookups({ bySessionId: order });

  const result = await resolveOrderForStripeEvent(buildEvent());

  assert.equal(result.order, order);
  assert.equal(result.matchedBy, "sessionId");
  assert.equal(result.mismatch, null);
});

test("metadata.orderId resolves the order when the session id has not been persisted yet", async () => {
  // The exact race: Order exists, Stripe fired before stripeCheckoutSessionId was saved.
  const order = buildOrder({ stripeCheckoutSessionId: "" });
  stubOrderLookups({ bySessionId: null, byId: order });

  const result = await resolveOrderForStripeEvent(buildEvent());

  assert.equal(result.order, order);
  assert.equal(result.matchedBy, "metadata");
  assert.equal(result.mismatch, null);
  assert.equal(order.stripeCheckoutSessionId, "cs_test_1", "session id is backfilled");
  assert.equal(order.saveCount, 1, "backfill is persisted");
});

test("metadata is rejected when the order number contradicts it", async () => {
  const order = buildOrder({ orderNumber: "ORD-20260927-9999" });
  stubOrderLookups({ bySessionId: null, byId: order });

  const result = await resolveOrderForStripeEvent(buildEvent());

  assert.equal(result.order, null);
  assert.equal(result.mismatch, "orderNumber");
  assert.equal(order.saveCount, 0, "a contradicted order is never written to");
});

test("metadata is rejected when the user does not own the order", async () => {
  const order = buildOrder({ userId: OTHER_USER_ID });
  stubOrderLookups({ bySessionId: null, byId: order });

  const result = await resolveOrderForStripeEvent(buildEvent());

  assert.equal(result.order, null);
  assert.equal(result.mismatch, "userId");
  assert.equal(order.saveCount, 0);
});

test("an order already bound to a different session is never re-pointed", async () => {
  const order = buildOrder({ stripeCheckoutSessionId: "cs_test_OTHER" });
  stubOrderLookups({ bySessionId: null, byId: order });

  const result = await resolveOrderForStripeEvent(buildEvent({ sessionId: "cs_test_1" }));

  assert.equal(result.order, null);
  assert.equal(result.mismatch, "sessionId");
  assert.equal(order.stripeCheckoutSessionId, "cs_test_OTHER", "binding is left intact");
  assert.equal(order.saveCount, 0);
});

test("an event with no usable metadata resolves to nothing rather than guessing", async () => {
  stubOrderLookups({ bySessionId: null, byId: null });

  const noMetadata = await resolveOrderForStripeEvent(buildEvent({ metadata: {} }));
  assert.equal(noMetadata.order, null);
  assert.equal(noMetadata.mismatch, null);

  const badId = await resolveOrderForStripeEvent(buildEvent({ metadata: { orderId: "not-an-id" } }));
  assert.equal(badId.order, null);
  assert.equal(badId.mismatch, null);
});

test("a referenced order that does not exist resolves to nothing", async () => {
  stubOrderLookups({ bySessionId: null, byId: null });

  const result = await resolveOrderForStripeEvent(
    buildEvent({ metadata: { orderId: OTHER_ORDER_ID } })
  );

  assert.equal(result.order, null);
  assert.equal(result.mismatch, null);
});

test("partial metadata still resolves when nothing contradicts the order", async () => {
  const order = buildOrder();
  stubOrderLookups({ bySessionId: null, byId: order });

  const result = await resolveOrderForStripeEvent(
    buildEvent({ metadata: { orderId: ORDER_ID } })
  );

  assert.equal(result.order, order);
  assert.equal(result.matchedBy, "metadata");
});

test("the session id match takes precedence over metadata", async () => {
  const bySession = buildOrder({ _id: ORDER_ID, stripeCheckoutSessionId: "cs_test_1" });
  const byMetadata = buildOrder({ _id: OTHER_ORDER_ID });
  stubOrderLookups({ bySessionId: bySession, byId: byMetadata });

  const result = await resolveOrderForStripeEvent(buildEvent());

  assert.equal(result.order, bySession);
  assert.equal(result.matchedBy, "sessionId");
});
