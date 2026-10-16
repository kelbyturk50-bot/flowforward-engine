-- Tightened prospect_brands checks. migrate.js runs this only after schema.sql
-- has committed, in its own transaction, with SET LOCAL lock_timeout 5s and
-- statement_timeout 15s. Adding NOT VALID does not scan existing rows.
-- VALIDATE scans them. A failure raises a warning and does not roll back the
-- NOT VALID constraint or schema.sql. New rows are still checked.
--
-- Do not DROP the previous checks here. A database from 51c459d keeps
-- prospect_brands_name_test and prospect_brands_logo_http. These names are new,
-- so ADD is idempotent. This file does not delete brand rows. A TEST: cleanup
-- must match test_tag with = or IN (...) and must not use LIKE.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_brands_name_strict'
  ) THEN
    ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_name_strict
      CHECK (
        char_length(name) BETWEEN 6 AND 120
        AND left(name, 5) = 'TEST:'
        AND position('@' IN name) = 0
        AND name !~ U&'[[:cntrl:]<>\200B-\200F\202A-\202E\2060-\2064\2066-\2069\FEFF]'
        AND btrim(substring(name from 6)) ~ '[[:graph:]]'
      ) NOT VALID;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prospect_brands: name check not installed: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_brands_logo_https'
  ) THEN
    ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_logo_https
      CHECK (
        logo_url IS NULL OR (
          char_length(logo_url) BETWEEN 8 AND 300
          AND logo_url ~ '^https://'
          AND logo_url !~ '://[^/?#]*@'
          AND logo_url !~ '[[:space:][:cntrl:]]'
          AND logo_url !~ '[''"`();\\<>{}]'
        )
      ) NOT VALID;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prospect_brands: logo check not installed: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE prospect_brands VALIDATE CONSTRAINT prospect_brands_name_strict;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prospect_brands: name check validation failed: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER TABLE prospect_brands VALIDATE CONSTRAINT prospect_brands_logo_https;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prospect_brands: logo check validation failed: %', SQLERRM;
END $$;
