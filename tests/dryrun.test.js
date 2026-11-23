/**
 * Core logic unit tests (Node's built-in test runner; no extra dependency).
 * Covers the five buyer acceptance criteria at the engine level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryDb, runDryRun, commitImport, computeFingerprint, checkFingerprint,
  stableStringify, resetWithDemo, diffFields, naturalKey, cleanRow,
  DEMO_ROWS, DEMO_SEED_CUSTOMERS,
} from '../mock-server/dryrun.js';

const SPEC = {
  file_sha256: 'f1',
  mapper_version: 'v1',
  mapping_override: {},
};

test('fingerprint: stable JSON normalization, 64-hex, changes on any input change', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  const a = { ...SPEC, mapping_override: { b: '2', a: '1' } };
  const reordered = { ...SPEC, mapping_override: { a: '1', b: '2' } };
  assert.equal(computeFingerprint(a), computeFingerprint(reordered));
  assert.match(computeFingerprint(a), /^[0-9a-f]{64}$/);
  assert.notEqual(computeFingerprint(SPEC), computeFingerprint({ ...SPEC, file_sha256: 'f2' }));
  assert.notEqual(computeFingerprint(SPEC), computeFingerprint({ ...SPEC, mapper_version: 'v2' }));
  assert.notEqual(computeFingerprint(SPEC), computeFingerprint({ ...SPEC, mapping_override: { '联系电话': 'phone' } }));
});

test('pure steps: clean / natural_key / diff', () => {
  const { fields, warnings } = cleanRow({ name: '  张三  ', phone: '138 0013 8000' });
  assert.equal(fields.name, '张三');
  assert.equal(fields.phone, '13800138000');
  assert.ok(warnings.some((w) => w.code === 'PHONE_NORMALIZED'));
  assert.equal(naturalKey({ phone: '13800138000' }, ['phone']), '13800138000');
  assert.equal(naturalKey({ phone: '' }, ['phone']), null);
  assert.deepEqual(diffFields(
    { name: '李四', phone: '13900139000', city: '示例市C', station: 'st-002', status: 'active' },
    { name: '李四', phone: '13900139000', city: '示例市B', station: 'st-002', status: 'active' },
  ), [{ field: 'city', old_value: '示例市C', new_value: '示例市B' }]);
});

// Criterion 1: business tables have identical row counts before and after dry-run.
test('zero writes: all business table counts identical before/after, staging populated', () => {
  const db = new MemoryDb();
  resetWithDemo(db);
  const before = db.businessCounts();
  const report = runDryRun(db, { ...SPEC, rows: DEMO_ROWS });
  const after = db.businessCounts();
  assert.deepEqual(after, before);
  assert.equal(report.zeroWrites, true);
  assert.equal(report.transaction.rolledBack, true);
  assert.ok(report.transaction.revertedBusinessWrites > 0);
  assert.equal(db.table('import_batch').length, 1);
  assert.equal(db.table('import_row').length, DEMO_ROWS.length);
  assert.ok(db.table('import_issue').length > 0);
});

// Criterion 2: update diff contains only the actually changed field.
test('field-level diff lists only changed fields', () => {
  const db = new MemoryDb();
  db.seedCustomer(DEMO_SEED_CUSTOMERS[0], DEMO_SEED_CUSTOMERS[0].id);
  const report = runDryRun(db, {
    ...SPEC,
    rows: [{ line: 1, raw: { '姓名': '李四', '手机号': '13900139000', '城市': '示例市B', '站点': 'st-002', '状态': 'active' } }],
  });
  const row = report.rows[0];
  assert.equal(row.action, 'update');
  assert.equal(row.target_id, 'cust_demo_001');
  assert.equal(row.diff.length, 1);
  assert.deepEqual(row.diff, [{ field: 'city', old_value: '示例市C', new_value: '示例市B' }]);
});

// Criterion 3: in-file natural key duplicate flagged from the 2nd occurrence.
test('DUPLICATE_IN_FILE marks the second row and names the first line', () => {
  const db = new MemoryDb();
  const rows = [
    { line: 7, raw: { '姓名': '甲', '手机号': '13800138000', '城市': '示例市A', '站点': 'st-001', '状态': 'active' } },
    { line: 9, raw: { '姓名': '乙', '手机号': '13800138000', '城市': '示例市B', '站点': 'st-002', '状态': 'active' } },
  ];
  const report = runDryRun(db, { ...SPEC, rows });
  assert.equal(report.rows[0].action, 'create');
  assert.equal(report.rows[1].action, 'error');
  const issue = db.table('import_issue').find((i) => i.code === 'DUPLICATE_IN_FILE' && i.line === 9);
  assert.ok(issue, 'DUPLICATE_IN_FILE issue must exist for line 9');
  assert.match(issue.message, /line 7/);
  assert.equal(report.counts.error, 1);
});

// Aggregation + blocking status.
test('aggregated counts and status: parsed -> dry_run_ready / dry_run_failed', () => {
  const db = new MemoryDb();
  resetWithDemo(db);
  const report = runDryRun(db, { ...SPEC, rows: DEMO_ROWS });
  assert.deepEqual(report.counts, { create: 1, update: 1, unchanged: 1, error: 2, warning: 1 });
  assert.equal(report.status, 'dry_run_failed');
  assert.equal(db.table('import_batch')[0].status, 'dry_run_failed');

  const db2 = new MemoryDb();
  const ready = runDryRun(db2, { ...SPEC, rows: DEMO_ROWS.slice(0, 3) });
  assert.equal(ready.status, 'dry_run_ready');
});

test('missing required field is a blocking error', () => {
  const db = new MemoryDb();
  const report = runDryRun(db, {
    ...SPEC,
    rows: [{ line: 1, raw: { '姓名': '  ', '手机号': '13800138000' } }],
  });
  assert.equal(report.status, 'dry_run_failed');
  assert.equal(report.counts.error, 1);
  assert.ok(db.table('import_issue').some((i) => i.code === 'MISSING_REQUIRED' && i.field === 'name'));
});

// Criterion 4: override change alters fingerprint and the formal import is rejected.
test('fingerprint gate: override change rejects import; consistent fingerprint imports', () => {
  const db = new MemoryDb();
  const ready = runDryRun(db, { ...SPEC, rows: DEMO_ROWS.slice(0, 3) });
  assert.equal(ready.status, 'dry_run_ready');

  const mismatch = commitImport(db, ready.batchId, {
    ...SPEC, mapping_override: { '联系电话': 'phone' },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'FINGERPRINT_MISMATCH');
  assert.ok(mismatch.message.includes('re-run dry-run'));
  assert.equal(db.businessCounts().customer, 0, 'rejected import must not write business rows');

  // file_sha256 or mapper_version changes are rejected too.
  assert.equal(commitImport(db, ready.batchId, { ...SPEC, file_sha256: 'f2' }).code, 'FINGERPRINT_MISMATCH');
  assert.equal(commitImport(db, ready.batchId, { ...SPEC, mapper_version: 'v2' }).code, 'FINGERPRINT_MISMATCH');

  const ok = commitImport(db, ready.batchId, SPEC);
  assert.equal(ok.ok, true);
  assert.equal(ok.applied, 3);
  assert.equal(db.businessCounts().customer, 3);
  assert.equal(db.table('import_batch').find((b) => b.id === ready.batchId).status, 'imported');
});

test('checkFingerprint helper exposes expected vs actual', () => {
  const db = new MemoryDb();
  const ready = runDryRun(db, { ...SPEC, rows: DEMO_ROWS.slice(0, 1) });
  const batch = db.table('import_batch')[0];
  assert.equal(checkFingerprint(batch, SPEC).ok, true);
  const bad = checkFingerprint(batch, { ...SPEC, mapper_version: 'v9' });
  assert.equal(bad.ok, false);
  assert.notEqual(bad.expected, bad.actual);
});
