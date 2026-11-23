/**
 * Import dry-run framework - core engine.
 *
 * Pipeline (strict order, one transaction, forced ROLLBACK):
 *   map_row -> clean -> validate -> natural_key -> upsert
 *
 * Guarantees:
 *  - business tables have ZERO net writes after a dry-run (forced rollback);
 *  - only import_row / import_issue (staging tables) survive the rollback;
 *  - update rows carry a field-level diff containing only actually changed fields;
 *  - repeated natural keys inside one file are flagged from the 2nd occurrence on
 *    with code DUPLICATE_IN_FILE and the first line number in the message;
 *  - fingerprint = SHA256(file_sha256 + mapper_version + normalized JSON of mapping_override);
 *  - formal import is rejected unless the current fingerprint matches the one
 *    recorded at dry-run time.
 *
 * IMPORTANT: all records are synthetic. No real personal information.
 * The in-memory data layer is a demo substitute for PostgreSQL 16; the
 * Transaction class is the single swap point for a real DB transaction.
 */
import crypto from 'node:crypto';

export const BUSINESS_TABLES = ['customer', 'employee'];
export const STAGING_TABLES = ['import_batch', 'import_row', 'import_issue'];

/** Canonical target fields after mapping. */
export const CANONICAL_FIELDS = ['name', 'phone', 'city', 'station', 'status'];

/** Default source-column -> canonical-field mapping; override is merged on top. */
export const DEFAULT_MAPPING = Object.freeze({
  '姓名': 'name', '名字': 'name', 'name': 'name',
  '手机号': 'phone', '手机': 'phone', '联系电话': 'phone', 'phone': 'phone',
  '城市': 'city', 'city': 'city',
  '站点': 'station', '站点编号': 'station', 'station': 'station',
  '状态': 'status', 'status': 'status',
});

let seq = 0;
const nextId = (prefix) => `${prefix}_${(++seq).toString(36).padStart(6, '0')}`;

// ---------------------------------------------------------------------------
// 1. Fingerprint  (stable, order-independent JSON normalization)
// ---------------------------------------------------------------------------

/** Canonical JSON: object keys sorted recursively, no insignificant whitespace. */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * dry_run_fingerprint = SHA-256(file_sha256 + mapper_version + normalized mapping_override).
 * A single '\n' separator keeps the three parts unambiguous.
 */
export function computeFingerprint({ file_sha256, mapper_version, mapping_override = {} } = {}) {
  const material = [
    String(file_sha256 ?? ''),
    String(mapper_version ?? ''),
    stableStringify(mapping_override ?? {}),
  ].join('\n');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Gate used by formal import. Returns { ok, code, message, expected, actual }. */
export function checkFingerprint(batch, current) {
  const expected = computeFingerprint(current);
  const actual = batch?.dry_run_fingerprint;
  if (expected !== actual) {
    return {
      ok: false,
      code: 'FINGERPRINT_MISMATCH',
      message: 'file_sha256, mapper_version or mapping_override changed since the dry-run; re-run dry-run before importing',
      expected,
      actual: actual ?? null,
    };
  }
  return { ok: true, code: 'OK', message: 'fingerprint matches', expected, actual };
}

// ---------------------------------------------------------------------------
// 2. In-memory data layer  (swap point: replace with real PostgreSQL tables)
// ---------------------------------------------------------------------------

export class MemoryDb {
  constructor() {
    this.reset();
  }

  reset() {
    this.tables = {
      customer: [],
      employee: [],
      import_batch: [],
      import_row: [],
      import_issue: [],
    };
    this.sources = new Map(); // batchId -> immutable dry-run input, used by formal import
  }

  table(name) {
    if (!Object.prototype.hasOwnProperty.call(this.tables, name)) {
      throw new Error(`unknown table: ${name}`);
    }
    return this.tables[name];
  }

  counts() {
    return Object.fromEntries(Object.entries(this.tables).map(([k, v]) => [k, v.length]));
  }

  businessCounts() {
    return Object.fromEntries(BUSINESS_TABLES.map((t) => [t, this.tables[t].length]));
  }

  seedCustomer(fields, id) {
    const row = { id: id || nextId('cust') };
    for (const f of CANONICAL_FIELDS) row[f] = String(fields?.[f] ?? '');
    this.tables.customer.push(row);
    return row;
  }
}

// ---------------------------------------------------------------------------
// 3. Transaction with undo log - business writes are reverted, staging survives
// ---------------------------------------------------------------------------

/**
 * In PostgreSQL this maps to:
 *   BEGIN; ...upserts...; ROLLBACK TO SAVEPOINT dryrun; INSERT staging tables; COMMIT;
 * Here an undo log reverts exactly the business mutations, then staged staging
 * rows are flushed so they remain as the dry-run report.
 */
export class Transaction {
  constructor(db) {
    this.db = db;
    this.undo = [];
    this.staged = new Map();
    this.closed = false;
  }

  _assertOpen() {
    if (this.closed) throw new Error('transaction is already closed');
  }

  insertBusiness(table, row) {
    this._assertOpen();
    if (BUSINESS_TABLES.includes(table)) {
      const t = this.db.table(table);
      const index = t.push(row) - 1;
      this.undo.push({ op: 'insert', table, index });
      return index;
    }
    throw new Error(`${table} is not a writable business table`);
  }

  patchBusiness(table, index, patch) {
    this._assertOpen();
    const t = this.db.table(table);
    const before = {};
    for (const k of Object.keys(patch)) before[k] = t[index][k];
    Object.assign(t[index], patch);
    this.undo.push({ op: 'patch', table, index, before });
  }

  /** Stage rows for tables that must survive the rollback. */
  stage(table, row) {
    this._assertOpen();
    if (!STAGING_TABLES.includes(table)) throw new Error(`${table} is not a staging table`);
    if (!this.staged.has(table)) this.staged.set(table, []);
    this.staged.get(table).push(row);
  }

  _flushStaged() {
    for (const [table, rows] of this.staged) {
      const t = this.db.table(table);
      for (const r of rows) t.push(r);
    }
    this.staged.clear();
  }

  rollback() {
    this._assertOpen();
    let reverted = 0;
    for (let i = this.undo.length - 1; i >= 0; i -= 1) {
      const u = this.undo[i];
      const t = this.db.table(u.table);
      if (u.op === 'insert') {
        t.splice(u.index, 1);
        reverted += 1;
      } else if (u.op === 'patch') {
        Object.assign(t[u.index], u.before);
        reverted += 1;
      }
    }
    this.undo = [];
    const stagedCounts = {};
    for (const [table, rows] of this.staged) stagedCounts[table] = rows.length;
    this._flushStaged();
    this.closed = true;
    return { rolledBack: true, revertedBusinessWrites: reverted, staged: stagedCounts };
  }

  commit() {
    this._assertOpen();
    const reverted = this.undo.length; // writes are kept; nothing to revert
    this.undo = [];
    const stagedCounts = {};
    for (const [table, rows] of this.staged) stagedCounts[table] = rows.length;
    this._flushStaged();
    this.closed = true;
    return { rolledBack: false, appliedBusinessWrites: reverted, staged: stagedCounts };
  }
}

// ---------------------------------------------------------------------------
// 4. Pure pipeline steps  (each independently unit-testable)
// ---------------------------------------------------------------------------

/** map_row: source columns -> canonical fields. Override wins over defaults. */
export function mapRow(raw, override = {}) {
  const merged = { ...DEFAULT_MAPPING, ...(override || {}) };
  const out = {};
  for (const [src, val] of Object.entries(raw || {})) {
    const target = merged[src];
    if (!target || !CANONICAL_FIELDS.includes(target)) continue;
    if (out[target] !== undefined) continue; // first source wins on collision
    out[target] = val;
  }
  return out;
}

/** clean: trim, full-width -> half-width, collapse phone separators. */
export function cleanRow(mapped) {
  const fields = {};
  const warnings = [];
  const warn = (field, code, message) => warnings.push({ field, code, message, severity: 'warning' });

  for (const field of CANONICAL_FIELDS) {
    const raw = mapped[field];
    if (raw === undefined || raw === null) {
      fields[field] = '';
      continue;
    }
    let s = String(raw);
    const trimmed = s.trim();
    if (trimmed !== s) warn(field, 'FIELD_TRIMMED', `${field} had surrounding whitespace that was trimmed`);
    s = trimmed;

    const half = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
    if (half !== s) warn(field, 'CHARS_NORMALIZED', `${field} had full-width characters that were normalized`);
    s = half;

    if (field === 'phone') {
      const digits = s.replace(/[\s\-()（）]/g, '');
      if (digits !== s) warn(field, 'PHONE_NORMALIZED', 'phone separators/spaces were removed');
      s = digits;
    }
    fields[field] = s;
  }
  return { fields, warnings };
}

/** validate: required fields + phone shape. Errors are blocking. */
export function validateRow(fields, requiredFields = ['name', 'phone']) {
  const errors = [];
  for (const f of requiredFields) {
    if (!String(fields[f] ?? '').trim()) {
      errors.push({ field: f, code: 'MISSING_REQUIRED', message: `required field "${f}" is missing or empty`, severity: 'error' });
    }
  }
  const phone = String(fields.phone ?? '');
  if (phone && !/^1\d{10}$/.test(phone)) {
    errors.push({ field: 'phone', code: 'INVALID_PHONE', message: 'phone must be 11 digits starting with 1', severity: 'error' });
  }
  return errors;
}

/** natural_key: deterministic composite key; null when a component is absent. */
export function naturalKey(fields, keyFields = ['phone']) {
  const parts = keyFields.map((f) => String(fields?.[f] ?? '').trim());
  if (parts.some((p) => !p)) return null;
  return parts.join('|');
}

/** Field-level diff - only fields whose value actually changed. */
export function diffFields(oldRow, newFields, compareFields = CANONICAL_FIELDS) {
  const diff = [];
  for (const f of compareFields) {
    const oldValue = String(oldRow?.[f] ?? '');
    const newValue = String(newFields?.[f] ?? '');
    if (oldValue !== newValue) diff.push({ field: f, old_value: oldValue, new_value: newValue });
  }
  return diff;
}

// ---------------------------------------------------------------------------
// 5. Pipeline execution (one transaction per run)
// ---------------------------------------------------------------------------

function newBatchId() { return nextId('batch'); }

function makeBatch(db, input) {
  const batch = {
    id: input.batchId || newBatchId(),
    file_sha256: String(input.file_sha256 ?? ''),
    mapper_version: String(input.mapper_version ?? ''),
    mapping_override: { ...(input.mapping_override || {}) },
    natural_key_fields: [...(input.natural_key_fields || ['phone'])],
    required_fields: [...(input.required_fields || ['name', 'phone'])],
    dry_run_fingerprint: computeFingerprint(input),
    status: 'parsed',
    counts: { create: 0, update: 0, unchanged: 0, error: 0, warning: 0 },
    created_at: new Date().toISOString(),
    finished_at: null,
    transaction: null,
  };
  db.table('import_batch').push(batch);
  return batch;
}

/**
 * Execute the pipeline.
 * mode='dry_run' -> forced rollback, rows/issues written to staging tables.
 * mode='import'  -> committed, no new staging rows (formal import of a ready batch).
 */
function executePipeline(db, ctx, mode) {
  const tx = new Transaction(db);
  const rows = ctx.rows || [];
  const keyFields = ctx.natural_key_fields || ['phone'];
  const required = ctx.required_fields || ['name', 'phone'];
  const override = ctx.mapping_override || {};

  // Build natural-key index once from the CURRENT business table.
  const index = new Map();
  const customers = db.table('customer');
  for (let i = 0; i < customers.length; i += 1) {
    const k = naturalKey(customers[i], keyFields);
    if (k !== null && !index.has(k)) index.set(k, i);
  }

  const firstSeen = new Map(); // natural key -> first line number
  const counts = { create: 0, update: 0, unchanged: 0, error: 0, warning: 0 };
  const reportRows = [];

  for (const item of rows) {
    const line = Number(item.line) || 0;

    // 1) map_row -> 2) clean -> 3) validate -> 4) natural_key
    const mapped = mapRow(item.raw || {}, override);
    const { fields, warnings } = cleanRow(mapped);
    const errors = validateRow(fields, required);
    const nk = naturalKey(fields, keyFields);

    if (nk === null && !errors.some((e) => e.code === 'MISSING_REQUIRED')) {
      errors.push({
        field: keyFields.join('+'), code: 'NATURAL_KEY_MISSING',
        message: `natural key fields [${keyFields.join(', ')}] are not all present`, severity: 'error',
      });
    }

    // In-file duplicate detection: from the 2nd occurrence onward -> blocking error.
    if (nk !== null) {
      if (firstSeen.has(nk)) {
        errors.push({
          field: keyFields.join('+'),
          code: 'DUPLICATE_IN_FILE',
          message: `natural key "${nk}" first appeared at line ${firstSeen.get(nk)}; this row at line ${line} is a duplicate`,
          severity: 'error',
        });
      } else {
        firstSeen.set(nk, line);
      }
    }

    let action = 'error';
    let targetId = null;
    let diff = [];
    let rowIndex = null;

    if (errors.length === 0) {
      // 5) upsert (inside the single transaction)
      if (index.has(nk)) {
        rowIndex = index.get(nk);
        const existing = customers[rowIndex];
        diff = diffFields(existing, fields);
        if (diff.length === 0) {
          action = 'unchanged';
        } else {
          action = 'update';
          const patch = {};
          for (const d of diff) patch[d.field] = d.new_value;
          tx.patchBusiness('customer', rowIndex, patch);
        }
        targetId = existing.id;
      } else {
        action = 'create';
        const created = { id: nextId('cust') };
        for (const f of CANONICAL_FIELDS) created[f] = fields[f] ?? '';
        rowIndex = tx.insertBusiness('customer', created);
        index.set(nk, rowIndex);
        targetId = created.id;
      }
    }

    if (errors.length > 0) counts.error += 1;
    else if (warnings.length > 0) counts.warning += 1;
    if (errors.length === 0) counts[action] += 1;

    const importRow = {
      batch_id: ctx.batchId,
      line,
      action,
      cleaned_payload: { ...fields },
      target_id: targetId,
      diff,
      natural_key: nk,
    };
    reportRows.push(importRow);

    if (mode === 'dry_run') {
      tx.stage('import_row', importRow);
      for (const e of errors) tx.stage('import_issue', { batch_id: ctx.batchId, line, ...e });
      for (const w of warnings) tx.stage('import_issue', { batch_id: ctx.batchId, line, ...w });
    }
  }

  const outcome = mode === 'dry_run' ? tx.rollback() : tx.commit();
  return { counts, reportRows, outcome };
}

/**
 * Public: run a dry-run. Business tables are guaranteed unchanged afterwards;
 * only staging tables are written.
 */
export function runDryRun(db, spec = {}) {
  const input = {
    batchId: spec.batchId || newBatchId(),
    rows: spec.rows || [],
    file_sha256: spec.file_sha256 ?? '',
    mapper_version: spec.mapper_version ?? '',
    mapping_override: spec.mapping_override || {},
    natural_key_fields: spec.natural_key_fields || ['phone'],
    required_fields: spec.required_fields || ['name', 'phone'],
  };
  const before = db.businessCounts();
  const batch = makeBatch(db, input);
  const ctx = { ...input, batchId: batch.id };
  db.sources.set(batch.id, ctx);

  const { counts, reportRows, outcome } = executePipeline(db, ctx, 'dry_run');
  const after = db.businessCounts();

  batch.counts = counts;
  batch.status = counts.error > 0 ? 'dry_run_failed' : 'dry_run_ready';
  batch.finished_at = new Date().toISOString();
  batch.transaction = { ...outcome, zeroWrites: JSON.stringify(before) === JSON.stringify(after) };

  return {
    batchId: batch.id,
    status: batch.status,
    counts: { ...counts },
    dry_run_fingerprint: batch.dry_run_fingerprint,
    businessCountsBefore: before,
    businessCountsAfter: after,
    zeroWrites: batch.transaction.zeroWrites,
    transaction: batch.transaction,
    rows: reportRows,
  };
}

/**
 * Public: formal import. Rejects unless the CURRENT file/mapper/override
 * reproduce the fingerprint recorded at dry-run time and the batch is ready.
 */
export function commitImport(db, batchId, current = {}) {
  const batch = db.table('import_batch').find((b) => b.id === batchId);
  if (!batch) return { ok: false, code: 'BATCH_NOT_FOUND', message: 'batch not found', status: 404 };

  const fp = checkFingerprint(batch, current);
  if (!fp.ok) return { ok: false, ...fp, status: 409 };

  if (batch.status !== 'dry_run_ready') {
    return {
      ok: false, code: 'DRY_RUN_NOT_READY', status: 409,
      message: 'batch has blocking issues; re-run dry-run and resolve them before import',
    };
  }

  const ctx = db.sources.get(batchId);
  if (!ctx) return { ok: false, code: 'SOURCE_MISSING', message: 'dry-run source is no longer available', status: 409 };

  const { counts, outcome } = executePipeline(db, ctx, 'import');
  batch.status = 'imported';
  batch.imported_at = new Date().toISOString();
  return {
    ok: true, code: 'OK', status: 200, batchId,
    applied: counts.create + counts.update,
    counts: { ...counts },
    transaction: outcome,
    businessCountsAfter: db.businessCounts(),
  };
}

// ---------------------------------------------------------------------------
// 6. Demo fixtures (synthetic only)
// ---------------------------------------------------------------------------

/** Two existing customers used by the demo so create/update/unchanged all appear. */
export const DEMO_SEED_CUSTOMERS = [
  { id: 'cust_demo_001', name: '李四', phone: '13900139000', city: '示例市C', station: 'st-002', status: 'active' },
  { id: 'cust_demo_002', name: '王五', phone: '13700137000', city: '示例市B', station: 'st-003', status: 'active' },
];

/** Five synthetic parsed rows covering every action and issue type. */
export const DEMO_ROWS = [
  { line: 1, raw: { '姓名': '张三', '手机号': '138 0013 8000', '城市': '示例市A', '站点': 'st-001', '状态': 'active' } },
  { line: 2, raw: { '姓名': '李四', '手机号': '13900139000', '城市': '示例市B', '站点': 'st-002', '状态': 'active' } },
  { line: 3, raw: { '姓名': '王五', '手机号': '13700137000', '城市': '示例市B', '站点': 'st-003', '状态': 'active' } },
  { line: 4, raw: { '姓名': '赵六', '手机号': '13800138000', '城市': '示例市D', '站点': 'st-004', '状态': 'active' } },
  { line: 5, raw: { '姓名': '', '手机号': '13600136000', '城市': '示例市E', '站点': 'st-005', '状态': 'active' } },
];

export function resetWithDemo(db) {
  db.reset();
  for (const c of DEMO_SEED_CUSTOMERS) db.seedCustomer(c, c.id);
  return db.businessCounts();
}
