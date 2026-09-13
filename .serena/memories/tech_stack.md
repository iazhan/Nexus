# Nexus 技术栈基线

- 已确认的产品技术方向：Electron 桌面端 + Web 端，共享核心逻辑。
- 编辑器：CodeMirror 6；Markdown 双模式（Source/WYSIWYG）是核心能力。
- 建议的客户端本地存储：SQLite（桌面端）与 IndexedDB/浏览器缓存（Web 端）；本地文件仍是一等数据载体。
- 建议的云端：同步 API + PostgreSQL 元数据/操作日志 + S3/MinIO 对象存储。
- 内置扩展候选：Math（MathLive/LaTeX）、Mermaid、Excalidraw、PDF、DOCX、图片；外部扩展候选：Pandoc、PDF 提取、OCR、Zotero、AI。
- 版本、依赖和具体框架尚未落地；不要把上述建议当作已安装依赖或可直接运行的命令。
