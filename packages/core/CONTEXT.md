# Core Package Context

## Domain
Shared definitions and global interfaces that must not depend on any other workspace package, so higher layers can depend on them without creating cycles.

## Responsibilities
- Define the application mode model (`AppMode`, `LaunchContext`) and the launch-argument parser (`parseLaunchArgs`).
- Define the file access contract exposed through the typed preload bridge (`FileDocument`, `FileWatchEvent`, `FileWatchListener`, `Unsubscribe`).
- Define the shared error type for the file service (`FileServiceError`, `FileServiceErrorCode`).

## Ubiquitous Language
- **AppMode**: The runtime mode the shell resolves from launch arguments. Only `lightweight` exists today; `viewer` and `workspace` are planned.
- **LaunchContext**: The resolved startup context (mode plus optional file path) shared between main and renderer.
- **FileDocument**: The result of opening a local file — normalized absolute path, UTF-8 content and an optional read-only flag.
- **FileWatchEvent**: A `changed` / `renamed` / `deleted` / `error` notification. Failures are surfaced as events rather than swallowed.
- **Unsubscribe**: The handle returned by `watchFile`; calling it stops the watch and releases the underlying watcher.
