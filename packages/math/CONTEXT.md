# Math Package Context

## Domain
KaTeX rendering for math blocks in CodeMirror.

## Responsibilities
- Parse `$$` and `$` blocks.
- Use `WidgetType` to replace or overlay the math source with a rendered KaTeX DOM node.
- Graceful degradation if KaTeX rendering fails.

## Ubiquitous Language
- **WidgetType**: CodeMirror mechanism to embed arbitrary DOM.
- **Decoration**: Metadata applied to ranges of text to inject Widgets.