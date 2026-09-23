# Command Package Context

## Domain
Pure logic command registry. It stores command definitions and executes them by id; shortcut resolution and key dispatch live in the consuming app (`apps/desktop/renderer/src/shortcut.ts`), not here.

## Responsibilities
- Register commands and return an unsubscribe handle for dynamic registration.
- Look up a command by id and execute it.
- Expose the registered command list so menus, the command palette and keymaps share one definition.

## Ubiquitous Language
- **Command**: A registered action — `id`, `titleKey` (an i18n key, never a literal user-facing string), an optional `shortcut` such as `Mod-S`, and `execute`.
- **CommandRegistry**: The class holding `Command`s. It is instantiated by the caller, not a singleton.
- **Shortcut**: A key combination string using `Mod` for cross-platform bindings (Ctrl on Windows/Linux, Cmd on macOS).
