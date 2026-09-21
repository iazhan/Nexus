# Theme Package Context

## Domain
Design token management and dynamic CSS variable injection.

## Responsibilities
- Maintain predefined theme definitions (Light/Dark).
- Inject CSS variables (`--nexus-*`) into the root DOM.
- Bridge React UI tokens and CodeMirror `EditorView.theme`.

## Ubiquitous Language
- **Semantic Token**: e.g., `--nexus-bg-canvas`, used in UI instead of absolute hex codes.
- **ThemeManager**: Singleton that applies CSS variable changes to the DOM instantly, bypassing React renders for 60fps live previews.