BEGIN;

-- Multiple app containers can start against one database at the same time.
-- Serialize this transaction so concurrent CREATE INDEX attempts cannot
-- deadlock or make one otherwise healthy container fail startup.
SELECT pg_advisory_xact_lock(
  hashtext('arr-dashboard'),
  hashtext('postgresql-v2.24-list-cache-identity')
);

DO $migration$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF to_regclass(format('%I.%I', schema_name, 'tmdb_list_cache')) IS NOT NULL THEN
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (%I, %I, %I, %I)',
      'tmdb_list_cache_userId_listId_mediaType_tmdbId_key',
      schema_name,
      'tmdb_list_cache',
      'userId',
      'listId',
      'mediaType',
      'tmdbId'
    );
    EXECUTE format(
      'DROP INDEX IF EXISTS %I.%I',
      schema_name,
      'tmdb_list_cache_userId_listId_tmdbId_key'
    );
  END IF;

  IF to_regclass(format('%I.%I', schema_name, 'trakt_list_cache')) IS NOT NULL THEN
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (%I, %I, %I, %I)',
      'trakt_list_cache_userId_listSlug_mediaType_tmdbId_key',
      schema_name,
      'trakt_list_cache',
      'userId',
      'listSlug',
      'mediaType',
      'tmdbId'
    );
    EXECUTE format(
      'DROP INDEX IF EXISTS %I.%I',
      schema_name,
      'trakt_list_cache_userId_listSlug_tmdbId_key'
    );
  END IF;
END
$migration$;

COMMIT;
