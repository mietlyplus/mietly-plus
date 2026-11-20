"use strict";

// Source fallback for the product-link workflow.
//
// When the supplied page is blocked, bot-protected, unreadable or carries too
// little product information, we do NOT try to get around the block. Instead we
// search the open web for the same product, prefer the manufacturer's page, then
// accessible retailers, read those pages with the same SSRF-hardened fetcher and
// extractor as any other link, and merge what they say.
//
// Facts only ever come from pages that were actually fetched and parsed. The
// search step only suggests WHERE to look; a hallucinated URL simply fails to
// load and is skipped. Disagreement between sources is flagged, never resolved
// silently. Retailer purchase prices are never used to derive rental prices.

const { fetchSourceDocument } = require("./fetch-source");
const { extractProductFacts } = require("./extract-product");

const MAX_FALLBACK_PAGES = 3;
const MIN_USEFUL_SPECS = 2;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** True when an extraction carries too little product information to build on. */
function isThinExtraction(extracted) {
  if (!extracted) return true;
  const { facts, confidence } = extracted;
  if (!facts?.name) return true;
  if (confidence === "low") return true;
  return !facts.description && (facts.specifications || []).length < MIN_USEFUL_SPECS;
}

/** A search phrase from whatever we know: the URL slug, plus any partial facts. */
function buildSearchQuery(sourceUrl, partialFacts = {}) {
  const known = [partialFacts.brand, partialFacts.name || partialFacts.model].filter(Boolean).join(" ").trim();
  if (known) return known.slice(0, 200);
  try {
    const url = new URL(sourceUrl);
    const slug = url.pathname
      .split("/")
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || "";
    const words = decodeURIComponent(slug)
      .replace(/\.(html?|php|aspx?)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\b(p|dp|pd|prod|product|produkt|artikel)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return words.slice(0, 200);
  } catch {
    return "";
  }
}

/** Orders candidates: manufacturer pages first, then retailers; drops the blocked host. */
function rankCandidates(candidates, { originalUrl, brand }) {
  const blockedHost = hostOf(originalUrl);
  const brandKey = String(brand || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set();
  const usable = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = String(candidate?.url || "").trim();
    if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
    const host = hostOf(url);
    if (!host || host === blockedHost) continue;
    seen.add(url);
    const official =
      candidate.type === "manufacturer" || Boolean(brandKey && host.replace(/[^a-z0-9]/g, "").includes(brandKey));
    usable.push({ url, title: String(candidate.title || "").slice(0, 200), official });
  }
  return usable.sort((a, b) => Number(b.official) - Number(a.official));
}

function norm(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ").trim();
}

/**
 * Merges facts from several fetched pages. The first page with a name leads (the
 * list is already ordered manufacturer-first); later pages only fill gaps.
 * Disagreement on identity fields or on a specification value becomes a warning.
 */
function mergeSourceFacts(pages) {
  const merged = { name: "", brand: "", model: "", sku: "", gtin: "", color: "", description: "", category: "", specifications: [], featureLines: [] };
  const sourceImages = [];
  const warnings = [];
  const strategies = new Set();

  for (const page of pages) {
    const facts = page.extracted.facts;
    for (const key of ["name", "brand", "model", "sku", "gtin", "color", "description", "category"]) {
      if (!facts[key]) continue;
      if (!merged[key]) merged[key] = facts[key];
      else if (["brand", "model", "sku", "gtin"].includes(key) && norm(merged[key]) !== norm(facts[key])) {
        warnings.push({ code: "sources_disagree", field: key, message: `Sources disagree on ${key}: "${merged[key]}" vs "${facts[key]}" (${hostOf(page.url)}). Check it.` });
      }
    }
    for (const spec of facts.specifications || []) {
      const existing = merged.specifications.find((s) => norm(s.key) === norm(spec.key));
      if (!existing) merged.specifications.push(spec);
      else if (norm(existing.value) !== norm(spec.value)) {
        warnings.push({ code: "sources_disagree", field: "specifications", message: `Sources disagree on "${spec.key}": "${existing.value}" vs "${spec.value}" (${hostOf(page.url)}). Check it.` });
      }
    }
    if (!merged.featureLines.length) merged.featureLines = facts.featureLines || [];
    for (const image of page.extracted.sourceImages) if (!sourceImages.includes(image)) sourceImages.push(image);
    page.extracted.usedStrategies.forEach((s) => strategies.add(s));
  }

  const confidence = pages.some((p) => p.extracted.confidence === "high") ? "medium" : "low";
  return { facts: merged, sourceImages, warnings, usedStrategies: [...strategies], confidence };
}

/**
 * @param {object} args
 * @param {string} args.sourceUrl       the URL the owner supplied
 * @param {object} [args.partialFacts]  whatever the original page did yield
 * @param {object} deps
 * @param {(q:{query:string, brand?:string})=>Promise<Array<{url:string,title?:string,type?:string}>>} [deps.searchCandidates]
 * @param {Function} [deps.fetchSourceDocument]
 * @returns {Promise<{ok:boolean, result:object|null, sources:object[], warnings:object[]}>}
 */
async function runFallbackSearch({ sourceUrl, partialFacts = {} }, deps = {}) {
  const warnings = [];
  const search = deps.searchCandidates;
  if (typeof search !== "function") {
    return { ok: false, result: null, sources: [], warnings: [{ code: "fallback_unavailable", field: "sourceUrl", message: "The page could not be read and no web search is configured. Enter the product details manually." }] };
  }

  const query = buildSearchQuery(sourceUrl, partialFacts);
  if (!query) {
    return { ok: false, result: null, sources: [], warnings: [{ code: "fallback_no_query", field: "sourceUrl", message: "The page could not be read and the link says too little to search for the product." }] };
  }

  let candidates = [];
  try {
    candidates = rankCandidates(await search({ query, brand: partialFacts.brand }), { originalUrl: sourceUrl, brand: partialFacts.brand });
  } catch {
    return { ok: false, result: null, sources: [], warnings: [{ code: "fallback_search_failed", field: "sourceUrl", message: "The web search for this product failed. Enter the details manually or try again." }] };
  }

  const fetcher = deps.fetchSourceDocument || fetchSourceDocument;
  const pages = [];
  const sources = [];
  for (const candidate of candidates) {
    if (pages.length >= MAX_FALLBACK_PAGES) break;
    try {
      const { html, finalUrl } = await fetcher(candidate.url);
      const extracted = extractProductFacts(html, finalUrl);
      if (!extracted.facts.name) {
        sources.push({ url: candidate.url, role: candidate.official ? "manufacturer" : "retailer", used: false, note: "no product data found" });
        continue;
      }
      pages.push({ url: finalUrl || candidate.url, extracted, official: candidate.official });
      sources.push({ url: finalUrl || candidate.url, role: candidate.official ? "manufacturer" : "retailer", used: true, note: "" });
    } catch {
      // Blocked or unreadable: skip, never work around it.
      sources.push({ url: candidate.url, role: candidate.official ? "manufacturer" : "retailer", used: false, note: "could not be read" });
    }
  }

  if (pages.length === 0) {
    return { ok: false, result: null, sources, warnings: [{ code: "fallback_no_sources", field: "sourceUrl", message: `No accessible page was found for "${query}". Enter the product details manually.` }] };
  }

  const merged = mergeSourceFacts(pages);
  warnings.push(
    { code: "fallback_sources_used", field: "sourceUrl", message: `The supplied page could not be used, so facts were taken from: ${pages.map((p) => hostOf(p.url)).join(", ")}. Verify them before publishing.` },
    ...merged.warnings
  );
  if (!pages.some((p) => p.official)) {
    warnings.push({ code: "fallback_no_official_source", field: "sourceUrl", message: "No manufacturer page was available; facts come from retailers only." });
  }

  return {
    ok: true,
    sources,
    warnings,
    result: {
      facts: merged.facts,
      sourceImages: merged.sourceImages,
      // Reference only. Never used to derive rental prices.
      retailerPrice: null,
      confidence: merged.confidence,
      usedStrategies: [...merged.usedStrategies, "web_search_fallback"],
      finalUrl: pages[0].url,
    },
  };
}

module.exports = { runFallbackSearch, isThinExtraction, buildSearchQuery, rankCandidates, mergeSourceFacts };
