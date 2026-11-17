"use strict";

// Pins the exact requests sent to Gemini, with fetch mocked. This proves the
// request SHAPE only -- it says nothing about what the live API returns.

process.env.GEMINI_API_KEY = "test-key-not-a-secret";

const test = require("node:test");
const assert = require("node:assert/strict");

const { geminiImageProvider, geminiTextProvider, ProviderError } = require("./providers");

function mockFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init, calls.length);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test("an image request asks for TEXT+IMAGE at a pinned 1K size", async () => {
  const mock = mockFetch(() => ok({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }],
  }));
  try {
    await geminiImageProvider.generate({ brief: { role: "primary", prompt: "front view" }, references: [] });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
    assert.equal(body.generationConfig.imageConfig.imageSize, "1K", "size is pinned so cost stays predictable");
    assert.equal(body.generationConfig.imageConfig.aspectRatio, "1:1");
  } finally { mock.restore(); }
});

test("the API key is sent as a header and never appears in the URL", async () => {
  const mock = mockFetch(() => ok({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }],
  }));
  try {
    await geminiImageProvider.generate({ brief: { role: "primary", prompt: "x" }, references: [] });
    assert.ok(!mock.calls[0].url.includes("test-key-not-a-secret"), "key must not be in the URL");
    assert.equal(mock.calls[0].init.headers["x-goog-api-key"], "test-key-not-a-secret");
  } finally { mock.restore(); }
});

test("reference photos are attached as inline data", async () => {
  const mock = mockFetch(() => ok({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] } }],
  }));
  try {
    await geminiImageProvider.editFromReferences({
      brief: { role: "alt", prompt: "side" },
      references: [{ base64: "QkJC", mimeType: "image/jpeg" }],
    });
    const parts = JSON.parse(mock.calls[0].init.body).contents[0].parts;
    assert.ok(parts.some((part) => part.inlineData?.data === "QkJC" && part.inlineData.mimeType === "image/jpeg"));
  } finally { mock.restore(); }
});

test("a response with no image is a retryable error, not a silent success", async () => {
  const mock = mockFetch(() => ok({ candidates: [{ content: { parts: [{ text: "I cannot do that" }] } }] }));
  try {
    await assert.rejects(
      () => geminiImageProvider.generate({ brief: { role: "primary", prompt: "x" }, references: [] }),
      (error) => error instanceof ProviderError && error.code === "NO_IMAGE_RETURNED"
    );
  } finally { mock.restore(); }
});

test("a text request targets the configured text model and asks for JSON", async () => {
  const mock = mockFetch(() => ok({
    candidates: [{ content: { parts: [{ text: '{"titleDe":"Titel","warnings":[]}' }] } }],
  }));
  try {
    const result = await geminiTextProvider.generateListing({
      facts: { name: "Thing", specifications: [] }, sourceUrl: "https://example.com/x",
      adminInstruction: "", categories: [], brands: [], hasUserPhotos: false,
    });
    assert.match(mock.calls[0].url, /gemini-3\.8-flash:generateContent/);
    assert.equal(JSON.parse(mock.calls[0].init.body).generationConfig.responseMimeType, "application/json");
    assert.equal(result.listing.titleDe, "Titel");
  } finally { mock.restore(); }
});

test("rate limiting and server errors are retryable; a rejected request is not", async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false]]) {
    const mock = mockFetch(() => ({ ok: false, status, text: async () => "nope", json: async () => ({}) }));
    try {
      await assert.rejects(
        () => geminiImageProvider.generate({ brief: { role: "primary", prompt: "x" }, references: [] }),
        (error) => error instanceof ProviderError && error.retryable === retryable
      );
    } finally { mock.restore(); }
  }
});

test("a provider call can never claim the whole 60s function budget", () => {
  const { FUNCTION_BUDGET_MS, PERSIST_RESERVE_MS, TEXT_TIMEOUT_MS, IMAGE_TIMEOUT_MS } = require("./providers");
  assert.ok(TEXT_TIMEOUT_MS <= FUNCTION_BUDGET_MS - PERSIST_RESERVE_MS);
  assert.ok(IMAGE_TIMEOUT_MS <= FUNCTION_BUDGET_MS - PERSIST_RESERVE_MS);
});
