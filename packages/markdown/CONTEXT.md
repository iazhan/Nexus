# Markdown Package Context

## Domain
Source-aligned Markdown parsing, document model and serialization. This package has no CodeMirror dependency — editor surfaces live in `@nexus/editor`.

## Responsibilities
- Parse Markdown source into a block/inline AST whose nodes carry exact `SourceRange`s.
- Preserve raw/opaque nodes for unknown, unclosed or unsafe constructs.
- Serialize nodes back to Markdown without rewriting ranges the user did not edit.
- Provide the static render model and the URL sanitization contract used by editor projections.

## Ubiquitous Language
- **SourceRange**: The half-open `[from, to)` interval a node occupies in Markdown source.
- **Raw/Opaque Node**: Content that cannot be safely structured but must be preserved verbatim.
- **Serializer Contract**: Only ranges covered by the user's intent may be rewritten; everything else round-trips byte-for-byte.
