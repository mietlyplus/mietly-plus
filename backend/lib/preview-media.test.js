"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { previewMediaPublicId } = require("./preview-media");

const FOLDER = "leihfluss/preview-qa";
const url = (path) => `https://res.cloudinary.com/demo/image/upload/${path}`;

test("an image inside the preview folder yields its public id", () => {
  assert.equal(previewMediaPublicId(url("v1700000000/leihfluss/preview-qa/abc123.png"), FOLDER), "leihfluss/preview-qa/abc123");
  assert.equal(previewMediaPublicId(url("leihfluss/preview-qa/abc123.jpg"), FOLDER), "leihfluss/preview-qa/abc123", "no version segment");
});

test("an asset in the production folder is never eligible", () => {
  assert.equal(previewMediaPublicId(url("v1/leihfluss/products/live-photo.jpg"), FOLDER), null);
});

test("the production folder cannot be configured as the cleanup target", () => {
  assert.equal(previewMediaPublicId(url("v1/leihfluss/products/live-photo.jpg"), "leihfluss/products"), null);
  assert.equal(previewMediaPublicId(url("v1/leihfluss/products/live-photo.jpg"), "leihfluss/products/"), null);
});

test("a blank folder matches nothing", () => {
  for (const folder of ["", "  ", "/", undefined, null]) {
    assert.equal(previewMediaPublicId(url("v1/anything/x.jpg"), folder), null);
  }
});

test("a lookalike prefix does not match", () => {
  assert.equal(previewMediaPublicId(url("v1/leihfluss/preview-qa-evil/x.jpg"), FOLDER), null);
  assert.equal(previewMediaPublicId(url("v1/leihfluss/preview-qa.jpg"), FOLDER), null);
});

test("path traversal is rejected", () => {
  assert.equal(previewMediaPublicId(url("v1/leihfluss/preview-qa/../products/live.jpg"), FOLDER), null);
  assert.equal(previewMediaPublicId(url("v1/leihfluss/preview-qa/%2e%2e/products/live.jpg"), FOLDER), null);
});

test("only Cloudinary delivery URLs are considered", () => {
  assert.equal(previewMediaPublicId("https://evil.example.com/image/upload/v1/leihfluss/preview-qa/x.jpg", FOLDER), null);
  assert.equal(previewMediaPublicId("https://res.cloudinary.com.evil.example/image/upload/v1/leihfluss/preview-qa/x.jpg", FOLDER), null);
  assert.equal(previewMediaPublicId("not a url", FOLDER), null);
  assert.equal(previewMediaPublicId("", FOLDER), null);
});

test("a retailer or owner-supplied external image is never matched", () => {
  assert.equal(previewMediaPublicId("https://cdn.example.com/a7m4-front.jpg", FOLDER), null);
});
