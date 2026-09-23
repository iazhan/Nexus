# Editor Package Context

## Domain
Headless editor core for CodeMirror 6: document session, surface coordination, source-range edit transactions and visual projection. This package has no React dependency — the React binding (`EditorSurface`) lives in `apps/desktop/renderer/src/editor/SourceEditor.tsx`.

## Responsibilities
- Own canonical Markdown source through `MarkdownDocumentSession` (revision, selection, undo/redo).
- Create session-backed Source/Visual surfaces via `createSessionEditorView` / `createSessionEditorState`.
- Normalize every user intent into a source-range edit transaction and map selections across surfaces.
- Project Markdown into a visual surface using decorations, widgets and block interaction.
- Provide marker detection, extension host, clipboard, IME, drag and table/code/special-block commands.

## Ubiquitous Language
- **MarkdownDocumentSession**: The headless model holding canonical source, revision, selection and history, letting multiple surfaces share or swap the same document logic.
  _Avoid_: NexusSession (no longer exists), SubEditor (deprecated pattern of mounting detached input/textarea overlays).
- **EditorSurface**: The React component bridging DOM to CodeMirror `EditorView`. Defined in the desktop renderer, not in this package.
- **SurfaceKind**: `source` (Markdown) or `visual` (WYSIWYG/Rich Text).
- **HybridVisualProjection**: The multi-tiered rendering strategy combining line-level decoration streams for code/quotes with rich block-level widgets for tables/diagrams (see ADR-0001).
- **LineDecorationStream**: Line-level and mark-level decorations applied directly to contiguous editor lines, preserving native cursor, selection, and history.
- **BlockWidgetIsland**: Self-contained block-level widgets representing 2D structured content (e.g. Table) or dynamic diagrams (e.g. Mermaid).
- **RevealPolicy**: The rules governing when Markdown source delimiters are revealed upon cursor entry and collapsed upon exit.
