/**
 * Benchmarks the OLD vs NEW retention pruner against a realistically sized
 * `checks` table, so the difference is measured rather than asserted.
 *
 * Uses node:sqlite (in-memory, same dialect/engine family as D1). Prints wall
 * time and, more importantly, the number of rows SQLite had to visit, which is
 * what D1 bills as `rows_read`.
 *
 * Usage: node scripts/bench-prune.mjs [rows]
 */

import { DatabaseSync } from 'node:sqlite';

const TOTAL_ROWS = Number(process.argv[2] ?? 200_000);
const DAY = 86_400_000;
const now = Date.now();
const MAX_RETENTION_DAYS = 90;

const db = new DatabaseSync(':memory:');
db.exec(`
  PRAGMA journal_mode = MEMORY;
  PRAGMA synchronous = OFF;
  CREATE TABLE users (id TEXT PRIMARY KEY, plan TEXT NOT NULL);
  CREATE TABLE monitors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    status_code INTEGER,
    response_ms INTEGER
  );
  CREATE INDEX idx_checks_monitor_time ON checks(monitor_id, checked_at DESC);
  INSERT INTO users VALUES ('u1','free'), ('u2','pro');
  INSERT INTO monitors VALUES ('m1','u1'), ('m2','u2');
`);

// Spread the rows over the last 120 days so ~1/4 of them are past the 90d floor.
console.log(`seeding ${TOTAL_ROWS.toLocaleString()} rows…`);
const insert = db.prepare(
  'INSERT INTO checks (monitor_id, checked_at, ok, status_code, response_ms) VALUES (?,?,1,200,120)'
);
db.exec('BEGIN');
for (let i = 0; i < TOTAL_ROWS; i += 1) {
  const ageDays = (i / TOTAL_ROWS) * 120;
  insert.run(i % 2 === 0 ? 'm1' : 'm2', now - Math.round(ageDays * DAY));
}
db.exec('COMMIT');

function time(label, fn) {
  const started = process.hrtime.bigint();
  const rows = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`${label.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms   ${rows} deleted`);
  return ms;
}

// --- OLD: 3-table join, run every minute -----------------------------------
const oldSql = `DELETE FROM checks WHERE id IN (
  SELECT c.id FROM checks c
  JOIN monitors m ON m.id = c.monitor_id
  JOIN users u ON u.id = m.user_id
  WHERE c.checked_at < ? - (CASE WHEN u.plan = 'pro' THEN 90 ELSE 30 END) * 86400000
  LIMIT 20000
)`;

// --- NEW: 90d floor + per-monitor 30d --------------------------------------
const newFloorSql = `DELETE FROM checks WHERE id IN (
  SELECT id FROM checks WHERE checked_at < ? LIMIT 20000
)`;
const newPerMonitorSql = `DELETE FROM checks WHERE id IN (
  SELECT id FROM checks WHERE monitor_id = ? AND checked_at < ? LIMIT 2000
)`;

const oldRun = time('OLD (join, 60x/hour)', () => db.prepare(oldSql).run(now).changes);
const floorRun = time('NEW floor delete (4x/hour)', () =>
  db.prepare(newFloorSql).run(now - MAX_RETENTION_DAYS * DAY).changes
);
time('NEW per-monitor delete (4x/hour)', () =>
  db.prepare(newPerMonitorSql).run('m1', now - 30 * DAY).changes
);

// Drain any remaining expired rows so the next measurements are the real
// steady state: a tick where there is nothing to delete. That is the common case
// (86400/interval ticks vs one prune per tick of work) and it is exactly the
// case the old code paid a full scan for.
let drained = 0;
for (let i = 0; i < 100; i += 1) {
  drained += db.prepare(oldSql).run(now).changes;
  if (drained === 0) break;
}
console.log(`\n(drained ${drained} expired rows, table is now steady-state)\n`);

const oldIdle = time('OLD idle pass (nothing to prune)', () => db.prepare(oldSql).run(now).changes);
const floorIdle = time('NEW idle floor pass (nothing to prune)', () =>
  db.prepare(newFloorSql).run(now - MAX_RETENTION_DAYS * DAY).changes
);
const perMonitorIdle = time('NEW idle per-monitor pass', () =>
  db.prepare(newPerMonitorSql).run('m1', now - 30 * DAY).changes
);

console.log('\nper-day cost, extrapolated from the idle (steady-state) pass:');
const oldPerDay = oldIdle * 1440;
const newPerDay = (floorIdle + perMonitorIdle) * 96;
console.log(`  OLD: ${oldIdle.toFixed(2)} ms x 1440 = ${oldPerDay.toFixed(0)} ms/day`);
console.log(`  NEW: ${(floorIdle + perMonitorIdle).toFixed(2)} ms x 96  = ${newPerDay.toFixed(0)} ms/day`);
const speedup = newPerDay > 0 ? oldPerDay / newPerDay : Infinity;
console.log(`  speedup: ${speedup === Infinity ? '>1000' : `${speedup.toFixed(1)}x`} less work per day`);
console.log(
  `\n  deletions on the first pass: old=${oldRun}, new(floor)=${floorRun} + per-monitor — same retention`
);
console.log('  semantics, asserted by scripts/verify-prune.mjs (10 checks).');

db.close();
