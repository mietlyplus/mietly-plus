"use strict";

// SSRF-hardened fetcher for admin-supplied product URLs.
//
// The URL comes from an authenticated admin, but it points at an arbitrary
// third-party host, so every request is treated as hostile: only http(s), only
// public IP space, bounded redirects (each re-validated), bounded size, bounded
// time, and no credentials or cookies forwarded.

const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB of HTML is already generous.
const TIMEOUT_MS = 15000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Browser-ish UA: many retailers 403 an obviously scripted agent. This is not
// an attempt to defeat bot protection — a challenge page is treated as a
// failure and surfaced to the admin rather than worked around.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36 LeihflussProductImporter/1.0";

class SourceFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceFetchError";
    this.code = code;
  }
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  const inRange = (cidr, bits) => (value >>> (32 - bits)) === (ipv4ToInt(cidr) >>> (32 - bits));

  return (
    inRange("0.0.0.0", 8) ||        // "this" network
    inRange("10.0.0.0", 8) ||       // private
    inRange("127.0.0.0", 8) ||      // loopback
    inRange("169.254.0.0", 16) ||   // link-local, incl. 169.254.169.254 metadata
    inRange("172.16.0.0", 12) ||    // private
    inRange("192.168.0.0", 16) ||   // private
    inRange("100.64.0.0", 10) ||    // CGNAT
    inRange("192.0.0.0", 24) ||     // IETF protocol assignments
    inRange("192.0.2.0", 24) ||     // TEST-NET-1
    inRange("198.18.0.0", 15) ||    // benchmarking
    inRange("198.51.100.0", 24) ||  // TEST-NET-2
    inRange("203.0.113.0", 24) ||   // TEST-NET-3
    inRange("224.0.0.0", 4) ||      // multicast
    inRange("240.0.0.0", 4)         // reserved
  );
}

function isBlockedIpv6(ip) {
  const lower = ip.toLowerCase().split("%")[0];
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true;           // link-local
  if (/^f[cd]/.test(lower)) return true;               // unique local
  if (lower.startsWith("ff")) return true;             // multicast
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return isBlockedIpv4(mapped);
  }
  return false;
}

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true; // unparseable -> refuse
}

/** Rejects a URL whose hostname resolves to anything outside public IP space. */
async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceFetchError("INVALID_URL", "That does not look like a valid URL.");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SourceFetchError("UNSUPPORTED_PROTOCOL", "Only http and https product links are supported.");
  }

  if (url.username || url.password) {
    throw new SourceFetchError("CREDENTIALS_IN_URL", "Remove the credentials from the URL before importing.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // A literal IP needs no DNS round trip.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new SourceFetchError("BLOCKED_ADDRESS", "That address is not publicly reachable and cannot be imported.");
    }
    return url;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new SourceFetchError("BLOCKED_ADDRESS", "That address is not publicly reachable and cannot be imported.");
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new SourceFetchError("DNS_FAILED", "That domain could not be resolved.");
  }

  if (!records.length) {
    throw new SourceFetchError("DNS_FAILED", "That domain could not be resolved.");
  }

  // Every resolved address must be public: one private answer is enough to refuse.
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new SourceFetchError("BLOCKED_ADDRESS", "That address is not publicly reachable and cannot be imported.");
    }
  }

  return url;
}

async function readBodyWithLimit(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new SourceFetchError("RESPONSE_TOO_LARGE", "That page is too large to import.");
  }

  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new SourceFetchError("RESPONSE_TOO_LARGE", "That page is too large to import.");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches a product page. Redirects are followed manually so every hop is
 * re-validated against the same rules as the original URL.
 */
async function fetchSourceDocument(rawUrl, { fetchImpl = fetch } = {}) {
  let currentUrl = await assertPublicUrl(rawUrl);
  const chain = [currentUrl.toString()];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetchImpl(currentUrl.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        },
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new SourceFetchError("TIMEOUT", "That page took too long to respond.");
      }
      throw new SourceFetchError("NETWORK_ERROR", "That page could not be reached.");
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SourceFetchError("BAD_REDIRECT", "That page redirected without a destination.");
      }
      if (hop === MAX_REDIRECTS) {
        throw new SourceFetchError("TOO_MANY_REDIRECTS", "That page redirected too many times.");
      }
      const next = new URL(location, currentUrl);
      currentUrl = await assertPublicUrl(next.toString());
      chain.push(currentUrl.toString());
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new SourceFetchError(
        "ACCESS_DENIED",
        "That page requires login or blocks automated access. Enter the details manually instead."
      );
    }

    if (!response.ok) {
      throw new SourceFetchError("HTTP_ERROR", `That page returned HTTP ${response.status}.`);
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      throw new SourceFetchError("UNSUPPORTED_CONTENT_TYPE", "That link is not a product web page.");
    }

    const html = await readBodyWithLimit(response);
    return { html, finalUrl: currentUrl.toString(), redirectChain: chain };
  }

  throw new SourceFetchError("TOO_MANY_REDIRECTS", "That page redirected too many times.");
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Fetches a reference image with the same SSRF guarantees as a page fetch.
 *
 * Redirects are followed manually so EVERY hop is re-validated against public
 * IP space; the size cap is enforced while streaming, so an oversized body is
 * abandoned rather than buffered; and a single deadline covers the body read,
 * not just the response headers.
 */
async function fetchImageWithLimits(rawUrl, { fetchImpl = fetch, maxBytes = MAX_IMAGE_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let currentUrl = await assertPublicUrl(rawUrl);
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SourceFetchError("TIMEOUT", "That image took too long to download.");
    }

    const controller = new AbortController();
    // One deadline for headers AND body, so a slow trickle cannot stall us.
    const timer = setTimeout(() => controller.abort(), remaining);

    let response;
    try {
      response = await fetchImpl(currentUrl.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "image/*" },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new SourceFetchError("BAD_REDIRECT", "That image redirected without a destination.");
        if (hop === MAX_REDIRECTS) throw new SourceFetchError("TOO_MANY_REDIRECTS", "That image redirected too many times.");
        // Re-validate the destination before connecting to it.
        currentUrl = await assertPublicUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if (!response.ok) {
        throw new SourceFetchError("HTTP_ERROR", `That image returned HTTP ${response.status}.`);
      }

      const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^image\//i.test(contentType)) {
        throw new SourceFetchError("UNSUPPORTED_CONTENT_TYPE", "That URL is not an image.");
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new SourceFetchError("RESPONSE_TOO_LARGE", "That image is too large.");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new SourceFetchError("NETWORK_ERROR", "That image could not be read.");

      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          // Abandon mid-stream rather than buffering the whole body.
          await reader.cancel().catch(() => {});
          throw new SourceFetchError("RESPONSE_TOO_LARGE", "That image is too large.");
        }
        chunks.push(value);
      }

      return { buffer: Buffer.concat(chunks), mimeType: contentType, finalUrl: currentUrl.toString() };
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      if (error?.name === "AbortError") {
        throw new SourceFetchError("TIMEOUT", "That image took too long to download.");
      }
      throw new SourceFetchError("NETWORK_ERROR", "That image could not be downloaded.");
    } finally {
      clearTimeout(timer);
    }
  }

  throw new SourceFetchError("TOO_MANY_REDIRECTS", "That image redirected too many times.");
}

module.exports = {
  SourceFetchError,
  assertPublicUrl,
  fetchImageWithLimits,
  fetchSourceDocument,
  isBlockedAddress,
  MAX_IMAGE_BYTES,
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
};
