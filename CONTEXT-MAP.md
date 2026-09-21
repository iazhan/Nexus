# Nexus Context Map

Nexus uses a multi-context architecture. Each package and application maintains its own domain knowledge and terminology in a local \CONTEXT.md\.

## Applications
- [Desktop App](./apps/desktop/CONTEXT.md) (\@nexus/desktop\): The main Electron desktop application, providing the lightweight/full modes, UI chrome, IPC bridge, and React entry point.

## Packages
- [Command](./packages/command/CONTEXT.md) (\@nexus/command\): Command registry and keybinding resolution.
- [Core](./packages/core/CONTEXT.md) (\@nexus/core\): Global shared types, interfaces, and base definitions.
- [Editor](./packages/editor/CONTEXT.md) (\@nexus/editor\): React wrappers and state management for the CodeMirror editor surfaces.
- [i18n](./packages/i18n/CONTEXT.md) (\@nexus/i18n\): Internationalization, locale management, and translation dictionaries.
- [Markdown](./packages/markdown/CONTEXT.md) (\@nexus/markdown\): The core CodeMirror 6 markdown extensions, syntax highlighting, and text state logic.
- [Math](./packages/math/CONTEXT.md) (\@nexus/math\): CodeMirror extension for KaTeX block/inline rendering.
- [Mermaid](./packages/mermaid/CONTEXT.md) (\@nexus/mermaid\): CodeMirror extension for Mermaid diagram rendering.
- [Theme](./packages/theme/CONTEXT.md) (\@nexus/theme\): Theme system, token management, and CSS variables injection.

