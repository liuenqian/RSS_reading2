# PubMed 检索批次管理实施计划

日期：2026-07-15
依据：[PubMed 检索批次管理设计](../specs/2026-07-15-pubmed-search-management-design.md)
状态：待执行

## 目标

在 Cento 中加入可持续更新的 PubMed 检索批次：自然语言生成可编辑检索式，直接从 NCBI 抓取结果，按批次筛选并增量更新；全部标题自动翻译，只有“保留”文献翻译摘要；复用现有期刊指标、阅读、笔记和文献对话，并允许 AI 对勾选文献提出经人工确认后应用的筛选建议。

## 执行原则

- 每个任务尽量形成一个小提交；前一个任务测试通过后再开始下一个。若文件中混有用户原有未提交改动且无法安全拆分，保留工作区改动而不强行提交。
- 数据迁移先于新 UI，且必须在现有用户数据库副本上演练。
- 不覆盖当前工作区已有的 `src/main.js` 未提交修改；进入前端任务前重新读取并保留该 diff。
- 所有网络解析测试使用本地 fixture；真实 NCBI 请求只在最后手动验证。
- Rust 异步 command 在 `.await` 前释放 SQLite `MutexGuard`。
- 不新增 NCBI API Key 设置；请求节流到无 Key 规则以内。
- 不改 RSS 现有摘要翻译行为。PubMed-only 文献才应用“保留后翻译摘要”的门控。

## 阶段与检查点

### 检查点 A：数据层安全

完成任务 1-3 后，旧 RSS、阅读状态、笔记、标签和聊天必须继续工作；此时尚不显示 PubMed 检索 UI。

### 检查点 B：后端闭环

完成任务 4-6 后，可以通过 Tauri command 创建/更新批次、筛选和触发翻译；前端仍可保持隐藏入口。

### 检查点 C：用户工作流

完成任务 7-10 后，交付完整界面、AI 筛选、运行验证和构建。

---

## 任务 1：建立可回滚的数据库迁移框架

**文件**

- 修改：`src-tauri/src/db.rs`
- 新建：`src-tauri/src/db_migrations.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/src/models.rs`

**步骤**

1. 在 `db.rs` 中将复杂迁移从 `ensure_column` 流程分离，启动时先执行带版本号的迁移入口。
2. 在 `db_migrations.rs` 增加当前 schema 检测和事务迁移骨架；迁移前使用现有 DB family 备份模式创建一次备份。
3. 在事务中创建下列新表和索引，但暂不切换业务查询：
   - `entry_identifiers`
   - `entry_identity_conflicts`
   - `entry_feed_memberships`
   - `pubmed_searches`
   - `pubmed_search_entries`
   - `pubmed_search_runs`
   - `pubmed_search_run_items`
4. 重建 `entries`：保持原 ID，`feed_id` 改为可空并使用 `ON DELETE SET NULL`；增加日期原文、日期精度、排序键和标准化 PMID/DOI 展示列。
5. 回填每条旧 entry 的 RSS membership 和标准化身份；先不合并重复项。
6. 迁移结束前运行 `PRAGMA foreign_key_check`；任何失败整体回滚。
7. 将 `models::Entry.feed_id` 改为 `Option<i64>`，增加日期字段；保持 serde 字段兼容。

**先写测试**

- 在 `db_migrations.rs` 的 `#[cfg(test)]` 模块创建内存旧 schema fixture。
- 验证迁移后 entry ID、translations、reading_notes、tags、paper_chat 和 reading_events 引用仍存在。
- 验证事务中人为制造错误时旧结构保持不变。
- 验证重复执行迁移幂等。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml db_migrations
cargo check --manifest-path src-tauri/Cargo.toml
```

**完成条件**

- 旧数据库可迁移、可重复启动，失败可回滚。
- 尚未改变 RSS 列表和删除行为。

**建议提交**

```bash
git add src-tauri/src/db.rs src-tauri/src/db_migrations.rs src-tauri/src/lib.rs src-tauri/src/models.rs
git commit -m "feat: add source-neutral entry schema migration"
```

---

## 任务 2：实现规范文献身份与旧重复项合并

**文件**

- 新建：`src-tauri/src/services/entry_identity_service.rs`
- 修改：`src-tauri/src/services/mod.rs`
- 修改：`src-tauri/src/db_migrations.rs`
- 修改：`src-tauri/src/services/paper_chat_service.rs`
- 修改：`src-tauri/src/services/reading_service.rs`

**步骤**

1. 实现纯函数：PMID 只保留数字；DOI 去协议、`doi:` 前缀、空白并转小写。
2. 实现身份查找：active PMID 优先，active 且非冲突 DOI 次之；标题不得跨来源合并。
3. 在迁移中按设计确定规范 entry：用户内容数量多者优先，相同则最小 ID。
4. 合并 RSS memberships、已读状态、外部元数据、标签和最新非空翻译。
5. 相同 profile 的阅读笔记按时间追加并加入迁移分隔标题。
6. 重写 `paper_chat_sessions.entry_ids_json` 和 `scope_key`；发生 scope 合并时按时间/ID 合并消息。
7. 重写 `reading_events.entry_id`，保留每条事件。
8. 不同 PMID 共享 DOI 时，将 DOI identities 标为 `conflicted`，写入 `entry_identity_conflicts`，不得合并。
9. 所有引用迁移并检查成功后删除 loser entry。

**先写测试**

- PMID/DOI 标准化表驱动测试。
- 同 PMID 两条 entry 合并并保留全部标签、笔记文本和聊天消息。
- 不同 PMID 同 DOI 保持两条规范记录，DOI 不参与后续自动匹配。
- `entry_identifiers` active 唯一索引和 `(entry_id, kind, value)` 唯一约束生效。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml entry_identity
cargo test --manifest-path src-tauri/Cargo.toml db_migrations
```

**完成条件**

- 规范文献合并规则可通过纯本地测试复现。
- 没有用户笔记、聊天文本或标签丢失。

**建议提交**

```bash
git add src-tauri/src/services/entry_identity_service.rs src-tauri/src/services/mod.rs src-tauri/src/db_migrations.rs src-tauri/src/services/paper_chat_service.rs src-tauri/src/services/reading_service.rs
git commit -m "feat: canonicalize literature identities"
```

---

## 任务 3：把 RSS 写入、查询和删除切换到成员关系

**文件**

- 修改：`src-tauri/src/services/fetch_service.rs`
- 修改：`src-tauri/src/services/entry_service.rs`
- 修改：`src-tauri/src/services/feed_service.rs`
- 修改：`src-tauri/src/commands/entry_cmd.rs`
- 修改：`src-tauri/src/services/translation_pipeline.rs`

**步骤**

1. 将 `fetch_service.rs` 的 `INSERT OR IGNORE INTO entries` 替换为：解析身份 -> 复用/创建规范 entry -> upsert `entry_feed_memberships`。
2. 新条目仍写一条 `reading_events(kind='fetched')`；已存在规范 entry 新增另一个 feed membership 时也记录该 feed 的抓取事件，但不复制 entry。
3. `entry_service::list_entries(feed_id)` 改为通过 membership 查询；全部文章查询继续去重。
4. `feed_service::delete_feed` 在事务中先删除 memberships，再删除 feed；仅清理无任何来源且无用户内容的孤儿 entry。
5. 保留期清理跳过仍属于 PubMed 批次或其他 RSS 源的 entry。
6. 调整 `translation_pipeline::collect_pending`：
   - RSS membership 存在时保持现有标题/摘要自动翻译逻辑。
   - PubMed-only entry 始终允许标题翻译。
   - PubMed-only entry 仅在任一批次状态为 `keep` 时允许摘要翻译。
7. 所有 SQL 映射适配 `feed_id: Option<i64>`。

**先写测试**

- 同一 PMID 从两个 feed 抓取只产生一个 entry、两个 membership。
- 删除一个 feed 后 entry 仍可从另一个 feed读取。
- 删除最后一个 feed 时，有笔记/标签或 PubMed membership 的 entry 保留。
- RSS-only 摘要翻译行为与改动前一致；PubMed-only 未保留时不进入摘要任务。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml fetch_service
cargo test --manifest-path src-tauri/Cargo.toml entry_service
cargo test --manifest-path src-tauri/Cargo.toml translation_pipeline
cargo check --manifest-path src-tauri/Cargo.toml
```

**人工检查**

- 使用临时 app-data DB 启动现有应用。
- 刷新一个 RSS、打开文章、删除订阅源，确认历史阅读统计仍在。

**建议提交**

```bash
git add src-tauri/src/services/fetch_service.rs src-tauri/src/services/entry_service.rs src-tauri/src/services/feed_service.rs src-tauri/src/commands/entry_cmd.rs src-tauri/src/services/translation_pipeline.rs
git commit -m "refactor: store RSS membership separately"
```

---

## 任务 4：实现 PubMed 检索预览和 XML 解析

**文件**

- 新建：`src-tauri/src/services/pubmed_search_service.rs`
- 修改：`src-tauri/src/services/mod.rs`
- 修改：`src-tauri/src/services/article_service.rs`
- 修改：`src-tauri/src/models.rs`

**步骤**

1. 在新服务中建立带超时和现有 User-Agent 风格的 NCBI client，并实现不超过 3 requests/second 的共享节流器。
2. 实现 `preview_query(query)`：ESearch 返回总数、前若干 PMID 和预览条目。
3. 实现带 `usehistory=y` 的完整搜索和 run item 快照保存。
4. 将 `article_service.rs` 中 PubMed XML 的通用节点解析提取为可复用函数，解析：PMID、PMCID、DOI、标题、摘要、作者、期刊、单位、发表日期和免费全文状态。
5. 日期解析输出 raw、partial ISO、precision 和 sort key；季节映射只用于排序。
6. 增加模型：`PubmedSearchPreview`、`PubmedArticleRecord`、`PubmedSearchRunProgress`。
7. 解析单篇失败返回带 PMID 的结构化失败，不中断同批其他记录。

**先写测试**

- 使用固定 XML fixture 覆盖完整日期、年月、年份、季节、MedlineDate、缺摘要、多作者、多 identifier。
- ESearch/History 响应解析测试不访问网络。
- 节流器用可控时钟或小单元测试验证请求间隔，不做真实等待型大测试。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pubmed_search_service
cargo test --manifest-path src-tauri/Cargo.toml article_service
```

**完成条件**

- 本地 fixture 可完整映射为 Entry 所需字段。
- 预览与完整抓取共享同一解析路径。

**建议提交**

```bash
git add src-tauri/src/services/pubmed_search_service.rs src-tauri/src/services/mod.rs src-tauri/src/services/article_service.rs src-tauri/src/models.rs
git commit -m "feat: parse and preview PubMed searches"
```

---

## 任务 5：实现检索批次、运行恢复和增量更新 command

**文件**

- 新建：`src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改：`src-tauri/src/commands/mod.rs`
- 修改：`src-tauri/src/services/pubmed_search_service.rs`
- 修改：`src-tauri/src/db.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/src/models.rs`

**新增 command**

- `preview_pubmed_search`
- `create_pubmed_search`
- `list_pubmed_searches`
- `get_pubmed_search`
- `clone_pubmed_search`
- `rename_pubmed_search`
- `delete_pubmed_search`
- `run_pubmed_search`
- `resume_pubmed_search_run`
- `cancel_pubmed_search_run`
- `list_pubmed_search_entries`

**步骤**

1. command 只负责参数校验、锁边界和调用服务；网络 `.await` 期间不得持有 DB lock。
2. 首次 run：先持久化 ESearch PMID/rank 快照，再按固定批量 EFetch。
3. 每批在短事务中 identity-resolve、upsert entry、search membership 和 run item 状态。
4. 首次发现时间只写一次；`last_seen_at` 每次成功命中更新。
5. completed run 在单事务中提交 `is_current_match`、`pubmed_rank`、统计和 `last_success_at`。
6. partial/failed/cancelled 不替换上次成功快照；resume 只处理 pending/failed items。
7. 使用 Tauri event `pubmed-search-progress` 发送 run、processed/total、added/reused/failed 和当前 PMID。
8. 在 `DbState` 增加按 run ID 管理的取消令牌注册表。同一 search 同时只允许一个 running run；取消 command 设置令牌，任务在批次边界检查并把数据库状态收敛为 cancelled，结束后清理注册表。
9. 新 entry 入库后触发标题翻译管线，但不触发 PubMed-only 摘要翻译。

**先写测试**

- 首次 run 新增/复用计数。
- 更新 run 只追加新 PMID并保留旧筛选状态。
- partial/cancelled 恢复只请求失败项。
- completed 前不改变上次 rank/current-match。
- 同一 search 并发启动被拒绝。
- 删除批次不删除仍有 RSS、其他批次或用户内容的 entry。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml pubmed_search
cargo check --manifest-path src-tauri/Cargo.toml
```

**建议提交**

```bash
git add src-tauri/src/commands/pubmed_search_cmd.rs src-tauri/src/commands/mod.rs src-tauri/src/services/pubmed_search_service.rs src-tauri/src/db.rs src-tauri/src/lib.rs src-tauri/src/models.rs
git commit -m "feat: manage persistent PubMed search runs"
```

---

## 任务 6：实现批次筛选状态和保留后摘要翻译

**文件**

- 修改：`src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改：`src-tauri/src/services/pubmed_search_service.rs`
- 修改：`src-tauri/src/services/translation_pipeline.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/src/models.rs`

**新增 command**

- `set_pubmed_screening_status`
- `bulk_set_pubmed_screening_status`
- `list_kept_pubmed_entries`

**步骤**

1. 校验状态只允许 `unreviewed/keep/maybe/exclude`。
2. 单篇和批量状态修改都限定 `search_id + entry_id`，不得误改其他批次。
3. 批量修改使用单个事务并返回更新后的 membership 数据。
4. 由非 keep 变为 keep 时，提交事务后调用翻译管线；已有有效摘要翻译不重复请求。
5. 从 keep 改为其他状态时保留已有翻译缓存。
6. “保留文献”查询按 entry 去重，并返回所属检索批次和各批次状态。

**先写测试**

- 同一 entry 在两个批次可以 keep/exclude 不同状态。
- 批量操作遇到一个非法 entry 时整体回滚。
- keep 只触发一次摘要翻译资格；maybe/exclude 不触发。
- 保留文献聚合去重。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml screening
cargo test --manifest-path src-tauri/Cargo.toml translation_pipeline
```

**建议提交**

```bash
git add src-tauri/src/commands/pubmed_search_cmd.rs src-tauri/src/services/pubmed_search_service.rs src-tauri/src/services/translation_pipeline.rs src-tauri/src/lib.rs src-tauri/src/models.rs
git commit -m "feat: screen PubMed results and gate summary translation"
```

---

## 任务 7：增加检索创建、左侧批次和保留文献入口

**文件**

- 修改：`src/index.html`
- 修改：`src/styles.css`
- 修改：`src/main.js`

**前置保护**

1. 先运行 `git diff -- src/main.js`。
2. 保留当前 `stripSummaryIdentifierFooter` 及相关未提交改动。
3. 只在重新读取的实时上下文上应用补丁。

**步骤**

1. 在现有 sidebar overview 与 `feed-list` 之间增加“保留文献”和“PubMed 检索”分区，不重做三栏布局。
2. 新增检索创建 modal/section：研究问题、AI 生成、可编辑检索式、名称、命中数、预览和确认抓取。
3. 复用 `natural_to_pubmed_query`；新增 command 只负责 PubMed 预览/创建。
4. 在 `main.js` 增加明确模式：RSS feed、PubMed search、kept entries；切换模式清理不兼容的多选状态。
5. 渲染批次列表、最近新增数、上次成功更新时间和“检查更新”。
6. 监听 `pubmed-search-progress`，显示可取消进度和完成汇总。
7. 已创建批次的 query 只读；“复制为新检索”回到可编辑预览。

**检查**

```bash
node --check src/main.js
```

**人工验证**

- 自然语言生成失败时仍可手工输入。
- 预览失败不创建批次。
- 切换 RSS/检索/保留文献不会打乱现有详情和文献对话。

**建议提交**

提交前用 `git diff -- src/main.js` 区分本任务补丁和原有 `stripSummaryIdentifierFooter` 改动。只暂存本任务 hunks；如果无法非交互地安全拆分，暂不提交该文件，不得回退或顺带提交用户原改动。

---

## 任务 8：实现批次列表、编号、筛选、排序和状态操作

**文件**

- 修改：`src/index.html`
- 修改：`src/styles.css`
- 修改：`src/main.js`
- 必要时修改：`src-tauri/src/commands/pubmed_search_cmd.rs`
- 必要时修改：`src-tauri/src/services/pubmed_search_service.rs`

**步骤**

1. 批次列表每行严格按“复选框 -> 编号 -> 文献内容 -> 状态”渲染。
2. 编号由当前筛选/排序后的数组索引产生，不能存库；AI scope 保存 entry ID。
3. 元数据行显示期刊、发表年月、首次加入批次时间和 PMID。
4. 复用现有 `journalMetricsIndex`、`getJournalMetrics` 和 badges 渲染 IF/JCR/中科院/Top。
5. 增加筛选：状态、最低 IF、JCR、中科院、Top、发表时间范围、加入时间范围。
6. 增加排序：发表时间、加入时间、IF、PubMed rank；无日期始终末尾。
7. 行级操作和批量操作支持未筛选、保留、待定、排除。
8. 标记 keep 后显示摘要翻译进度；其他状态不自动翻译摘要。
9. 大列表采用分块渲染或窗口化；先写一个纯函数分页/窗口测试，避免一次插入全部 DOM。

**检查**

```bash
node --check src/main.js
cargo test --manifest-path src-tauri/Cargo.toml screening
```

**视图验证**

- 1440x900、1024x768 和移动宽度下无重叠。
- 最长标题、年月缺失、指标缺失和三位数编号不挤压状态标签。
- 多选后编号不变化，切换筛选后选择按现有规则清理。

**建议提交**

先核对 `src/main.js` 的原有用户 diff，只提交本任务 hunks；不能安全拆分时保持未提交。Rust 文件可单独提交。

---

## 任务 9：复用文献对话并增加结构化 AI 筛选确认

**文件**

- 修改：`src-tauri/src/services/paper_chat_service.rs`
- 修改：`src-tauri/src/commands/paper_chat_cmd.rs`
- 修改：`src-tauri/src/models.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src/index.html`
- 修改：`src/styles.css`
- 修改：`src/main.js`

**步骤**

1. 保持现有普通 paper chat command 和历史不变。
2. 新增 `suggest_pubmed_screening`：接收 `search_id`、entry IDs、用户标准和可选 profile；服务端重新读取所选 entries，不能信任前端提交的标题/摘要。
3. Prompt 要求返回按 entry ID/PMID 绑定的结构化 JSON：建议状态和简短理由；展示编号只作为上下文标签。
4. 解析失败时保存/显示原始聊天回答，但不返回可应用 suggestions。
5. 对话消息仍写入现有 session/message 表，复用费用记录。
6. 新增确认面板：编号、标题、PMID、建议、理由；允许逐项修改。
7. “应用建议”调用任务 6 的批量 command；没有第二套写入逻辑。
8. 应用成功后刷新批次列表并让新 keep 文献进入摘要翻译队列。
9. 保留现有“追加到笔记”按钮和目标笔记选择。

**先写测试**

- JSON 响应合法/缺字段/重复 entry/范围外 entry。
- AI 返回编号错误但 entry ID 正确时仍按 ID 映射。
- 未确认前数据库状态不变。
- 应用建议只能修改当前 search 的所选 entry。

**运行**

```bash
cargo test --manifest-path src-tauri/Cargo.toml paper_chat
node --check src/main.js
```

**建议提交**

后端与无重叠前端文件可正常提交；`src/main.js` 仍按任务 7 的重叠改动规则处理。

---

## 任务 10：迁移演练、端到端验证和本地构建

**文件**

- 根据失败测试修复上述文件。
- 如需要记录用户操作，更新：`README.md`
- 不修改发布配置，除非构建暴露必要问题。

**数据库安全验证**

1. 复制真实 app-data DB 到临时目录，不在原库上首次演练。
2. 记录迁移前 feeds/entries/translations/notes/chat/tags/events 数量和抽样内容。
3. 用测试 app-data 启动新版本完成迁移。
4. 验证规范 entry 数减少只来自已确认重复合并；用户文本和历史事件内容保留。
5. 验证删除 RSS 源不会删除仍属于检索批次的文献。

**功能验证**

1. 创建一个窄范围 PubMed 检索，确认预览、抓取和标题翻译。
2. 将一篇设为保留，确认只有该篇摘要进入翻译。
3. 重新运行同一检索，确认旧状态保留、新 PMID 追加。
4. 中途取消并恢复，确认只继续 pending/failed items。
5. 测试发表时间/加入时间、IF、JCR、中科院和 Top 筛选排序。
6. 勾选多篇使用 AI 筛选，确认未点击应用前状态不变。
7. 应用建议后检查保留文献汇总、笔记和文献对话。
8. 回归现有 RSS 添加、刷新、翻译、删除、简报、阅读统计和更新检查。

**完整检查**

```bash
node --check src/main.js
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

**构建后**

- 启动生成的 `.app`，实际操作首次抓取、检查更新、筛选和 AI 对话。
- 检查日志不包含 API Key、授权头或敏感路径。
- 只有用户明确要求发布时，才替换 `/Applications/RSS Reading.app`、生成交付包或推送远端。

**建议提交**

先运行 `git diff --name-only` 和逐文件 `git diff`，只暂存本任务实际修复文件。禁止使用 `git add src src-tauri` 这类会带入无关改动的宽范围命令。

---

## 总体验收

- 用户无需打开 PubMed 网页或上传文件即可创建并运行检索。
- 更新只追加新文献，旧筛选、翻译、已读、标签、笔记和聊天不丢失。
- RSS 与多个检索批次共享规范文献，冲突 DOI 不被错误合并。
- 全部标题自动翻译；PubMed-only 摘要仅在任一批次 keep 后翻译。
- 列表包含复选框、编号、年月、加入时间和期刊指标，并支持已确认筛选/排序。
- AI 建议必须人工确认后才应用，普通文献对话和追加笔记继续可用。
- 真实数据库迁移演练、Rust 测试、JS 语法检查和 Tauri 构建全部通过。
