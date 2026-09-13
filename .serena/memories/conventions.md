# Nexus 约定

- 以领域边界组织架构，优先保持 Editor、Knowledge、Sync、Plugin 等模块低耦合。
- Core 只放稳定基础能力；Math/LaTeX、Mermaid、Excalidraw、PDF/DOCX 等以官方内置插件或 extension 交付，按内容检测和运行模式懒加载。
- 插件通过受版本管理的 Nexus API/manifest/command/event 契约接入，不直接依赖 UI 内部实现。
- Markdown、附件和用户文件保持可导出/可迁移；索引、缓存、同步状态属于可重建派生数据。
- 源码模式保留原始 Markdown；WYSIWYG 负责渲染和编辑扩展节点，不能成为唯一事实源。
- 主题使用 token -> CSS variables -> UI/CodeMirror/内容渲染的映射；预设与用户自定义主题共用同一模型。
- 所有用户可见字符串走 i18n；命令面板和快捷键基于 command registry，不在组件中散落绑定。
