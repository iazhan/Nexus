type LocaleDictionary = Record<string, string>;

const dictionaries: Record<string, LocaleDictionary> = {
  'en-US': {
    'app.title': 'Nexus Editor',
    'file.unsupported': 'Unsupported format: {format}',
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.appearance': 'Appearance',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'lang.zhCN': 'Chinese',
    'lang.enUS': 'English',
    'cmd.newFile': 'New',
    'cmd.undo': 'Undo',
    'cmd.redo': 'Redo',
    'cmd.copy': 'Copy',
    'cmd.cut': 'Cut',
    'cmd.paste': 'Paste',
    'cmd.selectAll': 'Select All',
    'window.minimize': 'Minimize',
    'window.maximize': 'Maximize',
    'window.restore': 'Restore Down',
    'window.close': 'Close',
    'surface.toVisual': 'Switch to Visual (Mod-M)',
    'surface.toSource': 'Switch to Source (Mod-M)',
    'cmd.openFile': 'Open File',
    'cmd.save': 'Save',
    'cmd.saveAs': 'Save As',
    'cmd.toggleTheme': 'Toggle Theme',
    'cmd.toggleLocale': 'Toggle Language',
    'cmd.find': 'Find',
    'cmd.replace': 'Replace',
    'cmd.toggleSurface': 'Toggle Source/Visual',
    'cmd.openInWorkspace': 'Open in Workspace',
    'cmd.openContainingFolder': 'Open Containing Folder',
    'cmd.revealInFileExplorer': 'Reveal in File Explorer',
    'cmd.closeFile': 'Close File',
    'table.addRow': 'Add Row',
    'table.addColumn': 'Add Column',
    'table.deleteRow': 'Delete Row',
    'table.deleteColumn': 'Delete Column',
    'table.alignLeft': 'Align Left',
    'table.alignCenter': 'Align Center',
    'table.alignRight': 'Align Right',
    'table.resizeTable': 'Resize Table',
    'table.deleteTable': 'Delete Table',
    'table.btnRow': '+ Row',
    'table.btnCol': '+ Col',
    'table.btnDelRow': '- Row',
    'table.btnDelCol': '- Col',
    'table.btnResize': 'Resize',
    'table.btnDelete': 'Delete Table',
    'table.gridFooter': '{rows} rows × {cols} cols',
    'editor.editInlineMath': 'Edit inline formula source',
    'editor.editBlockMath': 'Edit block formula source',
  },
  'zh-CN': {
    'app.title': 'Nexus 编辑器',
    'file.unsupported': '不支持的格式: {format}',
    'menu.file': '文件',
    'menu.edit': '编辑',
    'menu.appearance': '外观',
    'theme.light': '亮色',
    'theme.dark': '暗色',
    'lang.zhCN': '中文',
    'lang.enUS': 'English',
    'cmd.newFile': '新建',
    'cmd.undo': '撤销',
    'cmd.redo': '重做',
    'cmd.copy': '复制',
    'cmd.cut': '剪切',
    'cmd.paste': '粘贴',
    'cmd.selectAll': '全选',
    'window.minimize': '最小化',
    'window.maximize': '最大化',
    'window.restore': '向下还原',
    'window.close': '关闭',
    'surface.toVisual': '切换到富文本 (Mod-M)',
    'surface.toSource': '切换到源码 (Mod-M)',
    'cmd.openFile': '打开文件',
    'cmd.save': '保存',
    'cmd.saveAs': '另存为',
    'cmd.toggleTheme': '切换主题',
    'cmd.toggleLocale': '切换语言',
    'cmd.find': '查找',
    'cmd.replace': '替换',
    'cmd.toggleSurface': '切换源码/富文本',
    'cmd.openInWorkspace': '在工作区中打开',
    'cmd.openContainingFolder': '打开所在文件夹',
    'cmd.revealInFileExplorer': '在文件管理器中显示',
    'cmd.closeFile': '关闭文件',
    'table.addRow': '添加行',
    'table.addColumn': '添加列',
    'table.deleteRow': '删除行',
    'table.deleteColumn': '删除列',
    'table.alignLeft': '左对齐',
    'table.alignCenter': '居中对齐',
    'table.alignRight': '右对齐',
    'table.resizeTable': '调整表格',
    'table.deleteTable': '删除整表',
    'table.btnRow': '+ 行',
    'table.btnCol': '+ 列',
    'table.btnDelRow': '- 行',
    'table.btnDelCol': '- 列',
    'table.btnResize': '调整',
    'table.btnDelete': '删除表格',
    'table.gridFooter': '{rows} 行 × {cols} 列',
    'editor.editInlineMath': '编辑行内公式源码',
    'editor.editBlockMath': '编辑块级公式源码',
  }
};

type Listener = (locale: string) => void;

export function translate(locale: string, key: string, variables?: Record<string, string>): string {
  const dict = dictionaries[locale] || dictionaries['en-US'];
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
    return translate(this.currentLocale, key, variables);
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
