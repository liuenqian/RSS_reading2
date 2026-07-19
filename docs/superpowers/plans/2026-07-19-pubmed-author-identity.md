# PubMed 作者身份检索与持续订阅实施计划

日期：2026-07-19
状态：待执行
设计规格：`docs/superpowers/specs/2026-07-19-pubmed-author-identity-design.md`

## 1. 目标与范围

将现有作者检索升级为可审计的两轮身份检索：

- AI 生成 1–3 个完整、标准、可编辑的 PubMed 候选查询。
- 程序解析并校验原始查询，不用固定模板重写 AI 布尔结构。
- 保存每位 PubMed 作者及其对应单位、ORCID 和作者顺序。
- 用户确认 3–5 篇种子后建立作者指纹。
- 根据 confirmed 姓名、目标作者单位和稳定共同作者生成第二轮候选查询。
- 两轮查询在一个逻辑 run 中取 PMID 并集并原子提交。
- 结果按身份组审核，用户判断和稳定身份 UUID 持久化。
- 复杂 AI 作者评估默认关闭，只在用户当次明确勾选后运行。
- 后续更新复用最后批准的查询，并对失效证据安全降级。

本计划不接入新的 ORCID/OpenAlex 服务，不进行无限多轮图谱扩展，不让 AI 自动接受身份判断，也不对全部历史 PubMed 记录一次性联网回填。

## 2. 当前实现与约束

1. 当前 `build_pubmed_author_query` 只返回单个 `PubmedAuthorQueryResult`，AI 响应在 `pubmed_service.rs` 中解析。
2. 当前作者查询安全逻辑用字符串拆分 `OR`，不能验证嵌套布尔路径或 `NOT` 极性。
3. `PubmedArticleRecord` 只有扁平 `authors` 和第一条 `affiliation`；XML 中作者与单位对应关系未保存。
4. 当前数据库 schema version 是 10，但工作区有并行迁移改动；实施每个 schema 阶段前必须重新读取最新版本，使用下一个可用版本。
5. `pubmed_author_identity_states` 只保存 schema v1 任意 JSON；前端按 entry ID 和派生组 key 保存状态。
6. `pubmed_search_runs` 当前每个 run 只有一个隐式查询，`pubmed_search_run_items` 不能记录一个 PMID 命中多个查询分支。
7. 作者指纹和聚类在 `src/author_identity.js` 中执行，现有算法使用文章级第一单位。
8. `assess_pubmed_author_preview` 会直接调用模型并记录费用；前端共享复选框目前在 HTML 和打开弹窗时默认勾选。
9. 前端是原生 HTML/CSS/JavaScript；纯查询状态、证据映射和复杂评估授权不得继续全部堆入 `src/main.js`。
10. 工作区有大量未提交修改。每个阶段只暂存该阶段文件，禁止 `git add .`，禁止回退其他功能改动。

## 3. 目标模块边界

### 3.1 Rust

- `src-tauri/src/services/pubmed_author_query_service.rs`
  - PubMed 作者查询 tokenizer、无损 AST、布尔路径校验、原子证据验证和候选契约。
- `src-tauri/src/services/pubmed_service.rs`
  - AI 查询生成提示词、一次纠错、候选响应解析和费用使用结果。
- `src-tauri/src/services/pubmed_search_service.rs`
  - PubMed XML 作者解析、结构化作者持久化、多查询 run、结果并集和作者评估上下文。
- `src-tauri/src/services/pubmed_author_identity_service.rs`
  - typed v2 身份状态、目标作者节点解析、证据晋升、查询版本状态和后端校验。
- `src-tauri/src/commands/pubmed_cmd.rs`
  - 第一轮/第二轮候选生成和手工查询校验命令。
- `src-tauri/src/commands/pubmed_search_cmd.rs`
  - 身份元数据、身份状态、两轮 run 和复杂 AI 评估命令。
- `src-tauri/src/models.rs`
  - 结构化作者、查询 AST/候选、身份状态和多查询运行模型。
- `src-tauri/src/db.rs`、`src-tauri/src/db_migrations.rs`
  - 作者关联表、多查询 run 表和兼容迁移。

### 3.2 JavaScript

- `src/author_query.js`
  - 候选选择、编辑后契约失效、原子映射 UI 状态和 active/pending 查询状态的纯逻辑。
- `src/author_identity.js`
  - 目标作者节点选择、结构化指纹、确定性证据评分、身份图聚类和稳定决定继承。
- `src/author_search_workflow.js`
  - 一次性复杂 AI opt-in、更新范围差异和评估批次取消的纯状态机。
- `src/main.js`
  - 现有 PubMed 弹窗、抓取、身份审核和新模块的编排。
- `src/index.html`、`src/styles.css`
  - 多候选查询、结构化原子映射、目标作者节点选择、更新确认和身份组展示。

如果实施时现有并行修改已经创建等价模块，应复用最新模块而不是重复建文件。

## 4. 分阶段实施

### 阶段 0：固定基线与保护并行改动

**目标：** 记录当前测试状态，确认本功能涉及文件的并行修改。

**操作：**

1. 运行：

   ```bash
   git status --short
   node --test tests/author-identity.test.mjs tests/pubmed-preview-ai-assessment.test.mjs tests/pubmed-rss-dialog.test.mjs
   cargo test --manifest-path src-tauri/Cargo.toml pubmed_service::tests
   cargo test --manifest-path src-tauri/Cargo.toml pubmed_search_service::tests
   ```

2. 记录已知失败，不通过修改无关断言掩盖基线问题。
3. 每次编辑前重新读取目标文件；现有未提交代码视为用户修改并与其共存。
4. 新增独立测试文件覆盖查询解析和 opt-in 状态，减少对脆弱源码正则测试的依赖。

**验收：** 有明确基线；没有暂存或提交任何现有业务文件。

### 阶段 1：结构化作者 schema 与模型

**目标：** 建立作者、单位和多查询运行的持久化基础。

**文件：**

- 修改 `src-tauri/src/db_migrations.rs`
- 修改 `src-tauri/src/db.rs`
- 修改 `src-tauri/src/models.rs`

**schema：**

1. `pubmed_entry_authors`
   - `id`、`entry_id`、`author_order`
   - `last_name`、`fore_name`、`initials`、`collective_name`、`display_name`、`orcid`
   - 唯一约束 `(entry_id, author_order)`，entry 级联删除。
2. `pubmed_entry_author_affiliations`
   - `id`、`entry_author_id`、`affiliation_order`、`raw_text`
   - 唯一约束 `(entry_author_id, affiliation_order)`，author 级联删除。
3. `pubmed_search_run_queries`
   - `id`、`run_id`、`query_kind`、`query`、`profile_version`、`status`、`result_count`、`error_message`
4. `pubmed_search_run_item_sources`
   - `run_id`、`pmid`、`run_query_id`、`rank`
   - 唯一约束 `(run_query_id, pmid)`。
5. `pubmed_search_runs`
   - 增加 `run_type` 和可空 `profile_version`，旧 run 回填为普通 base run。

**模型：**

- `PubmedAuthorRecord`
- `PubmedAuthorAffiliationRecord`
- `PubmedArticleRecord.structured_authors`，使用 serde default 保持旧 payload 可读。
- run query/source 记录模型。

**迁移要求：**

- 实施前重新读取 schema version，不能假定仍为 10。
- 新安装 `schema_sql()` 和升级迁移生成相同结构。
- 迁移幂等；外键检查为 0；旧作者身份 JSON 和旧 run 不丢失。

**先写失败测试：**

- 从当前版本升级后四张表/列存在。
- 重复迁移不重复数据。
- 删除 entry 级联删除作者与单位。
- 新安装与迁移后 schema 的关键结构一致。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml db_migrations
```

**提交：** `feat: add structured PubMed author schema`

### 阶段 2：解析并持久化作者与单位对应关系

**目标：** 不再把文章第一条单位当成目标作者单位。

**文件：**

- 修改 `src-tauri/src/services/pubmed_search_service.rs`
- 修改 `src-tauri/src/models.rs`
- 新增或修改该服务内 XML fixture 测试

**实现：**

1. 将现有 `parse_authors` 改为返回结构化作者列表，同时派生兼容展示字符串。
2. 只从当前 `Author` 节点下读取 `Identifier Source="ORCID"` 和全部 `AffiliationInfo/Affiliation`。
3. `parse_pubmed_article` 把结构化列表写入 `PubmedArticleRecord`；文章级 affiliation 仅用于兼容展示。
4. 正式抓取保存文章时，在同一事务中重建该 entry 的作者结构。
5. 只有新结构完整解析成功才替换旧结构；失败保留上一份有效数据并把当前记录标为证据不完整。
6. 提供按 search ID 批量读取结构化作者元数据的服务，避免列表查询逐篇 N+1。

**先写失败测试：**

- 目标作者不是第一作者且两位作者单位不同。
- 一个作者有多个单位。
- ORCID、集体作者、缺失 ForeName、缺失单位。
- 重抓同一 PMID 不产生重复作者行。
- 新解析失败不删除旧作者结构。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pubmed_xml
cargo test --manifest-path src-tauri/Cargo.toml structured_author
```

**提交：** `feat: preserve PubMed author affiliation links`

### 阶段 3：PubMed 作者查询 AST 与安全校验

**目标：** 校验 AI 或用户的原始 PubMed 查询，不静默改写。

**文件：**

- 新增 `src-tauri/src/services/pubmed_author_query_service.rs`
- 修改 `src-tauri/src/services/mod.rs`
- 修改 `src-tauri/src/models.rs`

**查询契约：**

- `PubmedAuthorQueryCandidate { query, strategy, reason, expression }`
- `PubmedQueryExpression::{And, Or, Not, Atom}`
- atom 包含 `text/value/field/role/source/evidence_id`。
- `PubmedAuthorQueryValidation` 返回解析树、路径数量、错误位置和未映射原子。

**parser：**

1. 编写小型 tokenizer 和递归下降 parser，支持引号、字段标签、括号、`AND/OR/NOT`。
2. 保留原始 token/span，用于错误定位和不改写提交。
3. 独立解析 raw query，并与 AI expression 比较结构、字段、值和 NOT 极性。
4. 将表达式展开为最多 64 条可满足路径，超过上限返回“请简化查询”。
5. AI 自带日期原子拒绝；日期由应用在选定查询外层精确追加。

**安全规则：**

- 每条正向路径必须包含目标作者姓名。
- 第一轮：完整姓名可独立；首字母作者必须同路径包含用户已知单位英文变体。
- 第一轮不允许共同作者充当约束。
- 第二轮：姓名、单位、共同作者原子必须映射到真实 confirmed evidence ID。
- 第二轮首字母作者必须同路径包含 confirmed 单位或稳定共同作者。
- `NOT` 原子不算正向证据，不能排除 confirmed 身份词。

**先写失败测试：**

- 嵌套 OR 中一条首字母路径无单位时拒绝。
- 单位或共同作者独立 OR 路径拒绝。
- `NOT affiliation` 不满足首字母约束。
- AI expression 与 raw query 不一致时拒绝。
- 通过校验后 raw query 字节不变。
- 65 条路径拒绝，64 条通过。
- 日期原子拒绝。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pubmed_author_query
```

**提交：** `feat: validate structured PubMed author queries`

### 阶段 4：AI 多候选生成与手工查询映射

**目标：** 让 AI 专业构建查询，程序只校验；AI 不可用时仍可手工执行。

**文件：**

- 修改 `src-tauri/src/services/pubmed_service.rs`
- 修改 `src-tauri/src/commands/pubmed_cmd.rs`
- 修改 `src-tauri/src/models.rs`
- 修改 `src-tauri/src/lib.rs`
- 新增 `src/author_query.js`
- 新增 `tests/author-query.test.mjs`

**后端：**

1. 更新作者查询 prompt，要求 1–3 个完整 PubMed 候选及 expression/atom 证据标注。
2. `build_pubmed_author_query` 返回候选集合、识别作者和机构，不再只返回单个 query。
3. 逐个调用阶段 3 校验；有错误时把结构化错误反馈给 AI，只自动纠错一次。
4. 增加手工查询校验命令。第一轮可映射用户输入/明确确认变体；第二轮必须由后端按 search ID 加载 profile 并验证 evidence ID，不能信任前端自报状态。
5. 只有实际 AI 调用返回 usage 后才沿用现有 provider/model 费用记录；校验失败且未发出模型请求时不得计费。

**前端纯逻辑：**

- 候选选择和编辑状态。
- 文本编辑后旧 expression 立即失效。
- 接收后端重新解析结果并列出未映射原子。
- 第一轮允许用户确认新姓名/单位映射；第二轮只能选择 confirmed evidence。

**先写失败测试：**

- AI 返回 3 个候选并保留策略与原始 query。
- 首次响应不合法时只重试一次。
- 编辑 query 后旧契约不可继续提交。
- 手工第二轮使用未知 evidence ID 时拒绝。
- AI 不可用时手工第一轮仍能通过校验。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml author_query_candidates
node --test tests/author-query.test.mjs
```

**提交：** `feat: generate editable PubMed author query candidates`

### 阶段 5：多候选查询界面与预览

**目标：** 用户看得到并决定实际提交 PubMed 的查询。

**文件：**

- 修改 `src/index.html`
- 修改 `src/styles.css`
- 修改 `src/main.js`
- 修改 `src/author_query.js`
- 新增 `tests/pubmed-author-query-ui.test.mjs`
- 修改 `tests/pubmed-preview-ai-assessment.test.mjs`

**交互：**

1. “AI 生成检索式”是明确按钮，不由输入变化自动触发。
2. 显示 1–3 个候选的策略、理由、完整编辑框、校验状态和 PubMed 命中数。
3. 每个候选复用 `preview_pubmed_search` 请求少量样本；单个失败不隐藏其他候选。
4. 用户选择一个候选或编辑后重新校验；未映射原子使用结构化映射控件。
5. 只有当前选中候选通过校验时允许第一轮抓取。
6. 作者模式生成查询时不得触发 `assess_pubmed_author_preview`。

**布局要求：**

- 候选是同级列表，不嵌套卡片。
- 查询编辑区域使用稳定高度并允许扩展，不让长查询挤压按钮。
- 校验错误定位到具体原子；不用大段说明文字替代可操作状态。
- 移动端按钮和长字段标签不能溢出。

**先写失败测试：**

- 三个候选独立显示命中数。
- 选择/编辑后只运行当前候选。
- 不合格候选禁用抓取。
- 生成查询不触发复杂评估。
- 现有作者/机构字段恢复逻辑继续工作。

**命令：**

```bash
node --test tests/author-query.test.mjs tests/pubmed-author-query-ui.test.mjs tests/pubmed-preview-ai-assessment.test.mjs
node --check src/main.js
```

**提交：** `feat: add PubMed author query candidate picker`

### 阶段 6：typed 作者指纹与目标作者节点选择

**目标：** 从用户确认的目标作者节点建立可信指纹，不再使用文章第一单位。

**文件：**

- 新增 `src-tauri/src/services/pubmed_author_identity_service.rs`
- 修改 `src-tauri/src/services/mod.rs`
- 修改 `src-tauri/src/models.rs`
- 修改 `src-tauri/src/services/pubmed_search_service.rs`
- 修改 `src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改 `src/author_identity.js`
- 修改 `src/main.js`
- 修改 `tests/author-identity.test.mjs`

**身份状态 v2：**

- typed `AuthorIdentityStateV2`，包含 schema/version、seed PMID/entry ID、目标 author order、姓名/单位/ORCID 证据、稳定共同作者、稳定身份 UUID、逐篇状态和查询生命周期。
- legacy v1 在读取时转换；首次保存时写 v2。未知/损坏字段回退并报告，不丢弃原始状态。
- 稳定身份 UUID 在用户确认组时使用浏览器 `crypto.randomUUID()` 生成并持久化；测试注入固定 ID，不新增 Rust UUID 依赖。

**目标节点：**

1. 初次按用户姓名和已知单位推荐 author node。
2. 多个候选时在种子行展开作者及其单位，必须由用户点选。
3. 后续按 confirmed ORCID、完整姓名、首字母+单位/共同作者顺序解析。
4. unresolved 文章不得贡献单位、ORCID 或共同作者，状态只能需要确认。

**证据晋升：**

- 种子或用户“确认作者”只在节点唯一时晋升姓名、ORCID、专属单位。
- 共同作者至少出现在两篇 confirmed 论文才稳定。
- 高度可能不自动晋升。
- 证据变化只设置 `generation_required`，不调用 AI。

**先写失败测试：**

- 目标作者不是第一作者。
- 首次种子两个同名节点要求用户选择。
- unresolved 不贡献证据。
- 1–2 篇为有限指纹，3 篇且两类证据为稳定指纹。
- legacy v1 状态迁移。
- 移除种子使共同作者失去稳定性并使引用查询失效。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pubmed_author_identity
node --test tests/author-identity.test.mjs
```

**提交：** `feat: build author fingerprints from linked metadata`

### 阶段 7：第二轮候选与多查询 run

**目标：** 用 active base/expansion 形成一个可恢复、原子提交的逻辑结果集。

**文件：**

- 修改 `src-tauri/src/services/pubmed_service.rs`
- 修改 `src-tauri/src/services/pubmed_author_query_service.rs`
- 修改 `src-tauri/src/services/pubmed_author_identity_service.rs`
- 修改 `src-tauri/src/services/pubmed_search_service.rs`
- 修改 `src-tauri/src/commands/pubmed_cmd.rs`
- 修改 `src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改 `src-tauri/src/models.rs`
- 修改 `src/main.js`
- 修改 `src/author_query.js`

**查询生命周期：**

- `current`：active 查询与当前指纹兼容。
- `generation_required`：证据变化，只显示生成按钮，不调用 AI。
- `pending`：用户点击生成后得到候选，等待选择。
- `active/rejected/superseded`：保存批准历史。
- 任一 active expansion evidence 不再 confirmed 时立即失效，refresh 降级为 base-only。

**run：**

1. topic 搜索和初始作者搜索建立单个 base query 记录。
2. expansion/refresh 建立 base + expansion 查询记录。
3. 每个查询分支独立 ESearch，来源/rank 写 `run_item_sources`。
4. `run_items` 保存 PMID 并集；重复 PMID 只 EFetch/复用一次。
5. 任一分支失败则 run partial，不更新 `is_current_match`；恢复只重试失败分支和未完成 PMID。
6. 全部分支及 item 完成后单事务提交并集。base 结果排序优先，expansion-only 排其后。

**先写失败测试：**

- 1–2 篇种子候选不含共同作者分支。
- 稳定指纹可生成共同作者分支，所有 atom 都有 confirmed evidence ID。
- 同一 PMID 命中两个分支只抓取一次但保留两条来源。
- expansion 完成不会隐藏 base-only PMID。
- 单分支失败不替换上一轮结果，恢复后正确提交。
- rejected/降级证据使 active expansion 无效并仅运行 base。

**命令：**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pubmed_multi_query_run
cargo test --manifest-path src-tauri/Cargo.toml author_expansion
```

**提交：** `feat: run adaptive PubMed author searches`

### 阶段 8：确定性身份聚类与稳定决定继承

**目标：** 用户审核身份组，新增结果不会让历史决定漂移。

**文件：**

- 修改 `src/author_identity.js`
- 修改 `src/main.js`
- 修改 `src/styles.css`
- 修改 `tests/author-identity.test.mjs`
- 新增 `tests/author-identity-clustering.test.mjs`

**实现：**

1. 只使用目标 author node 的单位和共同作者。
2. 相同非空 ORCID 强制成组；不同非空 ORCID 禁止合并。
3. 单位按 confirmed alias、规范文本和有效 token 阈值匹配。
4. 共同作者按至少两个签名，或一个完整姓名且 Jaccard >= 0.30 建强边。
5. 使用稳定排序的无向证据图连通分量，结果与输入顺序无关。
6. 主题只作同分排序，不创建聚类边。
7. 组操作写逐篇状态并创建稳定身份 UUID/签名快照。
8. 拆分、合并和新增成员按规格继承；多个签名或决定冲突时转需要确认。

**先写失败测试：**

- 相同 ORCID 即使单位变化也同组。
- 不同 ORCID 永不合并。
- 只共享通用单位词不合并。
- 输入顺序打乱后组成员不变。
- 组拆分、决定冲突和新增成员继承。
- 1,000 篇合成候选在 CI 中 2 秒内完成。

**命令：**

```bash
node --test tests/author-identity.test.mjs tests/author-identity-clustering.test.mjs
```

**提交：** `feat: cluster PubMed results by author identity`

### 阶段 9：复杂 AI 评估显式 opt-in

**目标：** 未明确勾选时复杂评估调用和费用严格为零。

**文件：**

- 新增 `src/author_search_workflow.js`
- 新增 `tests/author-ai-opt-in.test.mjs`
- 修改 `src/main.js`
- 修改 `src/index.html`
- 修改 `src/styles.css`
- 修改 `src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改 `src-tauri/src/services/pubmed_search_service.rs`
- 修改 `tests/pubmed-preview-ai-assessment.test.mjs`

**授权规则：**

1. 作者新建表单和每次作者“检查更新”确认弹窗都显示 `AI 评估`，默认未勾选，不持久化。
2. AI 查询生成按钮不读取或修改复杂评估勾选状态。
3. 作者预览阶段不再直接对随机样本运行复杂作者评估。
4. 只有确认种子并形成身份组后，且当前仍勾选时，才调用作者评估 command。
5. 只发送本轮新增或重新聚类的变化组；历史未变化组不重复评估。
6. 每个评估 batch 派发前重新读取 opt-in；取消后停止后续 batch，已发请求记录实际费用。
7. 复杂评估失败不回滚检索、种子、指纹或本地聚类。

**后端防误调用：**

- command payload 增加本轮评估范围/运行 ID，服务验证 PMID 属于该 run 的新增或变化集合。
- 空范围拒绝，不产生模型调用。
- 费用只在实际模型请求完成并返回 usage 后记录。

**先写失败测试：**

- 作者模式打开时 checkbox 未勾选。
- 未勾选运行完整流程，复杂评估 invoke 次数和费用均为零。
- 勾选后仅新增/变化组调用。
- 每次更新弹窗重新默认未勾选。
- 抓取中取消后不发下一 batch，已发请求只记一次费用。
- 点击第一轮/第二轮 AI 生成查询不触发作者评估。
- 复杂评估失败后本地身份组仍显示。

**命令：**

```bash
node --test tests/author-ai-opt-in.test.mjs tests/pubmed-preview-ai-assessment.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml author_assessment
```

**提交：** `feat: require opt-in for author AI assessment`

### 阶段 10：更新确认、恢复和性能验收

**目标：** 完成持续订阅闭环并验证失败恢复。

**文件：**

- 修改 `src/main.js`
- 修改 `src/author_search_workflow.js`
- 修改 `src-tauri/src/services/pubmed_search_service.rs`
- 修改 `src-tauri/src/services/pubmed_author_identity_service.rs`
- 修改相关 Rust/JavaScript 集成测试

**实现：**

- 作者检查更新先打开确认弹窗，显示当前 active 查询、是否 generation_required 和默认关闭的 AI 评估。
- pending 查询不阻塞更新；使用最后 active 查询。
- active expansion 失效时明确显示 base-only 降级状态。
- 更新后只突出新增确认/高度可能/待确认组；同名结果保留但默认隐藏。
- 分页抓取、取消和恢复沿用 run 快照；取消在当前网络或本地批次后生效。
- 每批最多渲染 100 行，避免一次创建全部 DOM。

**集成测试：**

- 首次 AI 候选 -> 选择 base -> 抓取 -> 点选种子作者节点 -> 有限/完整 expansion -> 身份组审核。
- refresh 同时运行 base/expansion 并正确合并。
- AI 不可用时手工查询和本地身份审核可用。
- 查询分支失败、XML 单篇失败、评估失败、用户取消均不破坏上次成功结果。
- 1,000 篇结构化评分和聚类性能达标。

**命令：**

```bash
node --test tests/author-*.test.mjs tests/pubmed-preview-ai-assessment.test.mjs tests/pubmed-rss-dialog.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml pubmed
```

**提交：** `feat: complete adaptive author subscription workflow`

### 阶段 11：完整回归与交付验证

**目标：** 确认作者功能没有破坏普通 PubMed、RSS、翻译和筛选流程。

**命令：**

```bash
node --check src/main.js
node --test tests/*.test.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

**人工验收：**

1. 使用“丽水市中心医院 + 吕玲春”生成多个 PubMed 候选，确认程序未改写选中查询。
2. 验证纯首字母无约束候选被定位并拒绝。
3. 验证目标作者不是第一作者时可以点选正确节点和单位。
4. 验证 1–2 篇种子只生成有限扩展，3 篇稳定种子生成完整扩展。
5. 验证两轮并集和身份组批量判断。
6. 验证复杂 AI 评估默认关闭；未勾选无调用和费用；勾选后仅评估新增/变化组。
7. 验证检查更新每次重新默认未勾选，取消勾选停止后续评估批次。
8. 验证普通主题检索、手工 PubMed 查询和既有 RSS 阅读流程不变。

**最终提交：** 只在所有阶段提交均通过后更新版本/发行材料；本计划本身不授权替换 `/Applications/RSS Reading.app`。

## 5. 风险与决策点

### 5.1 PubMed 查询语法范围

第一版 parser 只支持作者工作流需要的引号、字段标签、括号和布尔操作。遇到无法无损解析的高级 PubMed 语法时拒绝并要求简化，不尝试猜测。若真实用户查询频繁需要额外语法，再以 fixture 驱动扩展 parser。

### 5.2 身份状态大小

当前 state JSON 上限为 512 KB。稳定签名和查询历史可能增长；实施阶段用 1,000 篇 fixture 测量。若接近上限，将逐篇状态迁入关系表，而不是简单放大限制。

### 5.3 前端与后端职责

查询安全和第二轮证据 ID 必须由后端校验；前端只负责编辑体验。聚类先保留为可测试的前端纯逻辑，避免本次同时重写全部列表架构。若性能测试达不到 2 秒，再把聚类迁入 Rust，接口不变。

### 5.4 AI 成本与授权

查询生成是用户点击按钮后的显式调用；复杂评估是独立 opt-in。任何后台刷新都不能自动触发两者，只有实际发出的模型请求才能产生费用记录。

### 5.5 迁移与并行改动

`db_migrations.rs`、`models.rs`、`main.js` 当前都有其他未提交修改。每个阶段开始前重新读取最新内容；迁移版本冲突时顺延版本并补升级测试，不回退或覆盖现有变更。

## 6. 检查点与回退路径

- 阶段 2 未能可靠解析作者单位：停止后续身份评分，保留旧展示但不把文章级单位当身份依据。
- 阶段 3 parser 无法覆盖实际 AI 查询：先限制 prompt 输出到已支持标准子集，不用字符串正则放宽安全规则。
- 阶段 6 v1 状态迁移存在歧义：保留原始 JSON 备份并要求用户重新确认种子，不自动猜测目标 author order。
- 阶段 7 多查询 run 部分失败：继续显示上次成功集合，恢复后再原子提交。
- 阶段 9 opt-in 无法证明零调用：不发布复杂评估入口，保留本地聚类。
- 性能不达标：优先建立单位/共同作者倒排索引，仍不达标再迁移聚类到 Rust。

## 7. 立即执行顺序

1. 先运行阶段 0 基线命令并记录结果。
2. 从阶段 1 的 schema 失败测试开始，不先改 UI。
3. 阶段 2 验证作者与单位对应关系后，才允许后续指纹读取新字段。
4. 阶段 3 查询校验全绿后，才替换现有单查询 AI 响应。
5. 每阶段完成后运行该阶段命令、检查 diff、只提交该阶段文件。
6. 阶段 11 全量验证通过后，再决定是否构建和安装正式应用。
