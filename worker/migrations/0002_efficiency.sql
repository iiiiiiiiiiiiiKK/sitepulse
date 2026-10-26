-- Migration 0002 — read-efficiency fixes
--
-- WHY THIS EXISTS
-- ---------------
-- Cloudflare analytics (d1QueriesAdaptiveGroups) attributed 10.17M of the last
-- 24h's 10.23M row reads to a single statement — the retention pruner, which ran
-- on EVERY cron tick (every minute) and could not use an index for its date
-- filter, because nothing indexed `checked_at` on its own:
--
--   EXPLAIN QUERY PLAN SELECT c.id FROM checks c JOIN monitors m ...
--     -> SCAN c USING COVERING INDEX idx_checks_monitor_time   -- full scan
--
-- That is ~12,000 rows read per call, ~850 calls/day against only 6.7k checks.
-- It grows linearly with retained history, so the product would eventually
-- exceed D1's free tier purely by trying to clean up after itself.
--
-- The fix is three indexes: every remaining maintenance/expiry query becomes a
-- range seek instead of a table scan.

CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_created ON deliveries(created_at);
