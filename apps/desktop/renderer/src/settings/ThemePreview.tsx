import React, { useEffect, useRef } from 'react';
import { createSourceEditorView } from '@nexus/editor';
import { useLocale } from '../hooks.js';

/**
 * 实时预览。**只用真组件与真类名** —— 按钮复用的是设置页的 `.nexus-settings-option`、输入框复用
 * 命令面板的 `.nexus-command-palette-input`、代码块是**真的 CodeMirror 视图**（`createSourceEditorView`
 * 建一个只读实例）。
 *
 * 为什么不能用色块拼一个：预览的样式一旦是另抄一份，它就会与真组件漂移，而漂移只有肉眼能发现。
 * 复用同一个类名 + 同一个编辑器工厂，预览就是「真实界面的一小块」。
 *
 * CodeMirror 视图只需建一次：`getEditorTheme()` 产出的是 `var(--nexus-*)`，变量值一变 CSS 自己
 * 就重算了，不需要重建视图。
 */

const SAMPLE = [
  '# Nexus',
  '',
  '**强调**与 *斜体*，行内 `code`，还有 [链接](https://example.com)。',
  '',
  '```ts',
  'const theme = defineTheme({ base0D: palette.blue });',
  'export default theme;',
  '```',
  '',
  '> 引用块用的是 `bg-quote`。',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| accent | `accent-solid` |'
].join('\n');

const CodePreview: React.FC = () => {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = createSourceEditorView({
      parent: host,
      doc: SAMPLE,
      readOnly: true,
      includeHistory: false
    });
    return () => view.destroy();
  }, []);

  return <div className="nexus-theme-preview-code" ref={hostRef} data-theme-preview-code="" />;
};

export const ThemePreview: React.FC = () => {
  const { t } = useLocale();

  return (
    <aside className="nexus-theme-preview" data-theme-preview="" aria-label={t('theme.preview.title')}>
      <span className="nexus-theme-preview-title">{t('theme.preview.title')}</span>

      <div className="nexus-theme-preview-row">
        <button type="button" className="nexus-settings-option nexus-settings-option-active">
          {t('theme.preview.button')}
        </button>
        <button type="button" className="nexus-settings-option">
          {t('theme.preview.buttonGhost')}
        </button>
      </div>

      <input
        className="nexus-command-palette-input nexus-theme-preview-input"
        placeholder={t('cmd.placeholder')}
        readOnly
        data-theme-preview-input=""
      />

      <div className="nexus-theme-preview-status" data-status="warning">
        {t('theme.preview.warning')}
      </div>
      <div className="nexus-theme-preview-status" data-status="error">
        {t('theme.preview.error')}
      </div>

      <p className="nexus-theme-preview-paragraph">
        {t('theme.preview.selectionBefore')}
        <span className="nexus-theme-preview-selection">{t('theme.preview.selection')}</span>
        {t('theme.preview.selectionAfter')}
      </p>

      <CodePreview />
    </aside>
  );
};
