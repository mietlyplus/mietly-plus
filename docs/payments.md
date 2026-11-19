# Payment model

The server decides every amount from the stored product; the browser only states intent (product, quantity, duration, start date). A request that carries prices is not trusted.

## Standard rentals (weekly / monthly)

A rental of more than one period is a **fixed-term subscription**: the rental price is charged once per period for exactly the booked number of periods, then billing stops by itself.

- 3 weeks at €20/week: €20 at checkout, €20 after one week, €20 after two weeks, then nothing more.
- 3 months at €50/month: the same, monthly.
- **Delivery fee and security deposit are charged once**, with the first payment. They never recur.
- A one-period rental (1 week or 1 month) is a single payment.
- All recurring lines in one checkout must share the billing period (weekly or monthly). A one-period line can join either. Weekly and monthly subscriptions are ordered separately.

How it is built: Stripe Checkout in `subscription` mode takes the recurring price plus the one-time delivery/deposit item. When checkout completes, the subscription is attached to a Stripe **subscription schedule** (`end_behavior: cancel`, one phase per distinct length) so it ends automatically after the last payment.

## Occasion rentals

One **daily rate** per product. The customer chooses 1 to 7 days and pays `daily rate x days` once, plus delivery and deposit once. Always a single payment, never a subscription.

## Order tracking

`Order.billingMode` (`one_time` | `recurring`), `stripeSubscriptionId`, `stripeSubscriptionScheduleId`, and for recurring orders `recurring`: interval, `billingCycles`, `successfulCycles`, `recurringAmount`, `totalRentalCommitment`, `oneTimeCharges`, `dueToday`, `nextBillingDate`, `status` (`pending`, `active`, `past_due`, `completed`, `cancelled`).

`paymentStatus` is `partially_paid` after the first payment of a recurring rental and becomes `paid` only when every period has been paid. Historical orders are one-time and unchanged.

## Stripe webhook

Endpoint: `<backend domain>/api/payments/stripe-webhook`. Events to enable:

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | First payment confirmed; recurring order becomes active and the fixed-term schedule is created |
| `checkout.session.async_payment_succeeded` | Delayed payment methods: same as above |
| `checkout.session.async_payment_failed` | Payment did not go through |
| `checkout.session.expired` | Unpaid checkout abandoned: order cancelled |
| `invoice.paid` | A rental period was paid (counted once per invoice id) |
| `invoice.payment_failed` | A recurring payment failed: order is `past_due` |
| `customer.subscription.deleted` | The term ended (`completed`) or stopped early (`cancelled`) |

Every event is processed once (idempotency keyed by Stripe event id, with crash recovery); counting is additionally keyed by invoice id.

Environment: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FRONTEND_URL`. No other variable is needed.
