# Editor Package Context

## Domain
React bindings and UI state management for CodeMirror 6.

## Responsibilities
- Provide `<EditorSurface>` React components.
- Bridge React lifecycle with CodeMirror `EditorView` initialization and destruction.
- Abstract the `NexusSession` which holds the headless `EditorState` independent of the DOM.

## Ubiquitous Language
- **EditorSurface**: The React component bridging DOM to CodeMirror `EditorView`.
- **NexusSession**: A headless model holding the document state (`EditorState`), allowing multiple surfaces to share or swap the same document logic.
- **SurfaceKind**: `source` (Markdown) or `visual` (WYSIWYG/Rich Text).
- **HybridVisualProjection**: The multi-tiered rendering strategy combining line-level decoration streams for code/quotes with rich block-level widgets for tables/diagrams.
- **LineDecorationStream**: Line-level and mark-level decorations applied directly to contiguous editor lines, preserving native cursor, selection, and history.
- **BlockWidgetIsland**: Self-contained block-level widgets representing 2D structured content (e.g. Table) or dynamic diagrams (e.g. Mermaid).
- **RevealPolicy**: The rules governing when Markdown source delimiters are revealed upon cursor entry and collapsed upon exit.
  _Avoid_: SubEditor (deprecated pattern of mounting detached input/textarea overlays).