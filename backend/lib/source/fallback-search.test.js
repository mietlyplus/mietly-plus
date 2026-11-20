"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runExtraction } = require("../ai/draft-service");
const { SourceFetchError } = require("./fetch-source");

const page = (title, extra = "") =>
  `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({
    "@type": "Product", name: title, brand: { name: "Medion" }, model: "MD 15501", description: "Microwave with grill and hot air oven.", ...extra,
  })}</script></head><body></body></html>`;

const BLOCKED = "https://shop.example/p/medion-md-15501-mikrowelle";

test("a blocked page falls back to a manufacturer page first, then retailers; the blocked host is not retried", async () => {
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    if (url === BLOCKED) throw new SourceFetchError("HTTP_ERROR", "That page answered with HTTP 403.");
    if (url.includes("medion.com")) return { html: page("Medion MD 15501 Mikrowelle", { sku: "MD15501", additionalProperty: [{ name: "Leistung", value: "900 W" }] }), finalUrl: url };
    if (url.includes("retailer.example")) return { html: page("Medion MD 15501 4in1", { sku: "MD-15501", additionalProperty: [{ name: "Leistung", value: "1000 W" }] }), finalUrl: url };
    throw new SourceFetchError("HTTP_ERROR", "403");
  };
  const searchCandidates = async ({ query }) => {
    assert.match(query, /medion md 15501/i);
    return [
      { url: "https://retailer.example/a", type: "retailer" },
      { url: "https://shop.example/other", type: "retailer" },
      { url: "https://www.medion.com/de/p/1", type: "manufacturer" },
      { url: "https://dead.example/x", type: "retailer" },
      { url: "http://insecure.example/x", type: "retailer" },
    ];
  };

  const out = await runExtraction(BLOCKED, { fetchSourceDocument: fetcher, searchCandidates });
  assert.equal(out.ok, true);
  assert.equal(out.result.facts.sku, "MD15501", "the manufacturer page leads");
  assert.ok(out.result.usedStrategies.includes("web_search_fallback"));
  assert.equal(fetched.filter((u) => u === BLOCKED).length, 1);
  assert.ok(!fetched.some((u) => u.includes("shop.example/other")), "same host as the blocked page is skipped");
  assert.ok(!fetched.some((u) => u.startsWith("http://")), "non-https candidates are never fetched");
  assert.equal(out.result.retailerPrice, null, "no purchase price carries over");
  const codes = out.warnings.map((w) => w.code);
  assert.ok(codes.includes("fallback_sources_used"));
  assert.ok(out.warnings.filter((w) => w.code === "sources_disagree").length >= 2, "differing sku and spec are flagged, not resolved");
  assert.deepEqual(out.sources.map((s) => [new URL(s.url).hostname, s.used]).sort(), [["dead.example", false], ["retailer.example", true], ["www.medion.com", true]]);
});

test("with no search configured, a blocked page degrades to a warning instead of failing", async () => {
  const out = await runExtraction(BLOCKED, {
    fetchSourceDocument: async () => { throw new SourceFetchError("HTTP_ERROR", "HTTP 403"); },
    searchCandidates: null,
  });
  assert.equal(out.ok, false);
  assert.ok(out.warnings.some((w) => w.code === "fallback_unavailable"));
});

test("a readable, complete page does not trigger any search", async () => {
  let searched = false;
  const out = await runExtraction("https://good.example/p", {
    fetchSourceDocument: async (url) => ({ html: page("Full page", { additionalProperty: [{ name: "A", value: "1" }] }), finalUrl: url }),
    searchCandidates: async () => { searched = true; return []; },
  });
  assert.equal(out.ok, true);
  assert.equal(searched, false);
});

test("private-network links are refused outright, with no search on their behalf", async () => {
  let searched = false;
  const out = await runExtraction("http://169.254.169.254/x", {
    fetchSourceDocument: async () => { throw new SourceFetchError("BLOCKED_ADDRESS", "blocked"); },
    searchCandidates: async () => { searched = true; return []; },
  });
  assert.equal(searched, false);
  assert.equal(out.ok, false);
});
