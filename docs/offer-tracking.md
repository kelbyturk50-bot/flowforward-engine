# Offer tracking

Records offers made to a lead. A lead is a `prospects` row. `lead_offers.lead_id` references `prospects(id)`. The table is added by `src/db/schema.sql` on boot. The statements are additive and idempotent, and they do not change existing tables.

`FF_OFFER_TRACKING` is an environment variable. The routes stay closed unless it is exactly `true`. Closed routes are the same 404 as an unknown path, with or without a request key. Once the routes are open, they use `requireApiKey`. A missing or wrong key is 401. An unready key is 503.

Routes:

- `GET /api/offers` returns the offers and a summary: counts by `offer_type` and by `status`, plus `founding_slots` (`used` is accepted founding offers, `pending` is founding offers still `offered`, `cap` is 3).
- `GET /api/leads/:id/offers` returns that lead's offers. An unknown lead is 404.
- `POST /api/offers` checks the enums and `lead_id`. Bad input is 400.
- `PATCH /api/offers/:id` sets `status` and `status_changed_at`.

Founding cap: when 3 founding offers are already `accepted`, creating another founding offer, or moving a founding offer to `accepted`, returns 409 `{ "warning": "founding_cap", "founding_slots": { "used", "pending", "cap": 3 } }`. The write succeeds only when the body has `confirm_over_cap: true`. The check and the write run in one transaction that holds an advisory lock. Every accepted founding row counts, including `is_test` rows.

Package values are keys only: `starter`, `receptionist`, `front_office`, `consulting`.

This slice does not mail.
