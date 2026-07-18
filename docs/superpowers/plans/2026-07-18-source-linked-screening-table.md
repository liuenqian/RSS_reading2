# 来源内 Excel 式初筛表实施计划

日期：2026-07-18
状态：待执行
设计规格：`docs/superpowers/specs/2026-07-18-source-linked-screening-table-design.md`

## 1. 目标与范围

在每个 PubMed 检索和 RSS 订阅中增加来源内 Excel 式初筛表，支持：

- 卡片阅读与表格初筛切换。
- 每个来源独立保存列、列宽、列顺序、固定列、筛选、排序、行高和滚动状态。
- 标星、已读、标签和笔记状态与现有卡片/详情同步。
- 初筛状态、排除原因和筛选备注按来源隔离。
- 后端完整结果集筛选、排序、分页、全选和批量操作。
- 来源范围 XLSX 导出、字段级三方冲突预览和事务导入。
- 10,000 条文献的窗口化渲染与性能验收。
- 通用 `scope_kind + scope_id` 接口，为后续 `project` 范围预留扩展。

本计划不实现独立初筛项目管理、多来源合并、外部 Excel 实时同步或 Excel 笔记写回。

## 2. 当前实现约束

1. 前端是原生 HTML/CSS/JavaScript，没有组件框架或虚拟列表依赖。
2. 大量页面编排集中在 `src/main.js`；新增纯状态、列模型和窗口化计算应拆入独立模块。
3. RSS `list_entries` 当前固定 `LIMIT 200`，不能作为表格完整结果集。
4. PubMed 当前加载完整数据，但只通过 `pubmedRenderLimit` 控制显示。
5. 标星当前保存在 `localStorage` 的 `starred-ids`，导入事务前必须迁入 SQLite。
6. PubMed 初筛状态存于 `pubmed_search_entries`，RSS/普通文章状态存于全局 `entry_screening_status`。
7. 一篇文章可以有多条按 `profile_id` 区分的阅读笔记；XLSX 只读导出笔记汇总。
8. 期刊指标来自 6 MB 的 `src/journal-metrics.json`，当前由前端加载。
9. `rust_xlsxwriter` 与 `calamine` 已存在，可复用工作簿生成和解析模式。
10. 工作区当前有大量与本功能无关的未提交修改；每个阶段必须显式暂存文件，不得使用 `git add .`。

## 3. 目标模块边界

### 3.1 Rust

- `src-tauri/src/services/screening_scope_service.rs`
  - 通用范围校验、完整结果查询、筛选、排序、分页和选择解析。
- `src-tauri/src/services/screening_state_service.rs`
  - 标星、来源级状态、批量操作和表格配置。
- `src-tauri/src/services/screening_xlsx_service.rs`
  - XLSX 导出、读取、三方比较、预览和事务写入。
- `src-tauri/src/services/journal_metrics_service.rs`
  - 从 bundled JSON 建立只读指标索引，提供与前端一致的期刊键和指标排序值。
- `src-tauri/src/commands/screening_cmd.rs`
  - 暴露表格查询、配置、状态、导出和导入命令。
- `src-tauri/src/models.rs`
  - 通用范围、筛选、排序、分页、选择、XLSX 候选与冲突模型。
- `src-tauri/src/db_migrations.rs`、`src-tauri/src/db.rs`
  - 新表、新列、旧状态回填和新安装 schema。

### 3.2 JavaScript

- `src/screening_table_state.js`
  - 范围键、默认列、配置规范化、查询规格和选择描述。
- `src/screening_table_window.js`
  - 可见窗口计算、稳定行位置与滚动缓冲，不访问数据库或全局 DOM。
- `src/screening_table_view.js`
  - 表格 DOM、表头、行、固定列、列宽、列拖动和事件回调。
- `src/screening_import_state.js`
  - 导入预览分组、字段冲突选择与提交 payload。
- `src/main.js`
  - 来源导航、现有详情、卡片状态与新模块的编排。
- `src/index.html`、`src/styles.css`
  - 视图切换、工具栏、表格容器、列菜单和导入预览样式。

模块名称可以在实施时按现有命名微调，但不得把纯逻辑重新堆回 `main.js`。

## 4. 分阶段实施

### 阶段 0：建立基线与保护并行改动

**目标：** 在业务修改前固定可复现测试基线和文件所有权。

**操作：**

1. 运行并记录：

   ```bash
   git status --short
   node --test tests/*.test.mjs
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

2. 对当前未提交文件按功能归属分组，确认本功能将触及的文件是否已有并行修改。
3. 不回退并行修改；若同一文件正在变化，先读取最新内容再应用小补丁。
4. 新增本功能测试文件，避免修改不相关测试断言来获得绿灯。

**验收：**

- 有明确的基线测试结果。
- 没有暂存或提交其他功能文件。

### 阶段 1：数据库 schema 与来源状态迁移

**目标：** 建立事务化全局标星、RSS 来源状态和来源级表格配置。

**文件：**

- 修改 `src-tauri/src/db_migrations.rs`
- 修改 `src-tauri/src/db.rs`
- 修改 `src-tauri/src/models.rs`

**数据结构：**

1. `entry_user_state`
   - `entry_id` 主键和外键。
   - `is_starred`、`starred_at`、`updated_at`。
2. `feed_entry_screening_status`
   - `feed_id + entry_id` 复合主键。
   - `screening_status`、`exclusion_reason`、`screening_note`、`screened_at`、`updated_at`。
3. `screening_table_preferences`
   - `scope_kind + scope_id` 复合主键。
   - `schema_version`、`config_json`、`updated_at`。
4. `pubmed_search_entries`
   - 补充 `exclusion_reason`、`screening_note`、`updated_at`。

**迁移：**

- 将 schema version 从当前值递增一版。
- 新建表后，从 `entry_feed_memberships` 和 `entry_screening_status` 回填 RSS 来源状态。
- 一篇文章属于多个 feed 时分别回填。
- 使用 `INSERT ... ON CONFLICT DO NOTHING` 保证幂等，不覆盖已存在来源状态。
- 新安装的 `schema_sql()` 同步包含最终结构。

**测试：**

- 在 `db_migrations.rs` 单测中构造：零成员、单 feed、多 feed、已存在新记录。
- 验证旧状态不丢失、重复迁移不覆盖、外键检查为 0。
- 验证新安装 schema 与迁移后 schema 具有相同关键列。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml db_migrations
```

**提交：**

```text
feat: add screening state database schema
```

### 阶段 2：标星入库与旧 localStorage 迁移

**目标：** 让标星成为可事务写入、可跨视图读取的数据库状态。

**文件：**

- 修改 `src-tauri/src/services/entry_service.rs`
- 修改 `src-tauri/src/commands/entry_cmd.rs`
- 修改 `src-tauri/src/lib.rs`
- 新增 `src/starred_state.js`
- 修改 `src/main.js`
- 新增 `tests/starred-state-migration.test.mjs`

**后端接口：**

- `list_starred_entry_ids`
- `set_entry_starred(entry_id, is_starred)`
- `bulk_set_entries_starred(entry_ids, is_starred)`
- `migrate_legacy_starred_ids(entry_ids)`，单事务、幂等、返回迁移与未知数量。

**前端迁移：**

- 启动时读取 `starred-ids`，调用幂等迁移命令。
- 只有成功后写入迁移标记并删除旧 key。
- 迁移前显示状态使用数据库与旧 ID 并集。
- 新的标星操作只写数据库；成功后更新内存和 UI，失败则恢复旧值。
- 卡片、顶部计数、筛选和详情星标统一读取数据库状态。

**测试：**

- Rust：未知 ID、重复 ID、重复迁移、批量事务。
- JavaScript：迁移成功才删除旧 key；迁移失败保留；读并集；保存失败回滚。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml starred
node --test tests/starred-state-migration.test.mjs
```

**提交：**

```text
feat: persist starred literature in database
```

### 阶段 3：统一来源状态服务

**目标：** 用同一接口处理 PubMed 与 RSS 的来源级初筛状态。

**文件：**

- 新增 `src-tauri/src/services/screening_state_service.rs`
- 新增 `src-tauri/src/commands/screening_cmd.rs`
- 修改 `src-tauri/src/services/mod.rs`
- 修改 `src-tauri/src/lib.rs`
- 修改 `src-tauri/src/models.rs`
- 修改 `src/main.js`

**接口：**

- `get_screening_state(scope_kind, scope_id, entry_id)`
- `set_screening_state(...)`
- `bulk_set_screening_state(scope, selection, patch)`
- `validate_scope_membership(...)`

**行为：**

- `pubmed` 适配现有 `pubmed_search_entries`。
- `feed` 适配新 `feed_entry_screening_status`。
- 保留现有命令作为兼容入口，但新表格只调用通用命令。
- 卡片中的 RSS 状态更新改为传入当前 `feed_id`；“全部文章”等非来源视图继续使用旧全局状态。
- `project` 返回明确的“尚未支持”错误，接口枚举保留。

**测试：**

- 同一文章在两个 feed 中状态独立。
- 同一文章在两个 PubMed 检索中状态独立。
- 越权 entry ID 使整个批量操作失败且不部分写入。
- 全局视图兼容行为不变。

**提交：**

```text
refactor: unify source-scoped screening state
```

### 阶段 4：来源级表格配置

**目标：** 建立类型安全、可迁移、按来源隔离的表格配置。

**文件：**

- 新增 `src/screening_table_state.js`
- 新增 `tests/screening-table-state.test.mjs`
- 修改 `src-tauri/src/services/screening_state_service.rs`
- 修改 `src-tauri/src/commands/screening_cmd.rs`
- 修改 `src-tauri/src/models.rs`

**前端纯逻辑：**

- 默认列定义、最小/最大宽度、固定列连续性。
- `normalizeScreeningTableConfig`：忽略未知列、合并新增默认列、限制排序层级。
- `screeningScopeKey`：`pubmed:<id>`、`feed:<id>`、预留 `project:<id>`。
- 查询规格与配置分离，滚动位置不会进入后端筛选 payload。

**后端：**

- `get_screening_table_preferences`
- `save_screening_table_preferences`
- 重新校验 JSON schema version、scope kind、列键、宽度和排序数量。

**旧配置兼容：**

- 当数据库无配置时，从现有 `filter_scope.js` / localStorage 状态生成初始筛选与排序。
- 成功保存后以数据库配置为准；不删除旧 key，直到新表格稳定发布。

**测试：**

- 每个来源配置互不污染。
- 损坏 JSON 回退默认。
- 新列能合并到旧配置。
- 固定列不连续时规范化为左侧连续区域。

**提交：**

```text
feat: persist screening table preferences by source
```

### 阶段 5：期刊指标后端只读索引

**目标：** 让完整结果集的 IF/Q/B/Top 筛选与排序不依赖已加载 DOM。

**文件：**

- 新增 `src-tauri/src/services/journal_metrics_service.rs`
- 修改 `src-tauri/src/services/mod.rs`
- 修改 `src-tauri/src/models.rs`

**实现：**

- 使用 `include_str!("../../../src/journal-metrics.json")` 和 `OnceLock` 延迟解析 6 MB bundled JSON。
- Rust 期刊 key 规范化必须与 `normalizeJournalKey` 一致：trim、lowercase、`& -> and`、删除非 ASCII 字母数字。
- 暴露结构化 IF、Q、B、Top 排序值和显示值。
- 缺失值统一返回 `None`，排序稳定放在末尾。

**风险检查点：**

- 比较 release 二进制体积增量和首次解析耗时。
- 若重复嵌入 6 MB 导致不可接受的体积增长，则改用 Tauri resource 文件加载，但不改变服务接口。

**测试：**

- 与前端 key 规范化共享固定样例。
- IF `<0.1`、N/A、Q/B 分区和 Top 解析。
- 未知期刊返回缺失指标。

**提交：**

```text
feat: add backend journal metrics index
```

### 阶段 6：完整范围查询、分页和选择语义

**目标：** 所有表格操作针对完整来源，而不是 RSS 200 条或当前显示窗口。

**文件：**

- 新增 `src-tauri/src/services/screening_scope_service.rs`
- 修改 `src-tauri/src/commands/screening_cmd.rs`
- 修改 `src-tauri/src/models.rs`
- 修改 `src-tauri/src/services/mod.rs`
- 修改 `src-tauri/src/lib.rs`

**模型：**

- `ScreeningScope { kind, id }`
- `ScreeningFilterSpec`
- `ScreeningSortSpec`，最多 3 项。
- `ScreeningPageRequest { offset, limit, filters, sorts }`
- `ScreeningPage { total, rows, offset }`
- `ScreeningSelection::Explicit { entry_ids }`
- `ScreeningSelection::AllFiltered { filters, excluded_entry_ids }`

**查询流程：**

1. 校验 scope。
2. 从 PubMed 或 feed 成员关系加载完整轻量行投影。
3. 合并译文、全局状态、来源状态、标签/笔记存在性和期刊指标。
4. 在 Rust 结构化数据层应用全部筛选和多级稳定排序。
5. 计算完整总数和行位置后分页。
6. 摘要正文只随当前页返回；详情继续使用现有按文章加载路径。

**选择解析：**

- Explicit 逐项校验范围。
- AllFiltered 重新执行同一筛选规格，再排除指定 ID。
- 批量状态和 XLSX 导出复用该解析函数。

**测试：**

- RSS 300+ 条不再被 200 上限截断。
- PubMed 与 RSS 使用一致筛选语义。
- 指标、多标签、中文/英文关键词、日期和状态组合筛选。
- 三层排序、缺失值末尾和稳定行编号。
- AllFiltered 包含未加载行，排除 ID 生效。
- 10,000 条 fixture 的计数、分页和运行时间基准。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml screening_scope
```

**提交：**

```text
feat: query complete screening scopes
```

### 阶段 7：卡片/表格切换与窗口化表格骨架

**目标：** 在 PubMed 和 RSS 来源中展示稳定的高密度表格，不先加入全部编辑能力。

**文件：**

- 修改 `src/index.html`
- 修改 `src/styles.css`
- 新增 `src/screening_table_window.js`
- 新增 `src/screening_table_view.js`
- 修改 `src/main.js`
- 新增 `tests/screening-table-view.test.mjs`
- 新增 `tests/screening-table-window.test.mjs`

**界面：**

- 在来源列表头增加 `卡片阅读 | 表格初筛` 分段控制。
- 表格使用语义化 table/grid 结构、固定表头和横向滚动。
- 第一版骨架渲染：勾选、标星、编号、状态、标题、中英文摘要、作者、期刊、日期、IF/Q/B/Top、已读、标签和笔记存在性。
- 点击行复用现有 `showDetail(entry)`。
- 单元格控件阻止行点击冒泡。

**窗口化：**

- `screening_table_window.js` 根据 scrollTop、viewportHeight、rowHeight 和 overscan 计算请求窗口。
- 只保留可见行和上下缓冲 spacer。
- 摘要模式使用独立稳定行高，不按内容自动扩张。
- 快速滚动期间丢弃过时请求结果。

**测试：**

- 两种来源都显示切换。
- 切换不清空来源和右侧详情。
- 10,000 条逻辑行只产生窗口内 DOM 行。
- 行号来自后端完整位置。

**提交：**

```text
feat: add windowed screening table view
```

### 阶段 8：列管理、行高和来源级恢复

**目标：** 完成 Excel 式布局控制并按来源保存。

**文件：**

- 修改 `src/screening_table_view.js`
- 修改 `src/screening_table_state.js`
- 修改 `src/main.js`
- 修改 `src/styles.css`
- 扩展 `tests/screening-table-state.test.mjs`
- 扩展 `tests/screening-table-view.test.mjs`

**功能：**

- 列设置菜单使用复选框显示/隐藏。
- 原生拖动手柄调整列顺序。
- 表头分隔线调整宽度，pointerup 后防抖保存。
- 固定列保持左侧连续，计算每列 sticky offset。
- 紧凑/摘要行高切换。
- 恢复默认布局。
- 恢复当前来源配置和滚动位置；切换来源前保存旧来源。

**响应式检查：**

- 窄窗口保留工具栏换行，不遮挡表头。
- 固定列总宽度受上限约束，避免占满视口。
- 长标题、作者和标签不会覆盖后续单元格。

**提交：**

```text
feat: customize screening table columns
```

### 阶段 9：筛选、排序、选择和行内操作

**目标：** 完成应用内初筛闭环。

**文件：**

- 修改 `src/main.js`
- 修改 `src/screening_table_view.js`
- 修改 `src/screening_table_state.js`
- 修改 `src/index.html`
- 修改 `src/styles.css`
- 修改 `src-tauri/src/commands/screening_cmd.rs`
- 修改 `src-tauri/src/services/screening_state_service.rs`
- 新增 `tests/screening-table-actions.test.mjs`

**功能：**

- 组合筛选：关键词、状态、标星、已读、日期、IF、Q、B、Top、标签、排除原因和笔记存在性。
- 最多三层排序与升降序。
- Explicit 与 AllFiltered 选择模式；显示准确选择数量。
- 行内标星、已读、初筛状态和标签。
- 排除原因、筛选备注紧凑编辑。
- 多选批量状态、标签、标星和已读。
- 成功后只刷新受影响行；影响当前筛选/排序字段时重新请求当前窗口。
- 失败时恢复旧值和滚动位置。

**测试：**

- 筛选/排序 payload 与后端模型匹配。
- 行内按钮不触发详情切换。
- 保存失败恢复旧值。
- AllFiltered 批量操作包含未加载行。
- 卡片和表格状态双向同步。

**提交：**

```text
feat: complete screening table actions
```

### 阶段 10：初筛 XLSX 导出

**目标：** 生成可在 Excel 中编辑并可安全导回的来源初筛表。

**文件：**

- 新增 `src-tauri/src/services/screening_xlsx_service.rs`
- 修改 `src-tauri/src/services/mod.rs`
- 修改 `src-tauri/src/commands/screening_cmd.rs`
- 修改 `src-tauri/src/lib.rs`
- 修改 `src-tauri/src/models.rs`

**工作簿：**

- 可见工作表：文献元数据、指标、工作字段、只读笔记汇总。
- 隐藏内部工作表：`CENTO_SCREENING_1`、scope、entry ID、PMID/DOI 校验值、字段级基线。
- 初筛状态和布尔列设置数据验证。
- 笔记按 profile 名称拼接，只读导出，不进入可写候选。
- 工作簿内文本按纯文本写入，防止用户内容被当作公式执行。

**范围：**

- 当前来源全部。
- 当前筛选结果。
- 当前勾选文献。
- 全部调用 `resolve_screening_selection`，不使用当前页 ID 替代完整选择。

**测试：**

- 三种范围无遗漏、无越权。
- 可见列顺序可配置，但内部识别不受影响。
- 基线标签使用稳定 JSON；文本规范化一致。
- 多笔记只读汇总包含名称且不丢条目。
- 公式前缀内容按字符串写入。

**提交：**

```text
feat: export source screening workbooks
```

### 阶段 11：XLSX 预览、三方比较和事务导入

**目标：** 安全导回 Excel 工作字段，不覆盖文献元数据或笔记。

**文件：**

- 修改 `src-tauri/src/services/screening_xlsx_service.rs`
- 修改 `src-tauri/src/commands/screening_cmd.rs`
- 修改 `src-tauri/src/models.rs`
- 新增 `src/screening_import_state.js`
- 修改 `src/main.js`
- 修改 `src/styles.css`
- 新增 `tests/screening-xlsx-workflow.test.mjs`

**解析与校验：**

- 只接受 `.xlsx` 和格式代码 `CENTO_SCREENING_1`。
- 校验 scope、entry ID、PMID/DOI、重复行、枚举和标签格式。
- 忽略标题、摘要、作者、期刊、指标和笔记的修改。

**字段级三方比较：**

- `E = B`：无 Excel 修改。
- `C = B` 且 `E != B`：安全采用 Excel。
- `C = E`：两端一致。
- 其余双方不同修改：字段冲突，默认采用 Cento。

**预览界面：**

- 汇总可更新、无变化、未知、非法和冲突数量。
- 冲突逐字段显示 Cento/Excel 值。
- 支持逐项或同类批量选择采用 Excel，不提供静默全覆盖。

**写入：**

- 提交 payload 只包含预览返回的候选 ID 和每字段策略。
- 后端在事务开始后重新读取当前值并再次三方比较，防止预览后又发生修改。
- 标星、已读、标签和来源状态在一个 SQLite 事务中写入。
- 任一失败整批回滚。
- 提交后增量刷新行、卡片、筛选计数和详情。

**测试：**

- 四种三方比较分支逐字段覆盖。
- 预览后再次修改触发重新冲突，不被旧预览覆盖。
- 阅读笔记列永不写入。
- 元数据修改永不写入。
- 事务中途失败整批回滚。
- 来源不匹配阻止导入。

**提交：**

```text
feat: import source screening workbooks safely
```

### 阶段 12：完整回归、性能与视觉验证

**目标：** 验证业务正确性、万级性能和真实界面质量。

**自动化：**

```bash
node --check src/main.js
node --test tests/*.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

**性能：**

- 10,000 条 fixture 查询总数准确。
- 记录筛选、三层排序和分页耗时。
- 验证 DOM 行数只等于窗口与 overscan。
- 验证摘要模式滚动不出现明显空白或布局跳动。
- 验证 AllFiltered 导出数量等于后端总数减排除数。

**真实应用视觉验证：**

1. 构建应用：

   ```bash
   npx tauri build --bundles app
   ```

2. 使用新构建 `.app` 的完整路径打开，避免同 bundle identifier 的旧实例。
3. 使用 Computer Use 检查：
   - PubMed 与 RSS 的视图切换。
   - 紧凑/摘要行高。
   - 固定列与横向滚动。
   - 列隐藏、拖动和宽度。
   - 窄窗口和常规桌面窗口无重叠。
   - 右侧详情与表格选中行同步。
   - XLSX 导出和导入预览。
4. 对表格区域做截图和可访问性树检查，确认非空、无文字遮挡和控件可访问名称完整。

**迁移验证：**

- 使用数据库副本验证标星和 RSS 状态迁移，不直接在唯一生产数据库上试验。
- 比较迁移前后文章、订阅成员和初筛状态计数。
- 关闭并重启应用，确认配置与状态恢复。

**提交：**

```text
test: verify source screening workflow
```

## 5. 风险与决策点

### 5.1 工作区并行修改

`main.js`、数据库和多个命令文件当前已有并行改动。实施每阶段都必须：

- 编辑前重新读取目标片段。
- 使用 `apply_patch` 小范围修改。
- 显式暂存阶段文件。
- 提交前检查 `git diff --cached --name-only`。

若并行修改改变了同一 API，应适配最新实现，不回退用户改动。

### 5.2 期刊指标索引体积

`include_str!` 会使 Rust 二进制包含约 6 MB 指标数据。阶段 5 必须测量体积和解析耗时；若不可接受，再切换资源文件加载。不要同时维护数据库缓存和内存索引两套来源。

### 5.3 完整结果查询内存

阶段 6 可以先在 Rust 中构造完整轻量行投影，再排序分页。不得把所有完整摘要长期缓存。若 10,000 条基准超过目标，再把文本筛选下推 SQL；接口和语义不变。

### 5.4 窗口化与可变行高

真正的自动高度会破坏简单窗口计算。第一版只允许两个固定行高档位；完整文本在右侧详情显示。不要在第一版加入任意高度测量缓存。

### 5.5 Excel 并发写回

导入预览不是最终锁。提交事务必须重新读取当前状态并再次三方比较，否则预览后修改会被覆盖。

## 6. 交付物

- 数据库 schema 与幂等迁移。
- 数据库标星与来源级 RSS 筛选状态。
- 通用完整范围查询和选择解析。
- 来源级表格配置。
- 窗口化 Excel 式表格及列管理。
- 行内与批量初筛操作。
- 初筛 XLSX 导出、预览和事务导入。
- Rust、JavaScript、迁移、性能和视觉测试。
- 可运行且签名校验通过的 macOS `.app`。

## 7. 立即执行顺序

1. 先完成阶段 0 基线记录。
2. 严格按阶段 1–6 建立数据与查询基础，期间不提前做表格视觉层。
3. 阶段 7 完成最小可用表格后进行第一次真实应用视觉检查。
4. 阶段 8–9 完成应用内初筛闭环。
5. 阶段 10–11 完成 Excel 往返闭环。
6. 阶段 12 完成完整回归、迁移副本验证、性能和发布构建。

