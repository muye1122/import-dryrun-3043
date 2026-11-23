import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Every test starts from the documented demo seed state.
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/v1/demo/reset');
  expect(res.ok()).toBeTruthy();
});

const counts = async (request) => (await (await request.get('/api/v1/tables/counts')).json()).business;

// ---------- Criterion 0: runnable repository + startup contract ----------
test('health, meta and demo UI are available', async ({ request, page }) => {
  const health = await (await request.get('/api/v1/health')).json();
  expect(health.ok).toBe(true);
  expect(health.service).toBe('import-dryrun-framework');
  expect(health.business_tables).toEqual(['customer', 'employee']);

  const meta = await (await request.get('/api/v1/meta')).json();
  expect(meta.pipeline).toEqual(['map_row', 'clean', 'validate', 'natural_key', 'upsert']);
  expect(meta.transaction).toContain('ROLLBACK');

  page.on('pageerror', (e) => { throw e; });
  await page.goto('/');
  await expect(page.getByTestId('panel-run')).toBeVisible();
  await expect(page.getByTestId('panel-perf')).toBeVisible();
});

// ---------- Criterion 1: zero writes to every business table ----------
test('dry-run leaves every business table count unchanged and writes only staging tables', async ({ request }) => {
  const before = await counts(request);
  const res = await request.post('/api/v1/dry-run', { data: {} });
  expect(res.ok()).toBeTruthy();
  const report = await res.json();
  const after = await counts(request);

  expect(after).toEqual(before);
  expect(report.zeroWrites).toBe(true);
  expect(report.transaction.rolledBack).toBe(true);
  expect(report.transaction.revertedBusinessWrites).toBeGreaterThan(0);

  const detail = await (await request.get(`/api/v1/import/batches/${report.batchId}`)).json();
  expect(detail.import_row.length).toBe(report.total_rows);
  expect(detail.import_issue.length).toBeGreaterThan(0);
  expect(report.status).toBe('dry_run_failed');
  expect(report.counts).toEqual({ create: 1, update: 1, unchanged: 1, error: 2, warning: 1 });
});

// ---------- Criterion 2: diff contains only actually changed fields ----------
test('update row diff lists only the changed field (city)', async ({ request }) => {
  const report = await (await request.post('/api/v1/dry-run', { data: {} })).json();
  const updated = report.rows.find((r) => r.action === 'update' && r.line === 2);
  expect(updated).toBeTruthy();
  expect(updated.diff).toEqual([{ field: 'city', old_value: '示例市C', new_value: '示例市B' }]);
  expect(updated.diff).toHaveLength(1);
  const unchanged = report.rows.find((r) => r.line === 3);
  expect(unchanged.action).toBe('unchanged');
  expect(unchanged.diff).toEqual([]);
});

// ---------- Criterion 3: in-file duplicate with first line number ----------
test('second occurrence of a natural key is DUPLICATE_IN_FILE naming the first line', async ({ request }) => {
  const report = await (await request.post('/api/v1/dry-run', { data: {} })).json();
  const dup = report.rows.find((r) => r.line === 4);
  expect(dup.action).toBe('error');
  const detail = await (await request.get(`/api/v1/import/batches/${report.batchId}`)).json();
  const issue = detail.import_issue.find((i) => i.code === 'DUPLICATE_IN_FILE' && i.line === 4);
  expect(issue).toBeTruthy();
  expect(issue.message).toContain('line 1');
});

// ---------- Criterion 4: override change changes fingerprint, import rejected ----------
test('mapping_override change rejects formal import with FINGERPRINT_MISMATCH', async ({ request }) => {
  const report = await (await request.post('/api/v1/demo/ready-dry-run')).json();
  expect(report.status).toBe('dry_run_ready');

  const fpA = report.dry_run_fingerprint;
  const fpB = (await (await request.post('/api/v1/fingerprint', {
    data: { file_sha256: 'demo-file-sha256-v1', mapper_version: 'v1.0.0', mapping_override: { '联系电话': 'phone' } },
  })).json()).fingerprint;
  expect(fpB).not.toBe(fpA);

  const before = await counts(request);
  const rejected = await request.post(`/api/v1/import/batches/${report.batchId}/commit`, {
    data: { file_sha256: 'demo-file-sha256-v1', mapper_version: 'v1.0.0', mapping_override: { '联系电话': 'phone' } },
  });
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).code).toBe('FINGERPRINT_MISMATCH');
  expect(await counts(request)).toEqual(before);
});

test('blocking issues prevent dry_run_ready and block import', async ({ request }) => {
  const report = await (await request.post('/api/v1/dry-run', { data: {} })).json();
  expect(report.status).toBe('dry_run_failed');
  const rejected = await request.post(`/api/v1/import/batches/${report.batchId}/commit`, { data: {} });
  expect((await rejected.json()).code).toBe('DRY_RUN_NOT_READY');
});

test('consistent fingerprint allows formal import to actually write business rows', async ({ request }) => {
  const report = await (await request.post('/api/v1/demo/ready-dry-run')).json();
  const before = await counts(request);
  const res = await request.post(`/api/v1/import/batches/${report.batchId}/commit`, { data: {} });
  expect(res.ok()).toBeTruthy();
  const result = await res.json();
  // 1 create + 1 update are applied (2 writes); the third row is unchanged.
  // Only the create changes the row count.
  expect(result.applied).toBe(2);
  const after = await counts(request);
  expect(after.customer).toBe(before.customer + 1);
});

// ---------- UI flows ----------
test('UI renders dry-run summary, diff, duplicates and zero-write proof', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('run-dryrun').click();
  await expect(page.getByTestId('dryrun-status')).toContainText('dry_run_failed');
  await expect(page.getByTestId('dryrun-counts')).toContainText('error=2');
  await expect(page.getByTestId('zero-write-proof')).toContainText('业务表零写入');
  await expect(page.getByTestId('row-2')).toBeVisible();
  await expect(page.getByTestId('diff-2')).toContainText('city: 示例市C → 示例市B');
  await expect(page.getByTestId('issue-DUPLICATE_IN_FILE')).toContainText('line 1');
});

test('UI rejects import after mapping_override change', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('run-ready').click();
  await expect(page.getByTestId('dryrun-status')).toContainText('dry_run_ready');
  await page.getByTestId('commit-bad').click();
  await expect(page.getByTestId('commit-result')).toContainText('FINGERPRINT_MISMATCH');
});

// ---------- Criterion 5: README records real 50k timing within limit ----------
test('README documents the 50k-row dry-run timing within 3 minutes', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  expect(readme).toContain('50,000');
  expect(readme).toContain('180,000');
  const m = readme.match(/elapsed_ms:\s*([\d.]+)/);
  expect(m).toBeTruthy();
  expect(Number(m[1])).toBeLessThanOrEqual(180000);
});
