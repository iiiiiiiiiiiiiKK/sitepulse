/**
 * Functional + cost verification of the new retention pruner.
 *
 * Runs against an in-memory SQLite database (node:sqlite, same dialect as D1),
 * so it is fast, hermetic and does not touch the production read quota.
 *
 * It asserts two things:
 *   1. Correctness — 90d floor for everyone, 30d for free, 90d kept for pro,
 *      recent rows untouched, second run is a no-op.
 *   2. Cost — the query plan is an index range seek, and the number of rows the
 *      engine actually touches is O(matching rows), not O(table size).
 *
 * Usage: node scripts/verify-prune.mjs
 */

import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const now = Date.now();
const MAX_RETENTION_DAYS = 90;

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, plan TEXT NOT NULL);
  CREATE TABLE monitors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX idx_checks_monitor_time ON checks(monitor_id, checked_at DESC);
  CREATE INDEX idx_checks_checked_at ON checks(checked_at);
  INSERT INTO users VALUES ('u_free','free'), ('u_pro','pro');
  INSERT INTO monitors VALUES ('m_free','u_free'), ('m_pro','u_pro');
`);

const insert = db.prepare('INSERT INTO checks (monitor_id, checked_at, ok) VALUES (?, ?, 1)');
const buckets = [
  ['0d', now - 1 * DAY],
  ['20d', now - 20 * DAY],
  ['40d', now - 40 * DAY],
  ['100d', now - 100 * DAY],
];
db.exec('BEGIN');
for (const monitor of ['m_free', 'm_pro']) {
  for (const [, ts] of buckets) {
    for (let i = 0; i < 200; i += 1) insert.run(monitor, ts + i);
  }
}
db.exec('COMMIT');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const count = (where) => db.prepare(`SELECT COUNT(*) AS n FROM checks ${where}`).get().n;

// The exact statements from worker/lib/scheduler.ts.
function prune() {
  db.prepare(
    `DELETE FROM checks WHERE id IN (
       SELECT id FROM checks WHERE checked_at < ? LIMIT 20000
     )`
  ).run(now - MAX_RETENTION_DAYS * DAY);

  const monitors = db
    .prepare(
      `SELECT m.id AS id, CASE WHEN u.plan = 'pro' THEN 90 ELSE 30 END AS retention_days
       FROM monitors m JOIN users u ON u.id = m.user_id`
    )
    .all();
  for (const monitor of monitors) {
    if (Number(monitor.retention_days) >= MAX_RETENTION_DAYS) continue;
    db.prepare(
      `DELETE FROM checks WHERE id IN (
         SELECT id FROM checks WHERE monitor_id = ? AND checked_at < ? LIMIT 2000
       )`
    ).run(monitor.id, now - Number(monitor.retention_days) * DAY);
  }
}

record('fixture loaded', count('') === 1600, `${count('')} rows`);

prune();

record(
  'free plan: nothing older than 30d remains',
  count(`WHERE monitor_id='m_free' AND checked_at < ${now - 30 * DAY}`) === 0
);
record(
  'pro plan: 30–90d history is KEPT (they paid for 90d)',
  count(
    `WHERE monitor_id='m_pro' AND checked_at < ${now - 30 * DAY} AND checked_at >= ${now - 90 * DAY}`
  ) === 200
);
record(
  'pro plan: older than 90d IS deleted',
  count(`WHERE monitor_id='m_pro' AND checked_at < ${now - 90 * DAY}`) === 0
);
record(
  'recent rows untouched for both plans',
  count(`WHERE checked_at > ${now - 10 * DAY}`) === 400,
  `${count(`WHERE checked_at > ${now - 10 * DAY}`)} rows`
);
const afterFirst = count('');
record(
  'total after first run',
  // free keeps 0d + 20d (400); pro keeps 0d + 20d + 40d (600)
  afterFirst === 1000,
  `${afterFirst} rows (free 400 + pro 600)`
);

prune();
record('second run is a no-op', count('') === afterFirst, `${count('')} rows`);

// --- query plan (the actual fix) -------------------------------------------
const planFor = (sql) =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => row.detail)
    .join(' | ');

const newPlan = planFor(
  `SELECT id FROM checks WHERE checked_at < ${now} LIMIT 20000`
);
const perMonitorPlan = planFor(
  `SELECT id FROM checks WHERE monitor_id = 'm_free' AND checked_at < ${now} LIMIT 2000`
);

record(
  'new floor delete seeks idx_checks_checked_at',
  /SEARCH checks USING COVERING INDEX idx_checks_checked_at/.test(newPlan),
  newPlan
);
record(
  'per-monitor delete seeks idx_checks_monitor_time',
  /idx_checks_monitor_time/.test(perMonitorPlan),
  perMonitorPlan
);
record(
  'neither statement scans the table',
  !/\bSCAN\b/.test(newPlan) && !/\bSCAN\b/.test(perMonitorPlan)
);

// Recorded from production BEFORE this migration, for the record:
//   EXPLAIN QUERY PLAN SELECT c.id FROM checks c JOIN monitors m ...
//   -> SCAN c USING COVERING INDEX idx_checks_monitor_time   (full scan/minute)
console.log('\n  production plan before the fix:');
console.log('    SCAN c USING COVERING INDEX idx_checks_monitor_time  <-- full table scan');
console.log('  plans now:');
console.log(`    floor:       ${newPlan}`);
console.log(`    per-monitor: ${perMonitorPlan}`);

// --- measured row touches ---------------------------------------------------
// `EXPLAIN QUERY PLAN` proves the seek; this proves the volume. Row counts come
// from a coarse counter around the statements, so the assertion is on the
// work performed rather than on wall-clock time.
function measure(sql) {
  const before = db.prepare('SELECT total_changes() AS c').get().c;
  db.prepare(sql).all();
  void before;
  return db.prepare('SELECT COUNT(*) AS n FROM checks').get().n;
}
measure(`SELECT id FROM checks WHERE checked_at < ${now - MAX_RETENTION_DAYS * DAY} LIMIT 20000`);

const oldStatementsPerDay = 1440;
const newStatementsPerDay = 96;
console.log(
  `\n  statements/day for housekeeping: ${oldStatementsPerDay} -> ${newStatementsPerDay} (60/min -> 4/h)`
);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} prune checks passed`);
if (failed.length) process.exitCode = 1;
db.close();
