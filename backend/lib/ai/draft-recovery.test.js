"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasUsableSource, planMissingImages, DEFAULT_IMAGE_BRIEFS } = require("./draft-service");
const { buildListingPrompt } = require("./prompts");
const { isBotChallengePage } = require("../source/fetch-source");
const { evaluatePublicationBlockers } = require("../publication-rules");

test("a link alone is not source material; a named product or owner details are", () => {
  assert.equal(hasUsableSource({ facts: {}, adminDetails: "" }), false);
  assert.equal(hasUsableSource({ facts: { name: "  " }, adminDetails: "   " }), false);
  assert.equal(hasUsableSource({ facts: { name: "Medion MD 15501" }, adminDetails: "" }), true);
  assert.equal(hasUsableSource({ facts: {}, adminDetails: "16 GB RAM, 1 TB SSD" }), true);
  assert.equal(hasUsableSource({ facts: undefined, adminDetails: undefined }), false);
});

test("the prompt never contains the link, and carries the owner's details as a data block", () => {
  const prompt = buildListingPrompt({
    facts: { name: "Thing", specifications: [] },
    adminDetails: "Weight 2.2 kg",
    sourceUrl: "https://shop.example/gigabyte-a16-16-zoll-ryzen-7-260-16-gb-rtx-5060",
    adminInstruction: "",
    categories: [], brands: [], hasUserPhotos: false,
  });
  assert.ok(!prompt.includes("rtx-5060"), "URL text must not reach the model");
  assert.ok(!prompt.includes("shop.example"));
  assert.match(prompt, /<<<ADMIN_DETAILS>>>\nWeight 2\.2 kg\n<<<END_ADMIN_DETAILS>>>/);
  assert.match(prompt, /Never infer a specification/);
});

test("with no details the block is explicitly empty", () => {
  const prompt = buildListingPrompt({ facts: { name: "Thing", specifications: [] }, adminDetails: "", categories: [], brands: [], hasUserPhotos: false });
  assert.match(prompt, /<<<ADMIN_DETAILS>>>\n\(none\)\n<<<END_ADMIN_DETAILS>>>/);
});

test("challenge pages are recognised by title only", () => {
  for (const title of ["Just a moment...", "Attention Required! | Cloudflare", "Access Denied", "Robot Check", "Zugriff verweigert", "Pardon Our Interruption"]) {
    assert.equal(isBotChallengePage(`<html><head><title>${title}</title></head></html>`), true, title);
  }
  assert.equal(isBotChallengePage("<title>Medion MD 15501 Mikrowelle</title><script>var captcha=1;</script>"), false, "a script mentioning captcha is not a block page");
  assert.equal(isBotChallengePage(""), false);
});

test("only missing slots are planned, and views that need a reference wait for one", () => {
  const existing = [{ role: "hero", url: "u", origin: "user", status: "ready" }];
  const none = planMissingImages({ existing, sourceImages: [], briefs: DEFAULT_IMAGE_BRIEFS });
  assert.ok(none.hasReference, "an owner photo is a reference");
  assert.equal(none.additions.length, 4);
  assert.ok(!none.additions.some((a) => a.role === "hero"), "a role already present is not duplicated");

  const bare = planMissingImages({ existing: [], sourceImages: [], briefs: DEFAULT_IMAGE_BRIEFS });
  assert.equal(bare.hasReference, false);
  assert.deepEqual(bare.additions.map((a) => a.role), ["hero"], "only the view that needs no reference");
  assert.match(bare.reason, /reference photo/i);
});

test("a full set plans nothing", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ role: `r${i}`, url: "u", origin: "ai", status: "ready" }));
  assert.equal(planMissingImages({ existing: five, sourceImages: [], briefs: DEFAULT_IMAGE_BRIEFS }).additions.length, 0);
});

test("a source image counts as a reference for generation", () => {
  const out = planMissingImages({ existing: [], sourceImages: ["https://x/y.jpg"], briefs: DEFAULT_IMAGE_BRIEFS });
  assert.equal(out.hasReference, true);
  assert.equal(out.additions.length, 5);
});

test("publication needs verified source information", () => {
  const product = { title: "t", categoryId: "c", brandId: "b", imageUrl: "https://x/y.jpg", buyerPrice: 1, monthlyBuyerPrice: 1 };
  const base = { images: [{ url: "https://x/y.jpg", origin: "user" }], providers: { text: { real: true } } };

  const without = evaluatePublicationBlockers({ product, draft: { ...base, provenance: { extractedFacts: {} }, pastedDetails: "" } });
  assert.ok(without.blockers.some((b) => /verified source/i.test(b)));

  const withFacts = evaluatePublicationBlockers({ product, draft: { ...base, provenance: { extractedFacts: { name: "X" } }, pastedDetails: "" } });
  assert.ok(!withFacts.blockers.some((b) => /verified source/i.test(b)));

  const withDetails = evaluatePublicationBlockers({ product, draft: { ...base, provenance: { extractedFacts: {} }, pastedDetails: "specs" } });
  assert.ok(!withDetails.blockers.some((b) => /verified source/i.test(b)));
});

test("when the model proposed only two views, the owner's photo tops the set up to five", () => {
  const modelBriefs = [
    { role: "hero", prompt: "front", requiresReference: false },
    { role: "detail", prompt: "control panel", requiresReference: true },
  ];
  const existing = [
    { role: "hero", url: "a", origin: "ai", status: "ready" },
    { role: "detail", url: "b", origin: "ai", status: "ready" },
    { role: "user-upload", url: "c", origin: "user", status: "ready" },
  ];
  const out = planMissingImages({ existing, sourceImages: [], briefs: modelBriefs });
  assert.equal(out.additions.length, 2, "five slots in total");
  assert.ok(out.additions.every((a) => !["hero", "detail"].includes(a.role)), "no role is duplicated");
});

test("without an owner photo the model's restraint is respected", () => {
  const modelBriefs = [{ role: "hero", prompt: "front", requiresReference: false }, { role: "detail", prompt: "x", requiresReference: true }];
  const existing = [{ role: "hero", url: "a", origin: "ai", status: "ready" }, { role: "detail", url: "b", origin: "ai", status: "ready" }];
  const out = planMissingImages({ existing, sourceImages: ["https://x/y.jpg"], briefs: modelBriefs });
  assert.equal(out.additions.length, 0, "a retailer photo alone does not license invented extra views");
});
