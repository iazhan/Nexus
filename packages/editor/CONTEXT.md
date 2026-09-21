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