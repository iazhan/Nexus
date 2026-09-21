export type Theme = 'light' | 'dark';
type Listener = (theme: Theme) => void;

export class ThemeManager {
  private currentTheme: Theme = 'light';
  private listeners: Set<Listener> = new Set();

  get theme(): Theme {
    return this.currentTheme;
  }

  setTheme(theme: Theme): void {
    if (this.currentTheme !== theme) {
      this.currentTheme = theme;
      this.notify();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.currentTheme);
    }
  }
}
