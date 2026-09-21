# Mermaid Package Context

## Domain
Mermaid diagram rendering in CodeMirror.

## Responsibilities
- Parse ```mermaid``` blocks.
- Render SVG diagrams asynchronously.

## Ubiquitous Language
- **Async Widget**: Because Mermaid parsing is heavy, the widget typically displays a loading state before the SVG is fully rendered.