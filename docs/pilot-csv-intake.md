# Pilot #1 CSV estimate intake

This slice stores open estimates from a CSV for one shop. It does not send email, run a cadence, connect a mailbox, or accept forwarded mail. Forwarded intake waits on Kelby. Jobber is out of scope.

## Flag and auth

`FF_PILOT_ESTIMATE_RECOVERY` must be effectively on, and `CRM_API_KEY` must trim to at least 32 non-whitespace characters. The flag is a `feature_flags` row, seeded off. A trimmed case-insensitive env value `false`, `off`, `0`, or `no` forces it off. An empty string or an unset variable uses the row. Any other env value also uses the row. Env never forces the flag on. Spaces do not count toward the key length, so 32 spaces, or 31 characters plus a space, leave the routes closed. Otherwise every route under `/api/pilot/estimate-recovery` returns **404** and writes nothing. A missing key does not leave the routes open.

When that key is set, the routes also require `x-api-key` (a `Bearer` token is also accepted). A missing or wrong key is **401** and writes nothing.

## Customer

`POST /api/pilot/estimate-recovery/customers` with `{ "name": "Shop name" }` creates the shop row.

`live_send_enabled` is stored `false`. If `liveSendEnabled` or `live_send_enabled` is present, the only accepted value is boolean `false`. Anything else, including `true`, `"true"`, `1`, or `"false"`, is **400** and does not insert. No route in this slice turns the column on.

## CSV columns

`POST /api/pilot/estimate-recovery/customers/:customerId/estimates`

Send `Content-Type: text/csv`, or JSON `{ "csv": "..." }`.

| Column | Required | Stored as | Notes |
|---|---|---|---|
| `estimate_id` | yes | `source_estimate_id` | Source id. Unique with the customer. A re-upload updates that row. A value that starts with `=`, `+`, `-`, `@`, tab, CR, full-width `＝＋－＠`, or small-form `﹦﹢﹣﹫` is rejected. |
| `email` | yes | `email` | Must be a valid email. Stored lowercase. A value that starts with `=`, `+`, `-`, `@`, tab, CR, full-width `＝＋－＠`, or small-form `﹦﹢﹣﹫` is rejected. |
| `first_name` | no | `homeowner_first_name` | First name only. 60 characters. A leading run of `=`, `+`, `-`, `@`, tab, CR, full-width `＝＋－＠`, or small-form `﹦﹢﹣﹫` is stripped before storage, so `-Ann` is stored as `Ann` and `=Ada` as `Ada`. Bidi, zero-width, and C1 controls are rejected. |
| `job_type` | no | `job_type` | Short label. 80 characters. A value that starts with `=`, `+`, `-`, `@`, tab, CR, full-width `＝＋－＠`, or small-form `﹦﹢﹣﹫` is rejected. Bidi, zero-width, and C1 controls are rejected. |
| `amount` | no | `amount` | `4200.50`. No `$` or commas. |
| `estimate_date` | no | `estimate_date` | `YYYY-MM-DD`. |
| `status` | no | `status` | `open` (default), `sold`, `lost`, `expired`, `opted_out`. |

Header names are case-insensitive. `source_estimate_id`, `homeowner_first_name`, and `date` are accepted aliases. Any other column, including `notes`, is ignored and is not stored.

Limits: **256 KiB** and **2000** data rows. Over either limit the request is rejected and nothing is written.

The response is a per-row report. Valid rows are upserted. Invalid rows are listed in `errors` with a 1-based file row number and a field name, and those rows are not stored. The last valid row for an estimate id in the file wins. Uploading the same id again updates the stored fields and does not insert a second row. The same source id on a different customer is a different row.

## Export

`GET /api/pilot/estimate-recovery/customers/:customerId/estimates` returns JSON for that customer only: source estimate id, first name, email, job type, amount, estimate date, status, and timestamps.

`?format=csv` returns those same fields as CSV (`Content-Disposition: attachment`). A value whose first character is `=`, `+`, `-`, `@`, tab, CR, full-width `＝＋－＠`, or small-form `﹦﹢﹣﹫` is prefixed with `'` and quoted, including when spaces (or U+3000) sit in front of that character, so a spreadsheet does not treat it as a formula. The file can be posted back; timestamps are ignored on intake. The leading `'` is stored if that file is uploaded again.

## Retention and delete

`DELETE /api/pilot/estimate-recovery/customers/:customerId/estimates` deletes every estimate row for that customer and returns the count. The shop row stays, with `live_send_enabled` still false. A second delete returns `deleted: 0`.

`pilot_open_estimates.customer_id` references `pilot_customers` with `ON DELETE CASCADE`. Deleting the shop row deletes that shop's estimates. It does not delete `pilot_estimate_suppressions`. Those rows stay, keyed to the old customer id. Inserting a shop again allocates a new id, and that id does not inherit the old list. There is no route that deletes a customer; this is what a manual `DELETE` from `pilot_customers` does.

Stored homeowner fields are only the columns above. There is no notes, phone, last name, or address column.

## Opt-out (CAN-SPAM)

`status=opted_out` sticks. A later upload of the same estimate id does not move that row back to `open`, `sold`, `lost`, or `expired`, even when the new file omits status (the file default is `open`).

The normalized email is also written to `pilot_estimate_suppressions`, keyed by `(customer_id, email)`. That list survives a re-upload, `DELETE` of the estimates, and `DELETE` of the customer. Uploading that email again, on the same estimate id or a new one, is stored as `opted_out`. Another shop's copy of the same email is not suppressed.

Changing the email on a row that is already `opted_out` keeps the row `opted_out` and also suppresses the new address. The previous address stays on the list. That over-suppresses, which is the safe direction for a later send.

The list stores the plaintext normalized email. A keyed HMAC of that email, so the table can outlive the estimate without keeping the address, is a follow-up. This slice does not hash it.

This slice does not send, so the list is the record a later send must honor: no automated email to a suppressed address, and an opt-out is not cleared by a CRM re-import.

## Boot checks

Bidi, zero-width, and C1 checks on first name and job type are added `NOT VALID` in `schema.sql`, then validated in `src/db/estimate-constraints.sql` after that file commits. The validation step uses a 5 second lock timeout and a 15 second statement timeout. A legacy row that fails the check is logged and left in place. That log does not include the name. Boot still commits, including `pilot_estimate_suppressions`. New inserts of those characters are still rejected.

## Kill switch

Two gates, both defaulting to no send:

- `pilot_customers.live_send_enabled` defaults to `false`.
- `globalSendKilled()` in `src/pilot/kill-switch.js` is true unless `FF_PILOT_ESTIMATE_LIVE_SEND` is exactly `true`.

This slice does not call a mail transport. Agents do not send.
