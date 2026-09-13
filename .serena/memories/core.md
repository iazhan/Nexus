# Nexus 项目核心

- 当前仓库仅有 Serena 项目元数据，暂无业务源代码、构建配置或既有文档。
- 产品目标：Nexus = Local-first Personal Knowledge OS；以用户可读文件为主、Markdown 为核心、知识库能力可选增强、云端用于同步而非唯一主存储。
- 主要产品模式：Lightweight Mode（单个 Markdown 文件快速打开）与 Workspace Mode（完整 Vault/知识库）。
- 架构蓝图基线保存于 `docs/nexus-architecture-blueprint.md`。
- 界面与交互设计基线保存于 `docs/nexus-ui-ux-blueprint.md`，涵盖三种运行模式、三栏工作台、响应式布局、状态、组件和无障碍验收。
- 第一阶段实施计划保存于 `docs/implementation-phase-1-markdown-editor.md`，目标是 Nexus Lite 单文件 Markdown 编辑器；后续协作采用 Prompt -> Agent 实施 -> 变更/测试证据 -> Review 流程。
- 第一份可交给外部实现 Agent 的 Prompt 保存于 `docs/prompts/P1-01-engineering-initialization.md`，范围是 Electron Shell 和 Lightweight Mode 启动上下文。
- 技术决策细节和后续实施边界以该蓝图为准；新增实现应避免把所有能力塞进核心包。
- 领域边界：Editor、Document、Knowledge、Persistence、Sync、Plugin、Theme/i18n、Desktop/Web Shell。
