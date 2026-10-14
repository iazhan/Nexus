import { describe, expect, it } from 'vitest';
import {
  EDITOR_OPEN_MODE_DEFAULT,
  EDITOR_OPEN_MODE_OPTIONS,
  EDITOR_SURFACE_STORAGE_KEY,
  resolveEditorSurface
} from '../src/settings/preference-specs.js';

/**
 * 打开 Markdown 时进哪个面：**值域**那一层。
 *
 * 消费端的判据（`App.tsx` 的初值、`editor.surface` 的写回）由
 * `open-mode-app.test.tsx` 钉住；这里只管三件事：档位与面名的对应、
 * 「只认两个词」的兜底方向、以及选项必须有译文键。
 */

describe('打开模式：值域', () => {
  it('默认进富文本面', () => {
    // 打开一份 Markdown 十有八九是来看或改内容的；要写语法的人切一次源码、
    // 把这一项改成「记住上次模式」就固定下来了。
    expect(EDITOR_OPEN_MODE_DEFAULT).toBe('visual');
  });

  it('三个档位，各有一条译文键', () => {
    expect(EDITOR_OPEN_MODE_OPTIONS.map((option) => option.value)).toEqual([
      'visual',
      'source',
      'remember'
    ]);

    for (const option of EDITOR_OPEN_MODE_OPTIONS) {
      expect(option.labelKey).toBe(`settings.editor.openMode.${option.value}`);
    }
  });

  it('两个「始终」档直接按档位名回答', () => {
    // 值域与面名刻意取了同一组词 —— 少一层映射也就少一处可能对不上的地方。
    expect(resolveEditorSurface('visual', 'source')).toBe('visual');
    expect(resolveEditorSurface('source', 'visual')).toBe('source');
  });

  it('「记住上次」跟着上次走，一次都没记过就与默认档一致', () => {
    expect(resolveEditorSurface('remember', 'visual')).toBe('visual');
    expect(resolveEditorSurface('remember', 'source')).toBe('source');
    expect(resolveEditorSurface('remember', '')).toBe(EDITOR_OPEN_MODE_DEFAULT);
  });

  it('认不出的档位按「记住上次」处理 —— 一个坏字节不该把用户钉死在某个面上', () => {
    // 方向与「记住上次」同向：它是最宽容的那一档，落到它最不可能让用户觉得
    // 「这个开关坏了」。
    expect(resolveEditorSurface('到底', 'source')).toBe('source');
    expect(resolveEditorSurface('', 'visual')).toBe('visual');
    expect(resolveEditorSurface('', '')).toBe(EDITOR_OPEN_MODE_DEFAULT);
  });

  it('记住的那个面用独立存档键，不与档位键混', () => {
    // 两件事分开存：档位是设置项（设置页要显示），面是视图结果。
    // 用一个键存的话，「记住上次」会把自己的档位值写成面名，读回来判不出来。
    expect(EDITOR_SURFACE_STORAGE_KEY).toBe('nexus-editor-surface');
  });
});
