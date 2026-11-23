/**
 * 50,000-row dry-run performance test (real timing, fictional data only).
 * Run: npm run perf
 * Acceptance: dry-run of a 50k-row fictional file must complete within 3 minutes
 * (180,000 ms) on a local machine. No PostgreSQL required here - the in-memory
 * data layer is a stand-in; the timing measures the same pipeline code path.
 */
import { performance } from 'node:perf_hooks';
import { MemoryDb, runDryRun } from '../mock-server/dryrun.js';

const TOTAL = 50000;
const EXISTING = 5000;
const LIMIT_MS = 180000;

const db = new MemoryDb();

// 5,000 pre-existing customers -> exercise the update path with field-level diff.
for (let i = 0; i < EXISTING; i += 1) {
  db.seedCustomer({
    name: `原客户${i}`,
    phone: `139${String(10000000 + i).slice(-8)}`,
    city: '示例市A',
    station: 'st-001',
    status: 'active',
  }, `cust_perf_${i}`);
}

// 50,000 parsed rows: first 5k update, remaining 45k create. All keys unique.
const rows = new Array(TOTAL);
for (let i = 0; i < TOTAL; i += 1) {
  const phone = i < EXISTING
    ? `139${String(10000000 + i).slice(-8)}`
    : `130${String(10000000 + i - EXISTING).slice(-8)}`;
  rows[i] = {
    line: i + 1,
    raw: {
      '姓名': `虚构姓名${i}`,
      '手机号': phone,
      '城市': i < EXISTING ? '示例市B' : '示例市C',
      '站点': 'st-001',
      '状态': 'active',
    },
  };
}

const before = db.businessCounts();
const t0 = performance.now();
const report = runDryRun(db, {
  rows,
  file_sha256: 'perf-fixture-sha256',
  mapper_version: 'v1.0.0',
  mapping_override: {},
});
const elapsed = performance.now() - t0;
const after = db.businessCounts();

const lines = [
  '=== 50,000-row dry-run performance record ===',
  `rows:              ${TOTAL}`,
  `pre-existing:      ${EXISTING}`,
  `elapsed_ms:        ${elapsed.toFixed(2)}`,
  `elapsed_seconds:   ${(elapsed / 1000).toFixed(3)}`,
  `limit_ms:          ${LIMIT_MS}`,
  `within_limit:      ${elapsed <= LIMIT_MS}`,
  `status:            ${report.status}`,
  `counts:            ${JSON.stringify(report.counts)}`,
  `rolled_back:       ${report.transaction.rolledBack}`,
  `reverted_writes:   ${report.transaction.revertedBusinessWrites}`,
  `business_before:   ${JSON.stringify(before)}`,
  `business_after:    ${JSON.stringify(after)}`,
  `zero_writes:       ${report.zeroWrites}`,
  `import_row_written: ${db.table('import_row').length}`,
];

console.log(lines.join('\n'));

if (elapsed > LIMIT_MS) {
  console.error(`FAIL: ${elapsed.toFixed(2)} ms exceeds the ${LIMIT_MS} ms limit`);
  process.exit(1);
}
if (!report.zeroWrites) {
  console.error('FAIL: business tables changed during dry-run');
  process.exit(1);
}
console.log('PASS: 50,000-row dry-run finished within 3 minutes with zero business writes.');
