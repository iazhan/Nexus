import React, { useRef, useState } from 'react';
import type { Base16Error } from '@nexus/theme';
import { useLocale } from '../hooks.js';
import {
  currentChoice,
  exportActiveTheme,
  importBase16Text,
  revertImport,
  type ImportOutcome
} from './theme-transfer.js';

/**
 * 主题的导入 / 导出。导入是**换掉 16 个种子**，之后一切照走派生管线 —— 文件里的 token 颜色
 * 不采信（见 `theme-transfer.ts`）。
 *
 * 两条交互上的硬要求：
 *
 * - **导入成功后立刻切过去，并给一次撤销**。导入了不切等于「什么都没发生」；不能撤销则用户
 *   试一个主题就得去翻存档。
 * - **修正结果要说出来**。导入的种子对比度不可控，派生会自动修正一部分 token —— 不说的话
 *   用户拿到的配色与文件里那套有出入，而他不知道为什么。
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'ok'; outcome: Extract<ImportOutcome, { ok: true }>; previous: string }
  | { kind: 'error'; error: Base16Error }
  | { kind: 'exported'; fileName: string; droppedOverrides: number };

function errorText(t: (key: string, vars?: Record<string, string>) => string, error: Base16Error): string {
  switch (error.code) {
    case 'empty':
      return t('theme.import.error.empty');
    case 'not-a-scheme':
      return t('theme.import.error.format');
    case 'missing-slots':
      return t('theme.import.error.missing', { slots: error.slots.join(', ') });
    case 'invalid-colour':
      return t('theme.import.error.colour', { slot: error.slot, value: error.value });
  }
}

/** Blob + 一个临时 `<a download>`：`file://` 下 `navigator.clipboard` 不保证可用，下载则到处都行。 */
function download(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让下载拿不到数据 —— 让浏览器先把 URL 解析掉。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const ThemeTransfer: React.FC = () => {
  const { t } = useLocale();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const runImport = async (text: string, fallbackName: string): Promise<void> => {
    const previous = currentChoice();
    const outcome = importBase16Text(text, fallbackName);
    setStatus(outcome.ok ? { kind: 'ok', outcome, previous } : { kind: 'error', error: outcome.error });
  };

  const takeFiles = async (files: FileList | null): Promise<void> => {
    const file = files?.[0];
    if (!file) return;
    // 文件名去掉扩展名当兜底名字 —— 文件里没写 `name` 时至少有个认得出的标签。
    await runImport(await file.text(), file.name.replace(/\.[^.]+$/, ''));
  };

  const runExport = (format: 'yaml' | 'json'): void => {
    const result = exportActiveTheme(format);
    if (!result) return;
    download(result.fileName, result.text, format === 'json' ? 'application/json' : 'text/yaml');
    setStatus({
      kind: 'exported',
      fileName: result.fileName,
      droppedOverrides: result.droppedOverrides
    });
  };

  return (
    <section
      className="nexus-theme-transfer"
      data-theme-transfer=""
      data-drop-active={dropping}
      onDragOver={(event) => {
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        void takeFiles(event.dataTransfer?.files ?? null);
      }}
    >
      <span className="nexus-settings-field-label">{t('theme.transfer.title')}</span>
      <p className="nexus-settings-field-description">{t('theme.transfer.description')}</p>

      <div className="nexus-theme-transfer-row">
        <button
          type="button"
          className="nexus-settings-option"
          data-theme-import-button=""
          onClick={() => fileRef.current?.click()}
        >
          {t('theme.transfer.import')}
        </button>
        <button
          type="button"
          className="nexus-settings-option"
          data-theme-export="yaml"
          onClick={() => runExport('yaml')}
        >
          {t('theme.transfer.exportYaml')}
        </button>
        <button
          type="button"
          className="nexus-settings-option"
          data-theme-export="json"
          onClick={() => runExport('json')}
        >
          {t('theme.transfer.exportJson')}
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".yaml,.yml,.json,text/yaml,application/json"
        className="nexus-theme-transfer-file"
        data-theme-import=""
        onChange={(event) => {
          void takeFiles(event.target.files);
          // 清空 value，同一个文件连续选两次也要触发 change。
          event.target.value = '';
        }}
      />

      {status.kind === 'ok' && (
        <p className="nexus-theme-transfer-status" data-status="ok" data-theme-transfer-status="">
          {t('theme.import.ok', { name: status.outcome.name })}
          {/* 零修正不提 —— 常驻一条「0 项被调整」是噪音，用户会开始忽略这条提示。 */}
          {status.outcome.corrections > 0 &&
            ` ${t('theme.import.corrected', { count: String(status.outcome.corrections) })}`}
          <button
            type="button"
            className="nexus-theme-link"
            data-theme-import-undo=""
            onClick={() => {
              revertImport(status.previous);
              setStatus({ kind: 'idle' });
            }}
          >
            {t('theme.import.undo')}
          </button>
        </p>
      )}

      {status.kind === 'error' && (
        <p className="nexus-theme-transfer-status" data-status="error" data-theme-transfer-status="">
          {errorText(t, status.error)}
        </p>
      )}

      {status.kind === 'exported' && (
        <p className="nexus-theme-transfer-status" data-status="ok" data-theme-transfer-status="">
          {t('theme.export.ok', { name: status.fileName })}
          {status.droppedOverrides > 0 &&
            ` ${t('theme.export.dropped', { count: String(status.droppedOverrides) })}`}
        </p>
      )}
    </section>
  );
};
