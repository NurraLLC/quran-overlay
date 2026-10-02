// Read-only operating-cost report. No grants, expenses, payments or audio are created.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCALE = 1_000_000_000_000n;
const dollars = (n) => `${n / SCALE}.${String(n % SCALE).padStart(12, '0')}`.replace(/0+$/, '').replace(/\.$/, '');
const numeric = (n, signed = false) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6 && (signed || n >= 0) ? n : null;

export async function readProviderCosts({ start, end, sonioxKey, openrouterKey, fetchImpl = fetch, maxPages = 3 }) {
  const from = Date.parse(start), to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * 86_400_000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) throw Error('Use a valid window of at most 31 days');
  const call = async (url, key) => {
    if (!key) return { status: 'not_configured' };
    try {
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { status: r.status }; // Never expose an error body or credentials.
      return { status: r.status, body: await r.json() };
    } catch { return { status: 'unavailable' }; }
  };
  const url = new URL('https://api.soniox.com/v1/usage-logs');
  url.searchParams.set('start_time', new Date(from).toISOString());
  url.searchParams.set('end_time', new Date(to).toISOString());
  url.searchParams.set('limit', '1000');
  let pages = 0, checked = 0, records = 0, cost = 0n, audioMs = 0, complete = false, status;
  const seen = new Set(), cursors = new Set();
  do {
    const r = await call(url, sonioxKey); status = r.status;
    if (!r.body) break;
    const rows = r.body.usage_logs;
    if (!Array.isArray(rows) || rows.length > 1000) { status = 'invalid_response'; break; }
    pages++; checked += rows.length;
    let valid = true;
    for (const row of rows) {
      if (!row || typeof row.client_reference_id !== 'string' || !row.client_reference_id.startsWith('quran-reader:')) continue;
      if (typeof row.uuid !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.uuid) || typeof row.cost_usd !== 'string' || !/^\d{1,6}(\.\d{1,12})?$/.test(row.cost_usd)) { valid = false; break; }
      const uuid = row.uuid.toLowerCase();
      if (seen.has(uuid)) continue;
      const [whole, fraction = ''] = row.cost_usd.split('.');
      const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
      if (amount > 1000n * SCALE || !Number.isSafeInteger(row.input_audio_duration_ms) || row.input_audio_duration_ms < 0) { valid = false; break; }
      seen.add(uuid); records++; cost += amount; audioMs += row.input_audio_duration_ms;
    }
    if (!valid) { status = 'invalid_response'; break; }
    const cursor = r.body.next_page_cursor;
    if (cursor === null) { complete = true; break; }
    if (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || cursors.has(cursor)) { status = 'invalid_response'; break; }
    cursors.add(cursor); url.searchParams.set('cursor', cursor);
  } while (pages < maxPages);
  const or = await call('https://openrouter.ai/api/v1/key', openrouterKey);
  const data = or.body?.data;
  return {
    window: { start: new Date(from).toISOString(), end: new Date(to).toISOString() },
    soniox: { status, completeLogScan: complete, pages, projectRecordsChecked: checked, quranReaderRecords: records,
      completedRequestCostUsd: complete ? dollars(cost) : null, reportedAudioSeconds: complete ? audioMs / 1000 : null },
    openrouter: { status: or.status === 200 && numeric(data?.usage) === null ? 'invalid_response' : or.status, keyUsageUsd: numeric(data?.usage), monthUsageUsd: numeric(data?.usage_monthly),
      spendingLimitUsd: numeric(data?.limit), limitRemainingUsd: numeric(data?.limit_remaining, true),
      attribution: 'Configured key totals; confirm that this key is used only for Quran Reader' },
    reconciliation: 'Report only. Completed Soniox requests and key totals are not a reconciled invoice. No ledger entries were changed.',
  };
}

if (!process.argv[1] || import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const end = new Date().toISOString();
  const start = process.argv[2] || process.env.QO_BUDGET_REPORT_START || new Date(Date.now() - 7 * 86_400_000).toISOString();
  let ledger = { status: 'unavailable' };
  let db;
  try {
    db = new DatabaseSync(path.join(process.env.QO_STATE_DIR || path.join(process.cwd(), 'data', 'state'), 'credits.db'), { readOnly: true });
    const expenses = db.prepare('SELECT category, SUM(usd_micros) AS micros, COUNT(*) AS receipts FROM pool_costs GROUP BY category').all();
    const { seconds } = db.prepare('SELECT COALESCE(SUM(pool_seconds),0) AS seconds FROM holds').get();
    ledger = { status: 'ok', listeningSeconds: seconds, recordedExpenses: expenses.map((e) => ({ category: ['hosting', 'payment_fees', 'ai', 'other'].includes(e.category) ? e.category : 'unknown', usd: Number(e.micros) / 1e6, receipts: e.receipts })) };
  } catch { /* Missing or inaccessible ledger is unknown, never a zero balance. */ }
  finally { db?.close(); }
  const providers = await readProviderCosts({ start, end, sonioxKey: process.env.SONIOX_API_KEY, openrouterKey: process.env.OPENROUTER_API_KEY });
  console.log(JSON.stringify({ ledger, ...providers }, null, 2));
}
