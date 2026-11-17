"use strict";

// Cleanup for media created by preview testing.
//
// A preview uploads into a dedicated Cloudinary folder (see productUploadFolder).
// When a preview draft is discarded, its images in THAT folder are removed. The
// check is deliberately strict -- the public id must sit inside the configured
// preview folder, and the production folder is never eligible -- so an existing
// asset can never be matched, whatever URL a draft happens to hold.

const { DEFAULT_PRODUCT_UPLOAD_FOLDER } = require("./runtime-env");

function normalizeFolder(folder) {
  return String(folder || "").trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Returns the Cloudinary public id for an image URL if, and only if, it lives
 * inside `folder`; otherwise null.
 */
function previewMediaPublicId(url, folder) {
  const safeFolder = normalizeFolder(folder);
  if (!safeFolder || safeFolder === DEFAULT_PRODUCT_UPLOAD_FOLDER) return null;

  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return null;
  }
  if (!/(^|\.)res\.cloudinary\.com$/i.test(parsed.hostname)) return null;

  const marker = "/image/upload/";
  const at = parsed.pathname.indexOf(marker);
  if (at === -1) return null;

  let rest = decodeURIComponent(parsed.pathname.slice(at + marker.length));
  rest = rest.replace(/^v\d+\//, "");        // version segment
  rest = rest.replace(/\.[A-Za-z0-9]+$/, ""); // file extension

  if (rest.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  // The trailing slash matters: "preview-qa-evil/x" must not match "preview-qa".
  if (!rest.startsWith(`${safeFolder}/`)) return null;

  return rest;
}

module.exports = { previewMediaPublicId };
