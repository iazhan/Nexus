# Desktop App Context

## Domain
The Electron-based desktop shell for Nexus.

## Responsibilities
- **Main Process**: File system operations (atomic write, read, watch), IPC channel registration, window management (Lightweight vs Full mode).
- **Renderer Process**: React entry point (`App.tsx`), UI chrome (Status Bar, Tab Bar, Command Palette modal), handling React state and coordinating packages.
- **Harness**: E2E Smoke test framework using Playwright over CDP.

## Ubiquitous Language
- **Lightweight Mode (轻量模式)**: Single-window, single-document mode without the sidebar vault.
- **Save State**: The lifecycle state of a document (`clean`, `dirty`, `saving`, `saved`, `error`, `external-changed`, `readonly`).
- **Atomic Write**: Using temp files and rename to ensure data integrity during saves.
- **CDP (Chrome DevTools Protocol)**: Used by `smoke-harness` to dispatch raw events bypassing synthetic wrappers.