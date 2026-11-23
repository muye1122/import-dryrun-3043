# Import Dry-Run Framework（导入框架 · 预演模式）

可运行交付：对已解析的批次按 `map_row → clean → validate → natural_key → upsert` 严格顺序执行，**整个过程包在单个数据库事务里，结束强制 ROLLBACK**，不在任何业务表留下写入；结果只写入 `import_row(action, cleaned_payload, target_id)` 与 `import_issue`。更新型行生成字段级 diff（字段名、旧值、新值，只列实际变化字段）；同批次自然键重复从第二行起标记 `DUPLICATE_IN_FILE` 并注明首次行号；预演结束把 create/update/unchanged/error/warning 聚合写入 `import_batch`，状态置为 `dry_run_ready`（无阻塞问题）或 `dry_run_failed`（有阻塞问题）；指纹 `SHA-256(file_sha256 + mapper_version + normalized JSON of mapping_override)` 作为正式导入门禁，任一输入变化都必须重跑预演。所有数据均为**虚构合成数据**，无真实个人信息。

源码仓库：https://github.com/muye1122/import-dryrun-3043

## 技术栈（与同系列任务一致，均为 MIT / Apache-2.0 / BSD 许可）
- Node 22 + Express 4；核心引擎在 `mock-server/dryrun.js`，用 undo-log 模拟单个数据库事务与强制回滚，原子可逆
- React 18 + Vite 6（预演 / 结果 / 问题 / 指纹门禁演示界面）
- Playwright 1.65，复用系统 Edge（`channel: 'msedge'`，不下载 Chromium）
- 核心逻辑单测使用 Node 22 内置 `node --test`（零额外依赖，等价于原需求的 pytest 角色）
- 内存数据层，不装 PostgreSQL、不装新软件；Dockerfile 用 `node:22-alpine`

## 一键启动
```bash
# A. Docker（验收用）
docker compose up --build
#   演示界面 http://localhost:4173   Mock API http://localhost:3001/api/v1/health

# B. 本机开发
npm install
npm run dev:all            # mock:3001 + Vite:5173，打开 http://localhost:5173

# C. 本机生产预览（模拟容器）
npm install && npm run build && node server.js
#   http://localhost:4173，/api 自动代理到 3001

# D. 测试
npm run test:unit          # 9 项核心单测（零写入 / diff / 重复 / 指纹 / 聚合 / 门禁）
npm test                   # 10 项 Playwright（系统 Edge，单 worker）
npm run perf               # 5 万行虚构文件预演计时
```

## 核心设计

### 1. 单事务 + 强制回滚（零业务写入）
`Transaction` 对所有业务表（`customer` / `employee`）的写入记录 undo log：`insert` 记索引、`patch` 记旧值。`runDryRun()` 在**同一个事务实例**中完成全部行的 upsert，最后调用一次 `rollback()` 逆序撤销所有业务写入；`import_row` / `import_issue` 则通过 `stage()` 暂存，在回滚之后刷入，成为预演报告。报告中的 `transaction.revertedBusinessWrites` 与 `zeroWrites` 是可验收证据。

真实 PostgreSQL 16 中的等价写法（替换点）：
```sql
BEGIN;
  -- 所有 upsert 在此事务内执行
ROLLBACK TO SAVEPOINT dryrun;   -- 或 ROLLBACK
-- 再以独立已提交事务写入 import_row / import_issue
COMMIT;
```
`MemoryDb` + `Transaction` 即为真实 DB 事务的**唯一替换点**。

### 2. 字段级 diff
对命中自然键且已存在的行，用 `diffFields()` 逐字段比较规范字段；`old_value !== new_value` 才进入 diff。diff 形如 `[{field:'city', old_value:'示例市C', new_value:'示例市B'}]`。完全相同则 `action='unchanged'`，diff 为空数组且不产生事务写入。

### 3. 文件内自然键重复
批次内维护 `firstSeen: Map<natural_key, first_line>`。同一自然键第二次出现起，该行标记 `action='error'`，并写入 `import_issue`：`code=DUPLICATE_IN_FILE`，`message` 含首次行号，例如 `natural key "13800138000" first appeared at line 1; this row at line 4 is a duplicate`。

### 4. 聚合与状态
`counts = {create, update, unchanged, error, warning}`。`error > 0` → `dry_run_failed`（阻塞，正式导入被拒）；否则 → `dry_run_ready`。`warning` 与非零 error 正交，记录有警告的行数（如手机号分隔符被规范化）。

### 5. 指纹与正式导入门禁
```js
dry_run_fingerprint = SHA256(
  file_sha256 + '\n' + mapper_version + '\n' + stableStringify(mapping_override)
)
```
`stableStringify` 递归排序对象键，因此 override 键顺序不影响指纹；file_sha256 / mapper_version / override 任一变化都会改变指纹。`POST /api/v1/import/batches/:id/commit` 先用当前参数重算指纹并与批次记录比对，不一致返回 `409 FINGERPRINT_MISMATCH`；一致且状态为 `dry_run_ready` 才执行真实 upsert（此时事务 `commit()`，业务表真正写入）。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查、业务表 / 暂存表名、批次数 |
| GET | `/api/v1/meta` | 流水线阶段、指纹公式、默认映射与演示边界 |
| POST | `/api/v1/dry-run` | 运行预演（body 可传 rows / file_sha256 / mapper_version / mapping_override / seed_customers） |
| GET | `/api/v1/import/batches` | 批次列表（状态 / 计数 / 指纹 / 事务证据） |
| GET | `/api/v1/import/batches/:id` | 批次详情 + import_row + import_issue |
| POST | `/api/v1/import/batches/:id/commit` | 正式导入（指纹门禁 + 状态门禁） |
| POST | `/api/v1/fingerprint` | 纯函数：给定参数计算指纹与规范化 override |
| POST | `/api/v1/fingerprint/check` | 纯函数：当前参数与批次指纹比对 |
| GET | `/api/v1/tables/counts` | 各表行数（零写入断言用） |
| POST | `/api/v1/demo/reset` | 恢复演示种子（虚构客户 2 行） |
| POST | `/api/v1/demo/ready-dry-run` | 无阻塞问题的预演（用于演示成功导入） |
| POST | `/api/v1/_test/*` | 验收测试钩子；生产镜像 `NODE_ENV=production` 时返回 404 |

## 验收标准对照
| # | 标准 | 自动化测试 |
|---|---|---|
| 1 | 预演前后所有业务表行数完全一致 | `zero writes: all business table counts identical before/after...` + `dry-run leaves every business table count unchanged...` |
| 2 | 更新行 diff 只含实际变化字段 | `field-level diff lists only changed fields` + `update row diff lists only the changed field (city)` |
| 3 | 文件内自然键重复第二行标 `DUPLICATE_IN_FILE` 并注明首次行号 | `DUPLICATE_IN_FILE marks the second row and names the first line` + `second occurrence...` |
| 4 | 修改 override 后指纹变化、正式导入被拒 | `fingerprint gate: override change rejects import...` + `mapping_override change rejects formal import...` |
| 5 | README 含 5 万行虚构预演耗时，≤3 分钟 | `README documents the 50k-row dry-run timing within 3 minutes` |

## 50,000 行虚构文件预演计时（本地实测）
命令：`npm run perf`（`tests/perf.js`，纯虚构数据：5,000 行命中已有客户走更新路径，45,000 行走新建路径）。

```
=== 50,000-row dry-run performance record ===
rows:              50000
pre-existing:      5000
elapsed_ms:        165.36
elapsed_seconds:   0.165
limit_ms:          180000
within_limit:      true
status:            dry_run_ready
counts:            {"create":45000,"update":5000,"unchanged":0,"error":0,"warning":0}
rolled_back:       true
reverted_writes:   50000
business_before:   {"customer":5000,"employee":0}
business_after:    {"customer":5000,"employee":0}
zero_writes:       true
import_row_written: 50000
PASS: 50,000-row dry-run finished within 3 minutes with zero business writes.
```

结论：50,000 行虚构文件预演耗时 **165.36 ms**，远低于 3 分钟（180,000 ms）上限；预演后业务表行数不变，50,000 次业务写入全部被回滚。计时为本机 Node 22 + 内存数据层实测，不代表真实 PostgreSQL 16 网络 / 磁盘 IO 下的数值；真实 DB 性能需在买方环境以相同脚本替换数据层后复测。

## 数据来源与契约
**Data sources**：仅来自任务页与同系列共享契约；所有姓名、手机号、城市、站点、状态均为虚构占位，无外部数据集、无真实个人信息、无境外 LLM 调用。

## 诚实边界（demo 限制）
- **内存数据层模拟 PostgreSQL 16，不是真实数据库**；服务重启回到种子状态，无持久化。`Transaction` 是真实 DB 事务的替换点，真实环境按上文 SQL 模板接入。
- 50,000 行计时来自内存数据层，仅证明流水线算法复杂度与单事务回滚开销可控；真实 PostgreSQL 16 的耗时需在买方环境复测。
- 预演把结果写入 `import_row` / `import_issue` 的行为，在真实 DB 中通过 savepoint 回滚 + 独立已提交事务写暂存表实现；本 demo 用 undo-log 后刷暂存表达成同样语义。
- 测试钩子 `POST /api/v1/_test/*` 仅供验收；`NODE_ENV=production`（Docker 镜像默认）时返回 404。
- 未实现：真实数据库、认证/权限、真实文件解析（输入为已解析的行数组）、真实导入调度。
