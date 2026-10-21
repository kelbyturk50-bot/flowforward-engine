-- Undo for one pest-name archive run. Not applied on boot.
-- Restores rows tagged with this reason AND this run id. A different
-- reason, or the same reason from another run, stays archived.
-- Fit columns are not changed. The run id is a bound parameter ($1).
WITH updated AS (
  UPDATE prospects
     SET archived_at = NULL,
         archive_reason = NULL,
         archive_run_id = NULL
   WHERE archive_reason = 'pest-name gate (#39)'
     AND archive_run_id = $1
  RETURNING 1
)
SELECT COUNT(*)::int AS n FROM updated;
