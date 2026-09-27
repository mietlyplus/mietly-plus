"use strict";

// Extracts factual product data from a retailer page.
//
// Everything here is UNTRUSTED DATA. Text pulled from a page is never treated
// as an instruction: it is sanitised, length-capped, and passed to the model
// inside a clearly delimited data block (see lib/ai/prompts.js).
//
// Preference order: JSON-LD Product > OpenGraph/meta > visible DOM heuristics.

const MAX_FIELD = 400;
const MAX_DESCRIPTION = 4000;
const MAX_SPECS = 40;
const MAX_IMAGES = 10;

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function clean(value, max = MAX_FIELD) {
  if (value === null || value === undefined) return "";
  const text = decodeEntities(String(value))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stripScriptsAndStyles(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
}

function collectJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw || raw.length > 400_000) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Some sites emit slightly invalid JSON-LD; skip rather than fail.
    }
  }
  return blocks;
}

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    node.forEach((entry) => flattenJsonLd(entry, out));
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  if (node["@graph"]) flattenJsonLd(node["@graph"], out);
  return out;
}

function isProductNode(node) {
  const type = node?.["@type"];
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === "string" && /product/i.test(t));
}

function readMeta(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return "";
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return readMeta(html, [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ]);
}

function absoluteUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function pushImage(list, value, baseUrl) {
  const url = absoluteUrl(value, baseUrl);
  if (url && !list.includes(url) && list.length < MAX_IMAGES) list.push(url);
}

function collectImages(node, list, baseUrl) {
  const image = node?.image;
  if (!image) return;
  if (typeof image === "string") return pushImage(list, image, baseUrl);
  if (Array.isArray(image)) {
    image.forEach((entry) => {
      if (typeof entry === "string") pushImage(list, entry, baseUrl);
      else if (entry?.url) pushImage(list, entry.url, baseUrl);
    });
    return;
  }
  if (image?.url) pushImage(list, image.url, baseUrl);
}

function readJsonLdSpecs(node) {
  const specs = [];
  const props = node?.additionalProperty;
  const entries = Array.isArray(props) ? props : props ? [props] : [];
  for (const entry of entries) {
    const key = clean(entry?.name, 80);
    const value = clean(entry?.value, 200);
    if (key && value && specs.length < MAX_SPECS) specs.push({ key, value });
  }
  for (const field of ["color", "material", "size", "weight", "depth", "width", "height"]) {
    const raw = node?.[field];
    if (!raw) continue;
    const value = clean(typeof raw === "object" ? raw.value ?? raw.name : raw, 200);
    if (value && specs.length < MAX_SPECS) {
      specs.push({ key: field.charAt(0).toUpperCase() + field.slice(1), value });
    }
  }
  return specs;
}

function readRetailerPrice(node) {
  const offers = node?.offers;
  const first = Array.isArray(offers) ? offers[0] : offers;
  const amount = Number(first?.price ?? first?.lowPrice);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount,
    currency: clean(first?.priceCurrency, 8) || "",
  };
}

function readTitleFromDom(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]{0,400}?)<\/h1>/i);
  if (h1?.[1]) {
    const text = clean(h1[1]);
    if (text) return text;
  }
  const title = html.match(/<title\b[^>]*>([\s\S]{0,400}?)<\/title>/i);
  return title?.[1] ? clean(title[1]) : "";
}

function readSpecsFromDom(html) {
  const specs = [];
  const rowRe = /<tr\b[^>]*>\s*<t[hd]\b[^>]*>([\s\S]{0,200}?)<\/t[hd]>\s*<t[hd]\b[^>]*>([\s\S]{0,300}?)<\/t[hd]>\s*<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html)) !== null && specs.length < MAX_SPECS) {
    const key = clean(match[1], 80);
    const value = clean(match[2], 200);
    if (!key || !value || key.toLowerCase() === value.toLowerCase()) continue;
    if (specs.some((spec) => spec.key.toLowerCase() === key.toLowerCase())) continue;
    specs.push({ key, value });
  }
  return specs;
}

function readImagesFromDom(html, baseUrl, list) {
  const re = /<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null && list.length < MAX_IMAGES) {
    const src = match[1];
    // Skip obvious non-product assets.
    if (/sprite|logo|icon|pixel|tracking|placeholder|\.svg($|\?)/i.test(src)) continue;
    if (/^data:/i.test(src)) continue;
    pushImage(list, src, baseUrl);
  }
}

/**
 * @returns {{
 *   facts: object,
 *   sourceImages: string[],
 *   retailerPrice: {amount:number,currency:string}|null,
 *   confidence: "high"|"medium"|"low",
 *   usedStrategies: string[]
 * }}
 */
function extractProductFacts(html, baseUrl) {
  const safeHtml = stripScriptsAndStyles(html);
  const usedStrategies = [];
  const sourceImages = [];

  const facts = {
    name: "",
    brand: "",
    model: "",
    sku: "",
    gtin: "",
    color: "",
    description: "",
    category: "",
    specifications: [],
  };

  // --- 1. JSON-LD (most reliable) -----------------------------------------
  const productNode = collectJsonLdBlocks(html)
    .flatMap((block) => flattenJsonLd(block))
    .find(isProductNode);

  let retailerPrice = null;

  if (productNode) {
    usedStrategies.push("json-ld");
    facts.name = clean(productNode.name);
    const brand = productNode.brand;
    facts.brand = clean(typeof brand === "object" ? brand?.name : brand, 120);
    facts.model = clean(productNode.model, 120);
    facts.sku = clean(productNode.sku || productNode.mpn, 80);
    facts.gtin = clean(productNode.gtin13 || productNode.gtin || productNode.gtin12, 40);
    facts.color = clean(productNode.color, 80);
    facts.description = clean(productNode.description, MAX_DESCRIPTION);
    facts.category = clean(productNode.category, 160);
    facts.specifications = readJsonLdSpecs(productNode);
    collectImages(productNode, sourceImages, baseUrl);
    retailerPrice = readRetailerPrice(productNode);
  }

  // --- 2. OpenGraph / meta ------------------------------------------------
  const ogTitle = metaContent(html, "og:title");
  const ogDescription = metaContent(html, "og:description") || metaContent(html, "description");
  const ogImage = metaContent(html, "og:image");
  const ogBrand = metaContent(html, "product:brand") || metaContent(html, "og:brand");

  if (ogTitle || ogDescription || ogImage) usedStrategies.push("opengraph");
  if (!facts.name) facts.name = ogTitle;
  if (!facts.description) facts.description = clean(ogDescription, MAX_DESCRIPTION);
  if (!facts.brand) facts.brand = ogBrand;
  if (ogImage) pushImage(sourceImages, ogImage, baseUrl);

  if (!retailerPrice) {
    const amount = Number(metaContent(html, "product:price:amount"));
    if (Number.isFinite(amount) && amount > 0) {
      retailerPrice = { amount, currency: metaContent(html, "product:price:currency") || "" };
    }
  }

  // --- 3. DOM heuristics --------------------------------------------------
  if (!facts.name) {
    const domTitle = readTitleFromDom(safeHtml);
    if (domTitle) {
      usedStrategies.push("dom");
      facts.name = domTitle;
    }
  }
  if (facts.specifications.length === 0) {
    const domSpecs = readSpecsFromDom(safeHtml);
    if (domSpecs.length) {
      if (!usedStrategies.includes("dom")) usedStrategies.push("dom");
      facts.specifications = domSpecs;
    }
  }
  if (sourceImages.length === 0) readImagesFromDom(safeHtml, baseUrl, sourceImages);

  const confidence = productNode ? "high" : facts.name && facts.description ? "medium" : "low";

  return { facts, sourceImages, retailerPrice, confidence, usedStrategies };
}

module.exports = { extractProductFacts, clean, MAX_DESCRIPTION, MAX_SPECS };
