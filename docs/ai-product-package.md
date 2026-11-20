# AI Product Package

A product prepared by ChatGPT Work (or anyone) travels as one JSON document, not a spreadsheet row. Leihfluss validates it on the server and imports it as a **private draft**. Publication is always a separate, explicit owner action.

```
ChatGPT Work -> package JSON (+ image files) -> Admin > AI Product Queue -> validation
             -> READY / INVALID -> Import (selected or all ready) -> private draft -> owner review -> Publish
```

Schema id: `leihfluss.product-package/1`. Working examples: [`docs/examples/package-standard.json`](examples/package-standard.json) and [`docs/examples/package-occasion.json`](examples/package-occasion.json).

## Fields

| Section | Content |
| --- | --- |
| `externalId` | Stable id. Re-sending a not-yet-imported package replaces it; an imported id is refused (no duplicates). |
| `rentalMode` | `standard` (weekly/monthly) or `occasion` (daily rate, 1-7 days). |
| `identity` | `brand`, `model`, `series`, `sku`, `identifiers{ean,gtin,mpn}`, `category{name}` |
| `titles` | `de`, `en` |
| `descriptions` | `shortDe`, `shortEn`, `longDe`, `longEn` |
| `includedItems[]` | `{de,en,quantity}` for bundles and party packages |
| `specifications[]` | `{key,value,keyEn?,valueEn?}`, any number (first 80 kept). `key/value` is German; `keyEn/valueEn` is the optional English wording |
| `delivery` | `{leadDays}` optional, 0-30 days before the earliest rental start (default 2) |
| `tags[]` | strings |
| `pricing` | standard: `{weekly, monthly}`. occasion: `{daily}` (price per day; legacy `{occasion:[{days,price}]}` is converted to a daily rate with a warning) |
| `seo` | `metaTitle`, `metaDescription`, `keywords[]`, `canonicalUrl`, `ogTitle`, `ogDescription` |
| `images[]` | `{url or file, origin, role, altDe, altEn, license, note, primary}` |
| `sources[]` | `{type: url/pdf/photo/instruction/other, url, label, note}` |
| `warnings[]` | uncertain information the owner should check |

New optional sections can be added later without breaking old packages; unknown keys are ignored.

## Validation

- **INVALID (cannot import):** wrong `schema`, no title, bad `rentalMode`, standard without weekly **and** monthly price, occasion without a daily price greater than 0.
- **Warnings (import allowed):** missing brand, category, descriptions, SEO fields, alt text, sources; a licensed image with no license; fewer than five images; a legacy per-length occasion price list that had to be converted; over-long meta title/description.
- Nothing is ever written from an invalid package.

## Images

`origin` is one of `owner_photo`, `ai_generated`, `licensed_asset`, `reference_only`.

- `reference_only` images (for example retailer photos) are recorded as provenance and **never become listing images**.
- An image needs an https `url`, or a `file` name matching a file you select in the queue page (uploaded before the package is sent).
- Images on our own Cloudinary are kept. Any other https image is downloaded under the SSRF/size limits and re-hosted.
- Five images is a target. At most five are imported; fewer is fine and nothing is generated automatically.
- Provenance (origin, license, note) is kept on each draft image.

## Matching

Category and brand are matched against **existing** records, and only an exact match is applied. Otherwise they stay unresolved and the draft asks the owner to choose (or explicitly add a new one). A package never creates a category or brand.

## Occasion (short-term) rentals

`rentalMode: "occasion"` stores one **daily rate** (`pricing.daily`, e.g. 50). The customer picks 1 to 7 days and pays `daily rate x days` (1 day = 50, 2 = 100, 3 = 150, 7 = 350) **once** at checkout; there is never a subscription for an occasion product. The server calculates the amount from the stored rate and refuses any day count outside 1-7. Delivery fee and deposit are added once. Occasion products are never required to have weekly or monthly prices.

## After import

The occasion daily rate and the delivery lead time can be edited at any time from the draft review screen or the product editor (**Rental terms** card): change the daily price. The server enforces a price greater than 0. No re-import is needed.

## Catalog reset

`backend/scripts/archive-catalog.js` hides all active products (never deletes), writes a backup first (default `~/leihfluss-backups`), asks you to type a confirmation, and can `--restore` from the backup. Dry run by default.

## Not in this release

Google/Gmail integration, a direct ChatGPT-to-Leihfluss API connection, and hreflang (language is a toggle on one URL, not separate URLs).

## Full product settings (all optional)

Besides `pricing.weekly` / `pricing.monthly`, a package can carry the rest of the product. Omitted values keep the product defaults; supplied values are stored as given. See `docs/examples/package-standard-full.json`.

| Section | Fields |
|---|---|
| `pricing` | `weekly`, `monthly`, `weeklyOffer`, `monthlyOffer` (offers must be below the base price), `daily` (occasion) |
| `inventory` | `stock`, `stockStatus` (`in_stock`/`low_stock`/`out_of_stock`/`preorder`), `lowStockWarning`, `maxRentalQuantity`, `unit`, `weightKg` |
| `rental` | `minWeeks`, `maxWeeks`, `minMonths`, `maxMonths` |
| `delivery` | `leadDays` (0-30), `fee` |
| `risk` | `verificationRequired`, `depositEnabled`, `securityDeposit`, `replacementValue`, `refundable` (per product; defaults: verification on, deposit off) |
| `display` | `isMostPopular` |
| `images[]` | `order`, `primary`, `altDe`, `altEn`, `origin`, `license`, `note` |

Invalid optional values are ignored with a warning, never silently replaced. Imports are always inactive.

**Category and brand** match existing records exactly, never partially, and are never created. `identity.category` may be a name, `"Parent > Child"`, `{ "name": … }` or `{ "path": ["Parent", "Child"] }`. A name that exists under several parents is ambiguous and stays unresolved. Unresolved category/brand block publication until the owner chooses.

## Upload (Admin → AI Product Queue)

One drop zone accepts the JSON file(s) and their images together. An image entry uses `"file": "name.webp"`, matched to an uploaded file by exact filename. The screen shows READY/INVALID, title, image count, missing referenced images and unused images before anything is added.

## Product link workflow: source fallback

If the supplied page is blocked, unreadable or too thin, the importer does not try to get past the block. It searches the web for the exact product (manufacturer first, then accessible retailers), reads up to three of those pages with the same hardened fetcher, merges the facts, flags disagreements, and records the sources on the draft. Owner prices stay authoritative; retailer purchase prices are never used. AI image generation is optional and only runs when the owner presses the button.

## Cleanup

```bash
cd backend
npm run clean:products              # dry run: prints DB host/name and counts
node scripts/clean-product-data.js --apply   # asks for a typed confirmation phrase
```

Deletes only Products, ProductDrafts and ProductPackages.
