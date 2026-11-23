/**
 * Import dry-run framework - mock API.
 *
 * All data is synthetic. No real personal information.
 * In-memory demo: swap the data layer for PostgreSQL 16 in production.
 */
import express from 'express';
import {
  MemoryDb, runDryRun, commitImport, computeFingerprint, checkFingerprint,
  stableStringify, resetWithDemo, DEMO_ROWS, DEMO_SEED_CUSTOMERS,
  BUSINESS_TABLES, STAGING_TABLES, CANONICAL_FIELDS, DEFAULT_MAPPING,
} from './dryrun.js';

const app = express();
app.use(express.json({ limit: '32mb' }));
const PORT = process.env.PORT || 3001;
const db = new MemoryDb();
resetWithDemo(db);

const testHooksEnabled = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_TEST_HOOKS === '1';
const deny = (res, code, message, status = 400, extra = {}) => res.status(status).json({ code, message, ...extra });
const guardTestHook = (res) => {
  if (testHooksEnabled()) return true;
  deny(res, 'TEST_HOOKS_DISABLED', 'test hooks are disabled in production', 404);
  return false;
};

// ---------------------------------------------------------------------------
// health / meta
// ---------------------------------------------------------------------------
app.get('/api/v1/health', (_req, res) => res.json({
  ok: true,
  service: 'import-dryrun-framework',
  ts: Date.now(),
  business_tables: BUSINESS_TABLES,
  staging_tables: STAGING_TABLES,
  batches: db.table('import_batch').length,
}));

app.get('/api/v1/meta', (_req, res) => res.json({
  pipeline: ['map_row', 'clean', 'validate', 'natural_key', 'upsert'],
  transaction: 'one transaction, forced ROLLBACK; only import_row / import_issue survive',
  fingerprint: 'SHA-256(file_sha256 + "\\n" + mapper_version + "\\n" + stable JSON of mapping_override)',
  canonical_fields: CANONICAL_FIELDS,
  default_mapping: DEFAULT_MAPPING,
  natural_key_default: ['phone'],
  required_default: ['name', 'phone'],
  perf_reference: { rows: 50000, limit_ms: 180000, note: 'measured with node tests/perf.js; see README and 验证记录.md' },
  demo_boundary: 'In-memory data layer simulating PostgreSQL 16; Transaction class is the swap point.',
}));

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------
app.post('/api/v1/dry-run', (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : DEMO_ROWS;
  // Seed optional business rows first (demo convenience for exercising updates).
  if (Array.isArray(body.seed_customers)) {
    for (const c of body.seed_customers) db.seedCustomer(c, c.id);
  }
  const report = runDryRun(db, {
    batchId: body.batchId,
    rows,
    file_sha256: body.file_sha256 ?? 'demo-file-sha256-v1',
    mapper_version: body.mapper_version ?? 'v1.0.0',
    mapping_override: body.mapping_override || {},
    natural_key_fields: body.natural_key_fields || ['phone'],
    required_fields: body.required_fields || ['name', 'phone'],
  });
  res.json({
    ...report,
    rows: report.rows.slice(0, 50),
    total_rows: report.rows.length,
    issues: db.table('import_issue').filter((i) => i.batch_id === report.batchId).slice(0, 50),
  });
});

app.get('/api/v1/import/batches', (_req, res) => res.json({
  batches: db.table('import_batch').map((b) => ({
    id: b.id, status: b.status, counts: b.counts,
    dry_run_fingerprint: b.dry_run_fingerprint,
    file_sha256: b.file_sha256, mapper_version: b.mapper_version,
    mapping_override: b.mapping_override,
    transaction: b.transaction,
  })),
}));

app.get('/api/v1/import/batches/:id', (req, res) => {
  const batch = db.table('import_batch').find((b) => b.id === req.params.id);
  if (!batch) return deny(res, 'BATCH_NOT_FOUND', 'batch not found', 404);
  res.json({
    batch,
    import_row: db.table('import_row').filter((r) => r.batch_id === batch.id),
    import_issue: db.table('import_issue').filter((i) => i.batch_id === batch.id),
  });
});

// ---------------------------------------------------------------------------
// formal import - fingerprint gate
// ---------------------------------------------------------------------------
app.post('/api/v1/import/batches/:id/commit', (req, res) => {
  const body = req.body || {};
  const result = commitImport(db, req.params.id, {
    file_sha256: body.file_sha256 ?? 'demo-file-sha256-v1',
    mapper_version: body.mapper_version ?? 'v1.0.0',
    mapping_override: body.mapping_override || {},
  });
  if (!result.ok) return deny(res, result.code, result.message, result.status || 409, {
    expected: result.expected, actual: result.actual,
  });
  res.json(result);
});

/** Pure fingerprint helper exposed over HTTP for buyer smoke tests. */
app.post('/api/v1/fingerprint', (req, res) => {
  const body = req.body || {};
  res.json({
    fingerprint: computeFingerprint({
      file_sha256: body.file_sha256 ?? '',
      mapper_version: body.mapper_version ?? '',
      mapping_override: body.mapping_override || {},
    }),
    normalized_override: stableStringify(body.mapping_override || {}),
  });
});

app.post('/api/v1/fingerprint/check', (req, res) => {
  const body = req.body || {};
  const batch = db.table('import_batch').find((b) => b.id === body.batchId);
  if (!batch) return deny(res, 'BATCH_NOT_FOUND', 'batch not found', 404);
  res.json(checkFingerprint(batch, {
    file_sha256: body.file_sha256 ?? '',
    mapper_version: body.mapper_version ?? '',
    mapping_override: body.mapping_override || {},
  }));
});

// ---------------------------------------------------------------------------
// table inspection - zero-write assertions
// ---------------------------------------------------------------------------
app.get('/api/v1/tables/counts', (_req, res) => res.json({
  business: db.businessCounts(),
  staging: Object.fromEntries(STAGING_TABLES.map((t) => [t, db.table(t).length])),
  all: db.counts(),
}));

// ---------------------------------------------------------------------------
// demo helpers & test hooks
// ---------------------------------------------------------------------------
app.post('/api/v1/demo/reset', (_req, res) => res.json(resetWithDemo(db)));

app.post('/api/v1/demo/ready-dry-run', (_req, res) => {
  resetWithDemo(db);
  const report = runDryRun(db, {
    rows: DEMO_ROWS.slice(0, 3), // no blocking issues -> dry_run_ready
    file_sha256: 'demo-file-sha256-v1',
    mapper_version: 'v1.0.0',
    mapping_override: {},
  });
  res.json({ ...report, rows: report.rows });
});

app.post('/api/v1/_test/reset', (_req, res) => {
  if (!guardTestHook(res)) return;
  res.json(db.reset() || db.counts());
});

app.post('/api/v1/_test/seed', (req, res) => {
  if (!guardTestHook(res)) return;
  const { table, rows } = req.body || {};
  if (!BUSINESS_TABLES.includes(table)) return deny(res, 'INVALID_TABLE', 'table must be a business table', 400);
  if (!Array.isArray(rows)) return deny(res, 'INVALID_ROWS', 'rows must be an array', 400);
  const added = rows.map((r) => (table === 'customer' ? db.seedCustomer(r, r.id) : (db.table(table).push({ ...r }) - 1)));
  res.json({ table, added: added.length, counts: db.businessCounts() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dryrun-mock] listening on http://0.0.0.0:${PORT}  business=${JSON.stringify(db.businessCounts())}`);
});
