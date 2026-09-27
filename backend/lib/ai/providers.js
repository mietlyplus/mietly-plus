"use strict";

// Provider abstraction for listing text and listing images.
//
// Two capabilities, resolved independently so a real text provider can run
// alongside fixture images (or vice versa):
//
//   TextProvider.generateListing({ facts, sourceUrl, adminInstruction, ... })
//   ImageProvider.generate({ brief, references })
//   ImageProvider.editFromReferences({ brief, references })
//   ImageProvider.regenerateSingle({ brief, references, previous })
//
// Gemini is the preferred first provider. Nothing outside this file knows which
// provider is in use, so swapping in OpenAI/Anthropic/another image service is
// a matter of adding a module here.

const { buildListingPrompt } = require("./prompts");

const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 55_000;

class ProviderError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function geminiApiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "").trim();
}

function parseJsonLoose(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ProviderError("BAD_MODEL_OUTPUT", "The model did not return usable JSON.", { retryable: true });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new ProviderError("BAD_MODEL_OUTPUT", "The model returned malformed JSON.", { retryable: true });
  }
}

async function geminiFetch(path, body) {
  const key = geminiApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${GEMINI_API_BASE}${path}`, {
      method: "POST",
      // Key travels in a header, never in the URL/query string.
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429 || response.status >= 500) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", `Gemini returned HTTP ${response.status}.`, { retryable: true });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // Never echo the key; Gemini errors do not contain it, but stay terse.
      throw new ProviderError("PROVIDER_ERROR", `Gemini rejected the request (HTTP ${response.status}). ${detail.slice(0, 200)}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error?.name === "AbortError") {
      throw new ProviderError("PROVIDER_TIMEOUT", "Gemini did not respond in time.", { retryable: true });
    }
    throw new ProviderError("PROVIDER_UNAVAILABLE", "Gemini could not be reached.", { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Gemini text
// ---------------------------------------------------------------------------
const geminiTextProvider = {
  id: "gemini",
  kind: "text",
  model: GEMINI_TEXT_MODEL,
  isConfigured: () => Boolean(geminiApiKey()),

  async generateListing(input) {
    const prompt = buildListingPrompt(input);
    const payload = await geminiFetch(`/models/${GEMINI_TEXT_MODEL}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
    });

    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("");

    return { listing: parseJsonLoose(text), providerId: "gemini", model: GEMINI_TEXT_MODEL };
  },
};

// ---------------------------------------------------------------------------
// Gemini images
// ---------------------------------------------------------------------------
function referenceParts(references = []) {
  return references
    .filter((ref) => ref?.base64 && ref?.mimeType)
    .slice(0, 4)
    .map((ref) => ({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } }));
}

async function geminiImageCall(brief, references) {
  const guard =
    "Produce a single photorealistic product image for a rental listing. " +
    "Reproduce the referenced product exactly: same geometry, colour, branding, " +
    "controls, ports and included components. Do not add accessories, text, " +
    "watermarks or components that are not visible in the references. " +
    "Plain neutral background unless the brief asks otherwise.";

  const parts = [{ text: `${guard}\n\nBRIEF: ${brief.prompt}` }, ...referenceParts(references)];

  const payload = await geminiFetch(`/models/${GEMINI_IMAGE_MODEL}:generateContent`, {
    contents: [{ role: "user", parts }],
  });

  const imagePart = (payload?.candidates?.[0]?.content?.parts || []).find((part) => part.inlineData?.data);
  if (!imagePart) {
    throw new ProviderError("NO_IMAGE_RETURNED", "The image provider returned no image.", { retryable: true });
  }

  return {
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
    providerId: "gemini",
    model: GEMINI_IMAGE_MODEL,
  };
}

const geminiImageProvider = {
  id: "gemini",
  kind: "image",
  model: GEMINI_IMAGE_MODEL,
  isConfigured: () => Boolean(geminiApiKey()),
  generate: ({ brief, references }) => geminiImageCall(brief, references),
  editFromReferences: ({ brief, references }) => geminiImageCall(brief, references),
  regenerateSingle: ({ brief, references }) => geminiImageCall(brief, references),
};

// ---------------------------------------------------------------------------
// Fixture providers (no credentials, no cost, no network)
// ---------------------------------------------------------------------------
const { fixtureTextProvider, fixtureImageProvider } = require("./fixture-provider");

function resolveTextProvider({ force } = {}) {
  const preference = force || process.env.AI_TEXT_PROVIDER || "gemini";
  if (preference === "fixture") return fixtureTextProvider;
  if (preference === "gemini" && geminiTextProvider.isConfigured()) return geminiTextProvider;
  return fixtureTextProvider;
}

function resolveImageProvider({ force } = {}) {
  const preference = force || process.env.AI_IMAGE_PROVIDER || "gemini";
  if (preference === "fixture") return fixtureImageProvider;
  if (preference === "gemini" && geminiImageProvider.isConfigured()) return geminiImageProvider;
  return fixtureImageProvider;
}

function describeProviders() {
  const text = resolveTextProvider();
  const image = resolveImageProvider();
  return {
    text: { id: text.id, model: text.model, real: text.id !== "fixture" },
    image: { id: image.id, model: image.model, real: image.id !== "fixture" },
    geminiConfigured: Boolean(geminiApiKey()),
  };
}

module.exports = {
  ProviderError,
  describeProviders,
  geminiImageProvider,
  geminiTextProvider,
  parseJsonLoose,
  resolveImageProvider,
  resolveTextProvider,
};
