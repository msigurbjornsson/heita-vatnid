CREATE TABLE IF NOT EXISTS readings (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 source_id TEXT NOT NULL UNIQUE,
 collector_id TEXT NOT NULL,
 timestamp TEXT NOT NULL,
 water_observed INTEGER NOT NULL,
 hot_water_m3 REAL,
 payload TEXT NOT NULL,
 received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS readings_time ON readings(timestamp);

-- Materialized views: public reads fetch one cache row, not the full readings table.
CREATE TABLE IF NOT EXISTS dashboard_cache(cache_key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS telemetry_chunks(chunk_key TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS water_days(day TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_lease(id INTEGER PRIMARY KEY,until_ms INTEGER NOT NULL);
