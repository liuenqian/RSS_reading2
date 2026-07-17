# Google 翻译 XLSX 往返实施计划

日期：2026-07-17
依据：[Google 翻译 XLSX 往返设计](../specs/2026-07-17-google-translate-xlsx-roundtrip-design.md)
状态：执行中

## 目标

在现有 PubMed Excel 导出弹窗内增加“Google 翻译”模式。用户可以自由选择标题、摘要和文章范围，导出 XLSX 后手动通过 Google 翻译网页处理，再将下载文件导入 Cento。译文写入现有翻译缓存，不调用 Google API，也不记录 AI Token 用量。

## 执行原则

- 保留普通 Excel/PubMed TXT 导出行为。
- 复用现有 PubMed 范围校验、翻译缓存和前端逐条更新机制。
- 不自动操作 Google 网页，不保存 Google 账号或认证信息。
- 导入先预览，确认后在单个 SQLite 事务中写入。
- 工作区已有未提交改动不得被覆盖或纳入本功能提交。
- 先完成纯后端文件往返测试，再接入前端。

## 任务 1：建立 XLSX 交换格式

**文件**

- 修改：`src-tauri/Cargo.toml`
- 新建：`src-tauri/src/services/google_translate_xlsx_service.rs`
- 修改：`src-tauri/src/services/mod.rs`

**步骤**

1. 增加只读 XLSX 解析依赖，禁用不需要的功能。
2. 定义 `CENTO_GT_1` 固定格式：entry ID、字段代码、原文哈希、文本、格式代码。
3. 使用现有 `rust_xlsxwriter` 生成翻译工作簿。
4. 解析 Google 下载后的工作簿，不依赖表头、工作表名称或行顺序。
5. 将空译文、重复键、错误格式、疑似未翻译等分类为结构化预览项。

**测试**

```bash
cargo test --manifest-path src-tauri/Cargo.toml google_translate_xlsx
```

## 任务 2：接入 PubMed 范围与事务写回

**文件**

- 修改：`src-tauri/src/models.rs`
- 修改：`src-tauri/src/services/pubmed_search_service.rs`
- 修改：`src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改：`src-tauri/src/lib.rs`

**步骤**

1. 复用现有 search/kept 范围校验，按 entry ID 获取英文标题、摘要和已有译文。
2. 增加 Google 文件导出命令，支持标题/摘要组合和仅未翻译过滤。
3. 在实际生成后检查文件大小；需要时拆分为安全分片并使用临时文件原子写入。
4. 增加多文件导入预览命令，校验 entry ID、字段、哈希、重复和已有译文冲突。
5. 增加确认导入命令，在一个事务中写入 `translations`，模型来源记为 `google-translate-web-document`。
6. 导入命令不调用 `cost_service`；提交后返回已更新字段，供前端立即刷新。

**测试**

```bash
cargo test --manifest-path src-tauri/Cargo.toml google_translate
cargo test --manifest-path src-tauri/Cargo.toml pubmed_search_service
```

## 任务 3：增加缺失摘要补全

**文件**

- 修改：`src-tauri/src/commands/pubmed_search_cmd.rs`
- 修改：`src-tauri/src/services/pubmed_search_service.rs`

**步骤**

1. 默认跳过缺失或仅包含 RSS 元数据的摘要。
2. 开启补全时复用现有 `article_service::fetch_abstract`，在异步网络请求前释放数据库锁。
3. 使用有限并发、逐项结果和可取消进度；失败或无结果不写入 XLSX。
4. 取消后由前端选择导出已完成部分或放弃。

**测试**

```bash
cargo test --manifest-path src-tauri/Cargo.toml google_translate_summary
```

## 任务 4：合并到现有导出弹窗

**文件**

- 修改：`src/main.js`
- 修改：`src/styles.css`
- 新建：`tests/google-translate-xlsx-workflow.test.mjs`

**步骤**

1. 扩展 `choosePubmedExportFields`，顶部增加“普通导出 / Google 翻译”分段控制。
2. 普通模式保持当前默认字段、必选 PMID 和保存流程。
3. Google 模式增加标题/摘要、三种范围、仅未翻译和摘要补全控件。
4. 实时显示文章数、可导出标题、可导出摘要、已有译文和缺失摘要统计。
5. 导出时选择基础路径；多分片完成后显示文件数量与目录。

**测试**

```bash
node --check src/main.js
node --test tests/google-translate-xlsx-workflow.test.mjs tests/entry-list-sort.test.mjs
```

## 任务 5：网页快捷按钮与导入预览

**文件**

- 修改：`src/main.js`
- 修改：`src/styles.css`
- 修改：`tests/google-translate-xlsx-workflow.test.mjs`

**步骤**

1. “打开 Google 翻译”复用现有 `open_url` 命令打开文档翻译页。
2. “导入译文”允许选择多个 XLSX，调用后端预览命令。
3. 显示可导入、警告、错误、已有译文和覆盖数量。
4. “覆盖已有译文”默认关闭；开启时二次确认。
5. 写入成功后复用条目更新逻辑，立即刷新当前列表和详情。

**测试**

```bash
node --check src/main.js
node --test tests/google-translate-xlsx-workflow.test.mjs
```

## 任务 6：回归、构建与实际验收

**运行**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml google_translate
cargo check --manifest-path src-tauri/Cargo.toml
node --check src/main.js
node --test tests/*.test.mjs
npm run build
```

**实际验收**

1. 启动开发版应用并打开一个 PubMed 检索。
2. 验证普通导出无变化。
3. 组合选择标题/摘要与三种范围并生成 XLSX。
4. 打开 Google 翻译文档页，上传测试 XLSX 并下载结果。
5. 导入结果，确认预览、覆盖保护和逐条显示。
6. 验证 AI Token 与费用统计未变化。

## 完成条件

- 普通导出测试和实际操作无回归。
- Google 翻译 XLSX 可导出、网页处理、预览并写回。
- 已翻译字段默认跳过，覆盖必须明确确认。
- 错误文件和原文已变化的行不会写入数据库。
- 本流程不需要 Key，也不产生 AI Token 记录。
