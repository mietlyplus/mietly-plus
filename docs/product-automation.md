# Product automation — create a listing from a link

Paste a product URL, enter your two rental prices, optionally add photos and a
note, tap **Create Draft**. The system extracts the product, drafts the listing,
plans up to five images, and leaves you a **private** draft to review.
Nothing is ever published without your explicit approval.

## Admin routes

| Route | Purpose |
|---|---|
| `/admin/products/create-from-link` | Mobile-first creation screen (5 fields). Stable URL — safe to add to a phone home screen. |
| `/admin/products/draft/[id]` | Review: provenance, warnings, per-image controls, publish. |
| `/admin/products/edit/[id]` | The existing full editor — every field. |

## How it flows

```
URL + weekly € + monthly € + photos + note
  -> SSRF-safe fetch          backend/lib/source/fetch-source.js
  -> extract facts            backend/lib/source/extract-product.js   (JSON-LD > OG > DOM)
  -> generate listing text    backend/lib/ai/providers.js             (Gemini | fixture)
  -> plan up to 5 images      backend/lib/ai/draft-service.js
  -> build Product payload    backend/lib/product-payload.js
  -> Product (isActive:false) + ProductDraft (provenance)
  -> review -> approve -> isActive:true
```

The work is split into steps the browser drives (create, then one image at a
time) so each request stays inside the 60 s serverless limit and a single failed
image never re-runs the text or the other images.

## Pricing

Your two inputs are the only source of rent:

| You enter | Product field |
|---|---|
| Weekly rental price | `buyerPrice` |
| Monthly rental price | `monthlyBuyerPrice` and `monthlyPrice` |

`offerPrice` / `monthlyOfferPrice` stay `0` — no fake discount is invented. A
retailer's purchase price is stored under `provenance.retailerPrice` for
reference and **never** affects rent.

## Images

Priority: **your photos** → source imagery → verified text. If you upload five
suitable photos, nothing is generated. Per image you can keep, delete, replace,
upload your own, regenerate only that one, reorder, or make it the cover.

When the references cannot support a requested view, the system **flags the
limitation and asks for another reference** instead of inventing one.

## Providers

Configured through environment variables; no provider is hard-coded into the
workflow.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Enables the real Gemini text + image providers. |
| `GEMINI_TEXT_MODEL` | Default `gemini-2.5-flash`. |
| `GEMINI_IMAGE_MODEL` | Default `gemini-2.5-flash-image`. |
| `AI_TEXT_PROVIDER` / `AI_IMAGE_PROVIDER` | `gemini` (default) or `fixture`. |

**Without `GEMINI_API_KEY` the system runs on DEV FIXTURE providers.** Fixture
output is visibly labelled, carries a `fixture_provider` warning, and **cannot
be published** — the backend refuses both fixture images and fixture text.

## Safety

- Draft privacy: `isActive: false`, filtered out by every public route.
- Publication: `POST /api/admin/product-drafts/:id/publish` with `confirm: true`,
  admin-authenticated, with server-side blockers (title, category, brand, a real
  image, both prices, no fixture content).
- Source pages are untrusted data. Prompt injection found in them is ignored and
  reported as `suspicious_source_content`.
- Fetching refuses non-http(s) schemes, private/loopback/link-local/metadata
  addresses, redirect chains into private space, oversized bodies and slow hosts.
  Login walls and bot protection are reported, never bypassed.
