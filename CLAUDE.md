# CLAUDE.md

Guidance for AI assistants working in the Leihfluss repository.

**These rules are not optional and are not overridden by a request to move
faster.** If a task appears to require breaking one of them, stop and ask.

---

## 1. Non-negotiable working rules

### Branching
- **Never work directly on `main`.** Check the current branch before editing.
- **Create a dedicated branch for every task**, named `fix/…`, `feat/…`,
  `chore/…` or `docs/…`. One branch per task; do not stack unrelated work.
- If you find yourself on `main` with uncommitted changes, stop and ask before
  moving them.

### Production safety
Production is **live**. Without **explicit, per-task approval from the user**,
never:
- deploy, promote, or trigger a build on Vercel;
- modify Vercel project settings, domains, or environment variables;
- modify production MongoDB data, indexes, or collections (reads for
  diagnosis are fine; writes, migrations and bulk updates are not);
- modify Stripe settings, webhooks, products, prices, or issue refunds;
- modify Cloudinary assets or settings;
- change any other production service or third-party integration.

Approval is **per task**. Approval for one action never carries over to the
next one, or to a later session.

Writing *code* that will later touch these services is fine. *Executing* it
against production is not.

### Secrets
- **Never commit or print secrets.** No API keys, tokens, connection strings,
  passwords, or webhook secrets in source, tests, fixtures, logs, commit
  messages, or chat output.
- `.env` files are gitignored and must stay that way. Document new variables in
  `backend/.env.example` with an empty value.
- Never hardcode credentials in scripts. Read them from the environment or CLI
  arguments.
- If you find a committed secret, **say so immediately and prominently**.
  Deleting the file does not remove it from git history — the credential must be
  rotated by a human.

### Process
- **Inspect `git status` before starting any task.** Know what is already
  modified before you add to it.
- **Run the relevant tests before committing.** See §4. If tests fail, say so
  with the output; never describe unverified work as done.
- **Do not silently change unrelated functionality.** Stay inside the scope you
  were given. If you spot an unrelated problem, report it and let the user
  decide — do not fix it in passing, and do not quietly widen or narrow scope.
- **Do not commit unless asked.** Never push, open a PR, or merge without an
  explicit instruction.

### Reporting
End every task with a concise summary containing:
1. **Files changed** — with what changed in each.
2. **Behaviour changed** — what is now different at runtime.
3. **Tests/checks run** — and their actual results.
4. **Risks** — compatibility, data, or security implications.
5. **Remaining manual actions** — anything a human must do (rotate a
   credential, set an env var, configure a dashboard).

Report outcomes faithfully. Skipped steps and failures get stated plainly.

---

## 2. Architecture

Two independently deployed apps in one repository. No shared package.

| | Backend | Frontend |
|---|---|---|
| Stack | Express 5, Mongoose 9, Node 22 | Next.js 16 App Router, React 19, Tailwind 4 |
| Entry | `backend/index.js` locally; `backend/api/index.js` on Vercel | `next start` |
| Data | MongoDB (default db `mietlyplus`) | — |
| External | Stripe (Checkout + Identity), Cloudinary, SMTP, Google token verification | — |

`backend/index.js` is a single large file holding all routes, mappers and email
templates. Models live in `backend/models/`, shared logic in `backend/lib/`.
**Prefer extracting new logic into `backend/lib/` so it can be unit-tested**
rather than growing `index.js` further.

The Vercel adapter rewrites every request through
`api/index.js?__path=…` and restores `req.url` before Express sees it. Keep this
in mind when adding routes or middleware that depend on the request path.

### Frontend surfaces
- Storefront: `/`, `/shop`, `/rental/[categorySlug]/[slug]` (canonical product
  page; `/product/[slug]` is a legacy redirect), `/cart`, `/checkout`.
- Blog: `/blog`, `/blog/[slug]` (`/company/blog` redirects to `/blog`).
- Admin: `/admin/*`, guarded client-side by `AdminShell` and server-side by
  `requireAdminAuth`. Customers, Inventory, Subscriptions and Settings are
  **placeholders**, not working modules.

---

## 3. Invariants — do not regress these

**Pricing is server-authoritative.** The backend must never trust a chargeable
amount from a client. `/api/payments/checkout-session` accepts only intent —
product id, period unit, duration, quantity, start date — and derives every
euro figure from the persisted `Product` via `backend/lib/pricing.js`. If you
touch checkout, keep it that way and extend the tests in
`backend/lib/pricing.test.js`.

**The storefront displays server-calculated amounts.** The cart and checkout
pages render totals from `/api/payments/checkout-quote`, not from their own
arithmetic over `localStorage`. A customer must never be shown one amount and
charged another.

**Stripe webhooks are the source of truth for payment state.** Order payment is
confirmed by the signature-verified `/api/payments/stripe-webhook`, made
idempotent by a unique index on the Stripe event id. `/api/payments/checkout-confirm`
is advisory only — do not make the success page authoritative again. The webhook
route must stay excluded from JSON body parsing so signature verification sees
the exact signed bytes.

**Authentication fails closed.** `JWT_SECRET` has no fallback. If it is missing,
auth routes return 500 rather than signing with a known value. Never reintroduce
a default secret.

---

## 4. Commands

```bash
# Backend (from backend/)
npm install
npm run dev            # node --watch index.js
npm test               # node --test  — run before every commit
npm run seed:admin     # requires ADMIN_EMAIL + ADMIN_PASSWORD

# Frontend (from frontend/)
npm install
npm run dev
npx tsc --noEmit       # typecheck — run before every commit
npm run build
npm run lint
```

Before committing, run **backend `npm test`** and **frontend `npx tsc --noEmit`**
at minimum. Run `npm run build` when frontend changes are non-trivial.

Backend tests use the built-in `node --test` runner with no database. Keep new
tests DB-free by extracting pure logic or stubbing the Mongoose query builder
(see `backend/checkout-quote.test.js` for the pattern).

`frontend/components/cookie-consent-popup.tsx` has a pre-existing lint error.
It is not yours; do not let it block a commit, and do not fix it as a drive-by.

---

## 5. Known gaps

Audited and deliberately unaddressed. Do not assume these are handled, and do
not fix them without being asked:

- No stock enforcement at checkout; stock is never decremented. Overselling is
  possible.
- `app.use(cors())` with no origin allowlist.
- No rate limiting anywhere, including signin, admin login, OTP requests and
  support-request submission.
- Flat admin privileges — any admin can create another admin.
- No Express error-handling middleware; failures can return HTML stack traces.
- No customer-facing order history endpoint or page.
- Account deletion leaves personal data on `Order` documents (GDPR relevant).
- `weeklyAutoDiscount` / `monthlyAutoDiscount` are stored and editable but never
  applied by any pricing path.
- Three `dangerouslySetInnerHTML` sinks (blog body, product description,
  category SEO HTML) with no sanitisation.

---

## 6. Outstanding manual actions

Human-only. Do not attempt these:

- **Rotate the admin password** for the account previously hardcoded in
  `backend/scripts/create-admin.js`. It remains in git history.
- **Verify `JWT_SECRET` is set** in the Vercel backend project. If it was ever
  unset, production signed tokens with a publicly known default.
- **Register the Stripe webhook** at `/api/payments/stripe-webhook` for
  `checkout.session.completed`, `async_payment_succeeded`,
  `async_payment_failed` and `expired`, then set `STRIPE_WEBHOOK_SECRET`.
- **Confirm webhook raw-body handling on a Vercel preview** before relying on it
  in production; some serverless runtimes pre-parse request bodies.
- **Audit `maxRentalQuantity`** across the catalogue. It defaults to `1` and is
  now enforced at checkout and reflected in the cart quantity selector.
