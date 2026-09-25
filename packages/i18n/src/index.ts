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
    'codeBlock.copy': 'Copy',
    'codeBlock.copied': 'Copied!',
    'codeBlock.copyFailed': 'Failed',
    'codeBlock.copyAria': 'Copy code',
    'codeBlock.showSource': 'Source',
    'codeBlock.showPreview': 'Preview',
    'codeBlock.showSourceAria': 'Show source',
    'codeBlock.showPreviewAria': 'Show diagram',
    'status.loading': 'Loading...',
    'status.loadError': 'Load Error',
    'save.clean': 'Saved',
    'save.saved': 'Saved',
    'save.dirty': 'Unsaved',
    'save.saving': 'Saving...',
    'save.error': 'Save Error',
    'save.readonly': 'Read Only',
    'save.external-changed': 'Conflict',
    'save.deleted': 'Deleted',
    'mermaid.clickToReveal': 'Click diagram to show source',
    'status.lineColumn': 'Ln {line}, Col {column}',
    'status.selected': '{count} selected',
    'editor.dragHandle': 'Drag to reorder block',
    'editor.retry': 'Retry',
    'extensions.unavailable': 'Extension unavailable: {id}',
    'popover.save': 'Save',
    'popover.cancel': 'Cancel',
    'popover.linkText': 'Link Text',
    'popover.linkTextAria': 'Link text',
    'popover.linkDestination': 'Link Destination (URL)',
    'popover.linkUrlAria': 'Link URL',
    'popover.titleOptional': 'Title (optional)',
    'popover.linkTitleAria': 'Link title',
    'popover.imageTitleAria': 'Image title',
    'popover.linkRefDestinationHint': 'Reference link destination is defined elsewhere in the document.',
    'popover.linkRefDestinationAria': 'Link URL (Reference destination defined elsewhere)',
    'popover.linkRefTitleHint': 'Reference link title is defined elsewhere in the document.',
    'popover.linkRefTitleAria': 'Link title (Reference title defined elsewhere)',
    'popover.linkRefLabelHint': 'Shortcut or collapsed reference label cannot be edited locally without mutating reference identifier.',
    'popover.linkRefLabelAria': 'Link text (Reference identifier defined elsewhere)',
    'popover.imageAlt': 'Alt Text',
    'popover.imageAltAria': 'Image alt text',
    'popover.imageSource': 'Image Source (URL / path)',
    'popover.imageSourceAria': 'Image source',
    'popover.imageUpload': 'Upload / Replace...',
    'popover.imageRefSourceHint': 'Reference image source is defined elsewhere in the document.',
    'popover.imageRefSourceAria': 'Image source (Reference source defined elsewhere)',
    'popover.imageRefTitleHint': 'Reference image title is defined elsewhere in the document.',
    'popover.imageRefTitleAria': 'Image title (Reference title defined elsewhere)',
    'popover.imageRefAltHint': 'Shortcut or collapsed reference alt cannot be edited locally without mutating reference identifier.',
    'popover.imageRefAltAria': 'Image alt text (Reference identifier defined elsewhere)',
    'popover.codeValue': 'Code Value',
    'popover.codeValueAria': 'Inline code',
    'popover.wikiTarget': 'Target Page',
    'popover.wikiTargetAria': 'WikiLink target',
    'popover.wikiAlias': 'Alias (optional)',
    'popover.wikiAliasAria': 'WikiLink alias',
    'popover.invalidSyntax': 'Invalid syntax: cannot construct candidate node.',
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
    'codeBlock.copy': '复制',
    'codeBlock.copied': '已复制！',
    'codeBlock.copyFailed': '复制失败',
    'codeBlock.copyAria': '复制代码',
    'codeBlock.showSource': '源码',
    'codeBlock.showPreview': '预览',
    'codeBlock.showSourceAria': '显示源码',
    'codeBlock.showPreviewAria': '显示图表',
    'status.loading': '加载中…',
    'status.loadError': '加载失败',
    'save.clean': '已保存',
    'save.saved': '已保存',
    'save.dirty': '未保存',
    'save.saving': '保存中…',
    'save.error': '保存失败',
    'save.readonly': '只读',
    'save.external-changed': '冲突',
    'save.deleted': '已删除',
    'mermaid.clickToReveal': '点击图表显示源码',
    'status.lineColumn': '第 {line} 行，第 {column} 列',
    'status.selected': '已选 {count} 个字符',
    'editor.dragHandle': '拖动以重排块',
    'editor.retry': '重试',
    'extensions.unavailable': '扩展不可用：{id}',
    'popover.save': '保存',
    'popover.cancel': '取消',
    'popover.linkText': '链接文字',
    'popover.linkTextAria': '链接文字',
    'popover.linkDestination': '链接地址（URL）',
    'popover.linkUrlAria': '链接 URL',
    'popover.titleOptional': '标题（可选）',
    'popover.linkTitleAria': '链接标题',
    'popover.imageTitleAria': '图片标题',
    'popover.linkRefDestinationHint': '该引用式链接的地址定义在文档其它位置。',
    'popover.linkRefDestinationAria': '链接 URL（地址定义在别处）',
    'popover.linkRefTitleHint': '该引用式链接的标题定义在文档其它位置。',
    'popover.linkRefTitleAria': '链接标题（标题定义在别处）',
    'popover.linkRefLabelHint': '简写/折叠式引用的标签无法就地修改，否则会改动引用标识。',
    'popover.linkRefLabelAria': '链接文字（引用标识定义在别处）',
    'popover.imageAlt': '替代文字',
    'popover.imageAltAria': '图片替代文字',
    'popover.imageSource': '图片地址（URL / 路径）',
    'popover.imageSourceAria': '图片地址',
    'popover.imageUpload': '上传 / 替换…',
    'popover.imageRefSourceHint': '该引用式图片的地址定义在文档其它位置。',
    'popover.imageRefSourceAria': '图片地址（地址定义在别处）',
    'popover.imageRefTitleHint': '该引用式图片的标题定义在文档其它位置。',
    'popover.imageRefTitleAria': '图片标题（标题定义在别处）',
    'popover.imageRefAltHint': '简写/折叠式引用的替代文字无法就地修改，否则会改动引用标识。',
    'popover.imageRefAltAria': '图片替代文字（引用标识定义在别处）',
    'popover.codeValue': '代码内容',
    'popover.codeValueAria': '行内代码',
    'popover.wikiTarget': '目标页面',
    'popover.wikiTargetAria': 'WikiLink 目标',
    'popover.wikiAlias': '别名（可选）',
    'popover.wikiAliasAria': 'WikiLink 别名',
    'popover.invalidSyntax': '语法无效：无法构造目标节点。',
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
