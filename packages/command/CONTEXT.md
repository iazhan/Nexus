# Command Package Context

## Domain
Pure logic command registry and keybinding resolver.

## Responsibilities
- Registering global and scoped commands.
- Resolving shortcuts (e.g. `Mod-S`, `Mod-Shift-P`).
- Returning unsubscribe handles for dynamic registration.

## Ubiquitous Language
- **CommandRegistry**: The central singleton/class holding `CommandDefinition`s.
- **Shortcut**: A key combination string, utilizing `Mod` for cross-platform (Ctrl on Win/Linux, Cmd on Mac).