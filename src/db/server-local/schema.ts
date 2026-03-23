/**
 * SQLite schema for server.db — the server-local staging and bookkeeping database.
 *
 * This file is ALWAYS a local SQLite on the machine where knowledge-server runs.
 * It holds the staging tables (pending_episodes) and server bookkeeping
 * (consolidated_episode, consolidation_state, daemon_cursor).
 *
 * The actual knowledge (knowledge_entry, relations, clusters, embeddings) lives
 * in the configured knowledge stores — which can be local SQLite or remote Postgres.
 *
 * v1: Initial schema — extracted from KnowledgeDB (SQLite) schema v13.
 *   - pending_episodes: staging table for daemon uploads
 *   - consolidated_episode: idempotency log for consolidation
 *   - consolidation_state: global server counters
 *   - daemon_cursor: daemon upload progress
 *
 * Migration from knowledge.db:
 *   On first startup with server.db, if knowledge.db exists and server.db does not,
 *   the staging tables are copied from knowledge.db to server.db automatically.
 */

export const SERVER_LOCAL_SCHEMA_VERSION = 1;

export const SERVER_LOCAL_TABLE_COLUMNS: Readonly<
	Record<string, readonly string[]>
> = {
	pending_episodes: [
		"id",
		"user_id",
		"source",
		"session_id",
		"start_message_id",
		"end_message_id",
		"session_title",
		"project_name",
		"directory",
		"content",
		"content_type",
		"session_timestamp",
		"max_message_time",
		"approx_tokens",
		"uploaded_at",
	],
	consolidated_episode: [
		"source",
		"session_id",
		"start_message_id",
		"end_message_id",
		"content_type",
		"processed_at",
		"entries_created",
	],
	consolidation_state: [
		"id",
		"last_consolidated_at",
		"total_sessions_processed",
		"total_entries_created",
		"total_entries_updated",
	],
	daemon_cursor: ["source", "last_message_time_created", "last_uploaded_at"],
};

export const SERVER_LOCAL_CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
  );

  -- One-time migration tracking — records which legacy DBs have been migrated
  -- into this server.db. Prevents re-running migrations on every startup.
  CREATE TABLE IF NOT EXISTS applied_migrations (
    name       TEXT    PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  -- Pending episodes — staging table written by the daemon, drained by the server.
  -- user_id is set by the daemon from KNOWLEDGE_USER_ID / hostname (provenance only).
  -- Rows are deleted after successful consolidation.
  CREATE TABLE IF NOT EXISTS pending_episodes (
    id               TEXT    PRIMARY KEY,
    user_id          TEXT    NOT NULL DEFAULT 'default',
    source           TEXT    NOT NULL,
    session_id       TEXT    NOT NULL,
    start_message_id TEXT    NOT NULL,
    end_message_id   TEXT    NOT NULL,
    session_title    TEXT    NOT NULL DEFAULT '',
    project_name     TEXT    NOT NULL DEFAULT '',
    directory        TEXT    NOT NULL DEFAULT '',
    content          TEXT    NOT NULL,
    content_type     TEXT    NOT NULL CHECK(content_type IN ('messages', 'compaction_summary', 'document')),
    session_timestamp INTEGER NOT NULL DEFAULT 0,
    max_message_time  INTEGER NOT NULL DEFAULT 0,
    approx_tokens    INTEGER NOT NULL DEFAULT 0,
    uploaded_at      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pending_source_time
    ON pending_episodes(source, max_message_time);

  -- Per-episode idempotency log: prevents re-processing episodes on crash/restart.
  CREATE TABLE IF NOT EXISTS consolidated_episode (
    source           TEXT    NOT NULL,
    session_id       TEXT    NOT NULL,
    start_message_id TEXT    NOT NULL,
    end_message_id   TEXT    NOT NULL,
    content_type     TEXT    NOT NULL,
    processed_at     INTEGER NOT NULL,
    entries_created  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, session_id, start_message_id, end_message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_episode_source_session
    ON consolidated_episode(source, session_id);

  -- Consolidation state: global counters and last-run timestamp.
  CREATE TABLE IF NOT EXISTS consolidation_state (
    id                       INTEGER PRIMARY KEY DEFAULT 1 CHECK(id = 1),
    last_consolidated_at     INTEGER NOT NULL DEFAULT 0,
    total_sessions_processed INTEGER NOT NULL DEFAULT 0,
    total_entries_created    INTEGER NOT NULL DEFAULT 0,
    total_entries_updated    INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO consolidation_state
    (id, last_consolidated_at, total_sessions_processed, total_entries_created, total_entries_updated)
  VALUES (1, 0, 0, 0, 0);

  -- Daemon cursor — tracks what the daemon has uploaded per source.
  CREATE TABLE IF NOT EXISTS daemon_cursor (
    source                    TEXT    PRIMARY KEY,
    last_message_time_created INTEGER NOT NULL DEFAULT 0,
    last_uploaded_at          INTEGER NOT NULL DEFAULT 0
  );
`;
