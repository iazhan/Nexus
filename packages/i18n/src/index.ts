type LocaleDictionary = Record<string, string>;

const dictionaries: Record<string, LocaleDictionary> = {
  'en-US': {
    'app.title': 'Nexus Editor',
    'file.unsupported': 'Unsupported format: {format}',
    'cmd.openFile': 'Open File',
    'cmd.save': 'Save',
    'cmd.saveAs': 'Save As',
    'cmd.toggleTheme': 'Toggle Theme',
    'cmd.find': 'Find',
    'cmd.replace': 'Replace',
    'cmd.toggleSurface': 'Toggle Source/Visual',
  },
  'zh-CN': {
    'app.title': 'Nexus 编辑器',
    'file.unsupported': '不支持的格式: {format}',
    'cmd.openFile': '打开文件',
    'cmd.save': '保存',
    'cmd.saveAs': '另存为',
    'cmd.toggleTheme': '切换主题',
    'cmd.find': '查找',
    'cmd.replace': '替换',
    'cmd.toggleSurface': '切换源码/富文本',
  }
};

type Listener = (locale: string) => void;

export class LocaleManager {
  private currentLocale = 'en-US';
  private listeners: Set<Listener> = new Set();

  get locale(): string {
    return this.currentLocale;
  }

  setLocale(locale: string): void {
    if (this.currentLocale !== locale && dictionaries[locale]) {
      this.currentLocale = locale;
      this.notify();
    }
  }

  t(key: string, variables?: Record<string, string>): string {
    const dict = dictionaries[this.currentLocale] || dictionaries['en-US'];
    let str = dict?.[key];
    if (str === undefined) {
      str = dictionaries['en-US']?.[key];
    }
    if (str === undefined) {
      return key;
    }

    if (variables) {
      return str.replace(/\{(\w+)\}/g, (match, p1) => {
        return variables[p1] ?? match;
      });
    }

    return str;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.currentLocale);
    }
  }
}
