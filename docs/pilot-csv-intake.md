# Pilot #1 CSV estimate intake

This slice stores open estimates from a CSV for one shop. It does not send email, run a cadence, connect a mailbox, or accept forwarded mail. Forwarded intake waits on Kelby. Jobber is out of scope.

## Flag and auth

`FF_PILOT_ESTIMATE_RECOVERY` must be the exact string `true`. Otherwise every route under `/api/pilot/estimate-recovery` returns **404** and writes nothing.

When `CRM_API_KEY` is set, the routes require `x-api-key` (a `Bearer` token is also accepted). A missing or wrong key is **401** and writes nothing.

## Customer

`POST /api/pilot/estimate-recovery/customers` with `{ "name": "Shop name" }` creates the shop row.

`live_send_enabled` is stored `false`. A body that sets `liveSendEnabled` or `live_send_enabled` to true is **400** and does not insert. No route in this slice turns the column on.

## CSV columns

`POST /api/pilot/estimate-recovery/customers/:customerId/estimates`

Send `Content-Type: text/csv`, or JSON `{ "csv": "..." }`.

| Column | Required | Stored as | Notes |
|---|---|---|---|
| `estimate_id` | yes | `source_estimate_id` | Source id. Unique with the customer. A re-upload updates that row. |
| `email` | yes | `email` | Must be a valid email. Stored lowercase. |
| `first_name` | no | `homeowner_first_name` | First name only. 60 characters. |
| `job_type` | no | `job_type` | Short label. 80 characters. |
| `amount` | no | `amount` | `4200.50`. No `$` or commas. |
| `estimate_date` | no | `estimate_date` | `YYYY-MM-DD`. |
| `status` | no | `status` | `open` (default), `sold`, `lost`, `expired`, `opted_out`. |

Header names are case-insensitive. `source_estimate_id`, `homeowner_first_name`, and `date` are accepted aliases. Any other column, including `notes`, is ignored and is not stored.

Limits: **256 KiB** and **2000** data rows. Over either limit the request is rejected and nothing is written.

The response is a per-row report. Valid rows are upserted. Invalid rows are listed in `errors` with a 1-based file row number and a field name, and those rows are not stored. The last valid row for an estimate id in the file wins. Uploading the same id again updates the stored fields and does not insert a second row. The same source id on a different customer is a different row.

## Export

`GET /api/pilot/estimate-recovery/customers/:customerId/estimates` returns JSON for that customer only: source estimate id, first name, email, job type, amount, estimate date, status, and timestamps.

`?format=csv` returns those same fields as CSV (`Content-Disposition: attachment`). The file can be posted back; timestamps are ignored on intake.

## Retention and delete

`DELETE /api/pilot/estimate-recovery/customers/:customerId/estimates` deletes every estimate row for that customer and returns the count. The shop row stays, with `live_send_enabled` still false. A second delete returns `deleted: 0`.

`pilot_open_estimates.customer_id` references `pilot_customers` with `ON DELETE CASCADE`. Deleting the shop row deletes that shop's estimates.

Stored homeowner fields are only the columns above. There is no notes, phone, last name, or address column.

## Kill switch

Two gates, both defaulting to no send:

- `pilot_customers.live_send_enabled` defaults to `false`.
- `globalSendKilled()` in `src/pilot/kill-switch.js` is true unless `FF_PILOT_ESTIMATE_LIVE_SEND` is exactly `true`.

This slice does not call a mail transport. Agents do not send.
