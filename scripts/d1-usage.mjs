/**
 * D1 read-cost reporter.
 *
 * Prints the two numbers that matter for this project's cost model:
 *   1. total rows_read per day (against the 5M/day free-tier limit), and
 *   2. the per-statement attribution, so a regression points at one query
 *      instead of "the database is expensive".
 *
 * Uses Cloudflare's GraphQL analytics API, which is separate from D1's query
 * quota — so this works even while the database itself is throttled.
 *
 * Usage (needs a token with Account Analytics:Read):
 *
 *   PowerShell:
 *     $env:CLOUDFLARE_API_TOKEN='...'; $env:CLOUDFLARE_ACCOUNT_ID='...'
 *     node scripts/d1-usage.mjs [databaseId]
 *
 *   bash:
 *     CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/d1-usage.mjs
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const DB = process.argv[2] || process.env.SITEPULSE_D1_ID || '';

if (!TOKEN || !ACCOUNT) {
  console.error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.');
  process.exit(1);
}

async function gql(query) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body.data.viewer.accounts[0];
}

const sinceDays = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const iso = () => new Date().toISOString();
const dbFilter = DB ? `, databaseId: "${DB}"` : '';

function bar(value, max, width = 28) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

// --- daily totals -----------------------------------------------------------
const daily = await gql(`query {
  viewer { accounts(filter: { accountTag: "${ACCOUNT}" }) {
    d1AnalyticsAdaptiveGroups(limit: 400, filter: { datetime_geq: "${sinceDays(7)}", datetime_leq: "${iso()}"${dbFilter} }) {
      count
      sum { rowsRead rowsWritten }
      dimensions { date }
    }
  } }
}`);

const days = (daily.d1AnalyticsAdaptiveGroups ?? []).sort((a, b) =>
  a.dimensions.date.localeCompare(b.dimensions.date)
);

console.log('date          calls      rows_read    rows_written   vs 5M/day free tier');
for (const day of days) {
  const pct = (day.sum.rowsRead / 5_000_000) * 100;
  console.log(
    `${day.dimensions.date}  ${String(day.count).padStart(6)}  ${String(day.sum.rowsRead).padStart(12)}  ${String(day.sum.rowsWritten).padStart(13)}   ${pct.toFixed(1).padStart(5)}% ${bar(day.sum.rowsRead, 5_000_000)}`
  );
}

// --- per-statement attribution ---------------------------------------------
const recent = await gql(`query {
  viewer { accounts(filter: { accountTag: "${ACCOUNT}" }) {
    d1QueriesAdaptiveGroups(limit: 15, orderBy: [sum_rowsRead_DESC], filter: {
      datetime_geq: "${sinceDays(1)}", datetime_leq: "${iso()}"${dbFilter}
    }) {
      count
      sum { rowsRead }
      dimensions { query }
    }
  } }
}`);

const queries = recent.d1QueriesAdaptiveGroups ?? [];
const top = queries[0]?.sum.rowsRead ?? 0;
const total = queries.reduce((sum, row) => sum + row.sum.rowsRead, 0);

console.log('\nlast 24h, top statements by rows_read:');
for (const row of queries) {
  const label = String(row.dimensions.query).replace(/\s+/g, ' ').slice(0, 66);
  console.log(
    `  ${String(row.sum.rowsRead).padStart(9)}  ${String(row.count).padStart(6)} calls  ` +
      `avg ${String(Math.round(row.sum.rowsRead / row.count)).padStart(6)}  ${bar(row.sum.rowsRead, top, 12)} ${label}`
  );
}

if (top > 0) {
  const share = ((top / total) * 100).toFixed(0);
  console.log(
    `\ntop statement is ${share}% of the top-15 total (${(total / 1_000_000).toFixed(2)}M rows).`
  );
  if (Number(share) > 50) {
    console.log('A single statement over half the volume is worth an EXPLAIN QUERY PLAN.');
  }
}

const latest = days.at(-1);
if (latest) {
  const projected = latest.sum.rowsRead;
  console.log(
    `\nlatest day: ${projected.toLocaleString()} rows_read → ${
      projected > 5_000_000 ? 'OVER' : 'within'
    } the 5M/day free tier.`
  );
}
