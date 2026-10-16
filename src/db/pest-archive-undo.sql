-- Undo for the pest-name archive. Not applied on boot.
-- Restores exactly the rows tagged with this reason. A different
-- archive_reason stays archived. Fit columns are not changed.
-- Running the archive script again will tag matching active rows once more.
WITH updated AS (
  UPDATE prospects
     SET archived_at = NULL,
         archive_reason = NULL
   WHERE archive_reason = 'pest-name gate (#39)'
  RETURNING 1
)
SELECT COUNT(*)::int AS n FROM updated;
