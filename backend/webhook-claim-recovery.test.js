"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { claimStripeEvent, completeStripeEvent, STRIPE_EVENT_LEASE_MS } = require("./index");
const StripeWebhookEvent = require("./models/StripeWebhookEvent");

const ORDER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT = { id: "evt_recover_1", type: "checkout.session.completed" };

// In-memory stand-in for the collection, enforcing the unique index on eventId
// so the claim path exercises the same duplicate-key branch as production.
function installStore() {
  const rows = new Map();

  StripeWebhookEvent.create = async (doc) => {
    if (rows.has(doc.eventId)) {
      const error = new Error("E11000 duplicate key error");
      error.code = 11000;
      throw error;
    }
    const row = {
      ...doc,
      status: doc.status || "processing",
      claimedAt: doc.claimedAt || new Date(),
      processedAt: doc.processedAt || null,
    };
    rows.set(doc.eventId, row);
    return row;
  };

  StripeWebhookEvent.findOne = async (filter) => rows.get(filter.eventId) || null;

  StripeWebhookEvent.findOneAndUpdate = async (filter, update) => {
    const row = rows.get(filter.eventId);
    if (!row) return null;
    if (filter.status && row.status !== filter.status) return null;
    if (filter.claimedAt?.$lte && !(row.claimedAt <= filter.claimedAt.$lte)) return null;
    Object.assign(row, update.$set);
    return row;
  };

  StripeWebhookEvent.updateOne = async (filter, update) => {
    const row = rows.get(filter.eventId);
    if (row) Object.assign(row, update.$set);
    return { acknowledged: true };
  };

  StripeWebhookEvent.deleteOne = async (filter) => {
    const row = rows.get(filter.eventId);
    if (row && (!filter.status || row.status === filter.status)) rows.delete(filter.eventId);
    return { acknowledged: true };
  };

  return rows;
}

let rows;
test.beforeEach(() => {
  rows = installStore();
});

test("a first delivery claims the event", async () => {
  const claim = await claimStripeEvent(EVENT, ORDER_ID);

  assert.equal(claim.outcome, "claimed");
  assert.equal(rows.get(EVENT.id).status, "processing");
});

test("a redelivery after successful processing is a duplicate", async () => {
  await claimStripeEvent(EVENT, ORDER_ID);
  await completeStripeEvent(EVENT, ORDER_ID);

  const replay = await claimStripeEvent(EVENT, ORDER_ID);

  assert.equal(replay.outcome, "duplicate");
  assert.equal(rows.get(EVENT.id).status, "completed");
  assert.ok(rows.get(EVENT.id).processedAt instanceof Date);
});

test("a retry while another worker holds a live lease is told to retry", async () => {
  await claimStripeEvent(EVENT, ORDER_ID);

  const concurrent = await claimStripeEvent(EVENT, ORDER_ID);

  assert.equal(concurrent.outcome, "in_progress", "must not process the same event twice in parallel");
});

test("REGRESSION: a worker that crashes after claiming but before saving is recovered", async () => {
  // Worker A claims the event, then dies before the order is marked paid.
  // The claim survives, still in "processing", and is never completed.
  const first = await claimStripeEvent(EVENT, ORDER_ID);
  assert.equal(first.outcome, "claimed");
  assert.equal(rows.get(EVENT.id).status, "processing");

  // Immediately afterwards the lease is still live, so a retry must not barge in.
  assert.equal((await claimStripeEvent(EVENT, ORDER_ID)).outcome, "in_progress");

  // Age the abandoned claim past its lease, as wall-clock time would.
  rows.get(EVENT.id).claimedAt = new Date(Date.now() - STRIPE_EVENT_LEASE_MS - 1000);

  // Worker B's retry must take over and finish the work, NOT skip it as a duplicate.
  const retry = await claimStripeEvent(EVENT, ORDER_ID);

  assert.equal(retry.outcome, "claimed", "an interrupted event must be reprocessed, not skipped");
  assert.equal(retry.recovered, true);
  assert.notEqual(retry.outcome, "duplicate");

  // And the recovered run can complete normally.
  await completeStripeEvent(EVENT, ORDER_ID);
  assert.equal(rows.get(EVENT.id).status, "completed");
  assert.equal((await claimStripeEvent(EVENT, ORDER_ID)).outcome, "duplicate");
});

test("taking over a stale claim refreshes the lease so a third worker waits", async () => {
  await claimStripeEvent(EVENT, ORDER_ID);
  rows.get(EVENT.id).claimedAt = new Date(Date.now() - STRIPE_EVENT_LEASE_MS - 1000);

  assert.equal((await claimStripeEvent(EVENT, ORDER_ID)).outcome, "claimed");
  assert.equal((await claimStripeEvent(EVENT, ORDER_ID)).outcome, "in_progress");
});

test("a claim released by an error handler can be reclaimed immediately", async () => {
  await claimStripeEvent(EVENT, ORDER_ID);
  // This is what the route's catch block does on a handled failure.
  await StripeWebhookEvent.deleteOne({ eventId: EVENT.id, status: "processing" });

  const retry = await claimStripeEvent(EVENT, ORDER_ID);

  assert.equal(retry.outcome, "claimed", "no need to wait out the lease after a clean release");
  assert.notEqual(retry.recovered, true);
});

test("a completed claim is never deleted by the error handler", async () => {
  await claimStripeEvent(EVENT, ORDER_ID);
  await completeStripeEvent(EVENT, ORDER_ID);

  await StripeWebhookEvent.deleteOne({ eventId: EVENT.id, status: "processing" });

  assert.ok(rows.has(EVENT.id), "a finished event must stay recorded");
  assert.equal((await claimStripeEvent(EVENT, ORDER_ID)).outcome, "duplicate");
});

test("the order id is attached when a stale claim is taken over", async () => {
  await claimStripeEvent(EVENT, null);
  rows.get(EVENT.id).claimedAt = new Date(Date.now() - STRIPE_EVENT_LEASE_MS - 1000);

  await claimStripeEvent(EVENT, ORDER_ID);

  assert.equal(rows.get(EVENT.id).orderId, ORDER_ID);
});
