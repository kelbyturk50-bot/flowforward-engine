# Offer tracking

Records offers made to a lead. A lead is a `prospects` row. `lead_offers.prospect_id` references `prospects(id)` with `ON DELETE RESTRICT`: a lead that has offers cannot be deleted, so its offer history and any founding slot it holds stay. `DELETE /api/prospects/:id` on such a lead is 409; archive the lead instead. The table is added by `src/db/schema.sql` on boot. The statements are additive and idempotent, and they do not change existing tables. The boot checks look up each constraint by name on `lead_offers` only.

`FF_OFFER_TRACKING` is an environment variable. The routes stay closed unless it is exactly `true`. They are mounted after `requireApiKey`, and a closed route is skipped, so it answers exactly like an unknown `/api` path: 401 without a key, 404 with one. A missing or wrong key is 401. An unready key is 503.

Routes:

- `GET /api/offers` returns the offers and a summary: counts by `offer_type` and by `status`, plus `founding_slots` (`used` is accepted founding offers, `pending` is founding offers still `offered`, `cap` is 3).
- `GET /api/leads/:id/offers` returns that lead's offers. An unknown lead is 404.
- `POST /api/offers` checks the enums and `prospect_id`. Bad input is 400. `offered_at` is `YYYY-MM-DDTHH:MM:SS[.sss]Z` and must be a real time: `2026-02-30T12:00:00Z` or `T24:00:00Z` is 400, not rolled over. `notes` is at most 2,000 characters with no NUL.
- `PATCH /api/offers/:id` sets `status` and `status_changed_at`.

Founding cap: when 3 founding offers are already `accepted`, creating another founding offer, or moving a founding offer to `accepted`, returns 409 `{ "warning": "founding_cap", "founding_slots": { "used", "pending", "cap": 3 } }`. The write succeeds only when the body has `confirm_over_cap: true`. The check and the write run in one transaction that holds an advisory lock. Every accepted founding row counts, including `is_test` rows.

Package values are keys only: `starter`, `receptionist`, `front_office`, `consulting`.

This slice does not mail.
