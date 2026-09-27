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
| `GEMINI_TEXT_MODEL` | Default `gemini-3.8-flash`. |
| `GEMINI_IMAGE_MODEL` | Default `gemini-3.1-flash-image`. |
| `AI_TEXT_TIMEOUT_MS` / `AI_IMAGE_TIMEOUT_MS` | Provider deadline, default 30 s. |
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


## After publication

A published listing does not change when you edit the draft. Regenerated text,
replaced, deleted or reordered images are held as a **pending revision**; the
storefront keeps serving the version you approved until you press **Apply to
live listing**. You can also discard the revision and keep what is live.

The same rules are enforced from the ordinary product editor: an AI-origin
product cannot be switched to active there while it would fail the draft checks.

## If generation fails

Nothing is lost. The URL, both prices, your instruction and your uploaded photos
are stored before any provider is called, so a failed or interrupted job is
finished with **Resume generation** rather than re-entered. A job whose request
was killed mid-flight becomes resumable once its lease expires.

## Runtime budget

The deployed function ceiling is 60 s. Provider calls are capped at 30 s so the
remainder covers reference downloads, Cloudinary upload and persisting the
result or the error. Each image is generated in its own request, holds a lease
so a duplicate request cannot pay twice, and a storage failure retries the
upload rather than discarding an image that has already been paid for.

## Verification before production

Mocked runs are not sufficient evidence. Before asking for production approval,
verify with real credentials in an isolated environment: extraction from a
reachable product page, real AI text, five real generated images, media storage,
and the approval/revision behaviour.
