# Windows 便携版

## 使用方法

1. 完整解压 `RSS-Reading_*_Windows-x64_Portable.zip`。
2. 双击 `RSS Reading.exe`，无需安装。
3. 不要只复制 EXE；同目录下的 `resources` 文件夹是部分功能需要的程序资源。

## 数据保存

便携版仍将数据库和设置保存在当前 Windows 用户的应用数据目录，而不是 ZIP 或 EXE 所在目录。安装版与便携版使用相同的应用标识，因此同一 Windows 用户下可读取原有订阅、文献、检索和设置。

卸载或删除便携版程序不会自动删除用户数据。更换电脑时，请先在软件中导出需要迁移的数据。

## 运行要求

- 支持 64 位 Windows 10/11。
- 系统需要 Microsoft Edge WebView2 Runtime。正常更新的 Windows 10/11 通常已自带；精简系统若无法启动，需要先从微软安装 WebView2 Runtime。
- 软件界面和数据库在本机运行；PubMed、PMC、RSS 抓取、AI 翻译和更新检查等功能仍需要网络。

发布页同时提供 `.sha256` 文件，可用于核对 ZIP 下载是否完整。
