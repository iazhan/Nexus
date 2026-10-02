import { describe, it, expect } from 'vitest';
import {
  attachmentContentFingerprint,
  missingTargetToWorkspacePath,
  normalizeWikilinkTarget,
  splitWikilinkAnchor,
  supportedDocumentExtensions,
  wikilinkCandidates
} from '../src/index.js';

/**
 * 锚点切分与目标归一化。
 *
 * 这两件事是同一个洞的两半：写进 `links` 表的目标名必须是「切掉锚点之后」的，
 * 否则反向链接侧拿 `dma` 去比 `dma#性能`，永远匹配不上 —— 而两边单独看都对。
 * 所以正反两面都要守：切得掉锚点，且**没锚点时一个字符都不动**。
 */
describe('锚点切分与 wikilink 目标归一化', () => {
  describe('splitWikilinkAnchor', () => {
    it('把锚点从目标里切出来', () => {
      expect(splitWikilinkAnchor('dma#性能')).toEqual({ path: 'dma', anchor: '性能' });
      expect(splitWikilinkAnchor('notes/dma#性能')).toEqual({
        path: 'notes/dma',
        anchor: '性能'
      });
    });

    it('没有锚点时 path 原样、anchor 为 null', () => {
      expect(splitWikilinkAnchor('dma')).toEqual({ path: 'dma', anchor: null });
      expect(splitWikilinkAnchor('notes/dma.md')).toEqual({
        path: 'notes/dma.md',
        anchor: null
      });
    });

    it('只切第一个 `#` —— 后面整段都是锚点', () => {
      expect(splitWikilinkAnchor('dma#a#b').anchor).toBe('a#b');
    });

    it('空锚点算没有锚点', () => {
      expect(splitWikilinkAnchor('dma#')).toEqual({ path: 'dma', anchor: null });
      expect(splitWikilinkAnchor('dma#   ')).toEqual({ path: 'dma', anchor: null });
    });

    it('只有锚点（文档内链接）时 path 是空串 —— 收不收由调用方决定', () => {
      expect(splitWikilinkAnchor('#性能')).toEqual({ path: '', anchor: '性能' });
    });

    it('`#` 前面的空白不归锚点管', () => {
      expect(splitWikilinkAnchor('dma #性能').path).toBe('dma ');
    });
  });

  describe('normalizeWikilinkTarget', () => {
    it('切锚点、去 .md、转小写', () => {
      expect(normalizeWikilinkTarget('DMA.md')).toBe('dma');
      expect(normalizeWikilinkTarget('DMA#性能')).toBe('dma');
    });

    it('扩展名在锚点之前 —— 先切锚点再去 .md，顺序换不得', () => {
      // 先按 `$` 去 `.md` 的话，`dma.md#性能` 里的 `.md` 不在末尾，一个字符都去不掉，
      // 库里就会存下 `dma.md#性能`。
      expect(normalizeWikilinkTarget('dma.md#性能')).toBe('dma');
    });

    it('只去 .md，不动其它扩展名 —— 附件引用要保持可区分', () => {
      expect(normalizeWikilinkTarget('stm32.pdf')).toBe('stm32.pdf');
      expect(normalizeWikilinkTarget('stm32.pdf#page=342')).toBe('stm32.pdf');
    });

    it('没有锚点时结果与切分之前完全一致', () => {
      expect(normalizeWikilinkTarget('  Notes/DMA.md  ')).toBe('notes/dma');
      expect(normalizeWikilinkTarget('   ')).toBe('');
    });
  });
});

/**
 * 断链 → 可以新建的工作区相对路径。
 *
 * 这一层决定「点图谱上的断链节点会建出什么」。判据是**不该建的时候必须返回 null**：
 * 建错比不建更糟 —— 链接会看起来通了、指向的却是一篇空笔记。
 */
describe('missingTargetToWorkspacePath', () => {
  it('短名补上 .md', () => {
    expect(missingTargetToWorkspacePath('dma')).toBe('dma.md');
  });

  it('路径形式保留目录', () => {
    expect(missingTargetToWorkspacePath('notes/dma')).toBe('notes/dma.md');
  });

  it('已经写了 Markdown 扩展名的原样用，不叠加', () => {
    expect(missingTargetToWorkspacePath('dma.md')).toBe('dma.md');
    expect(missingTargetToWorkspacePath('notes/dma.markdown')).toBe('notes/dma.markdown');
  });

  it('带附件扩展名的一律不建 —— 缺的是附件，不是笔记', () => {
    // 建一个 `stm32.pdf.md` 会让 `[[stm32.pdf]]` 看起来通了，指向的却是一篇空笔记
    expect(missingTargetToWorkspacePath('stm32.pdf')).toBeNull();
    expect(missingTargetToWorkspacePath('assets/logo.png')).toBeNull();
    expect(missingTargetToWorkspacePath('manual.docx')).toBeNull();
  });

  it('点号不是扩展名时照样补 .md', () => {
    // `.2` 不在白名单里 —— `v1.2` 仍然是个短名，与 wikilinkCandidates 同一条判据
    expect(missingTargetToWorkspacePath('v1.2')).toBe('v1.2.md');
  });

  it('拒绝逃出工作区的路径', () => {
    expect(missingTargetToWorkspacePath('../outside')).toBeNull();
    expect(missingTargetToWorkspacePath('notes/../../outside')).toBeNull();
  });

  it('前导斜杠被当成「工作区根」，不是文件系统根', () => {
    // 空路径段会被丢掉，于是 `/dma` 与 `dma` 等价 —— 两者都在工作区里，安全
    expect(missingTargetToWorkspacePath('/dma')).toBe('dma.md');
  });

  it('空目标返回 null', () => {
    expect(missingTargetToWorkspacePath('')).toBeNull();
    expect(missingTargetToWorkspacePath('   ')).toBeNull();
    expect(missingTargetToWorkspacePath('/')).toBeNull();
  });
});

describe('Wikilink candidates and attachment fingerprints', () => {
  describe('wikilinkCandidates', () => {
    it('tries the bare name first, then every whitelisted extension in whitelist order', () => {
      const candidates = wikilinkCandidates('stm32');

      expect(candidates[0]).toBe('stm32');
      // `.md` 必须排在附件扩展名之前 —— 同名共存时 `[[stm32]]` 归 Markdown，
      // 这条优先级是契约（见 P3-04 的实施记录），不是实现细节。
      expect(candidates.indexOf('stm32.md')).toBeLessThan(candidates.indexOf('stm32.pdf'));
      expect(candidates).toContain('stm32.markdown');
      expect(candidates).toContain('stm32.docx');
      expect(candidates).toHaveLength(1 + supportedDocumentExtensions().length);
    });

    it('does not stack extensions when the target already carries one', () => {
      // `[[stm32.pdf]]` 是精确引用，不该生成 `stm32.pdf.md` 这种候选
      expect(wikilinkCandidates('stm32.pdf')).toEqual(['stm32.pdf']);
      expect(wikilinkCandidates('notes/a.markdown')).toEqual(['notes/a.markdown']);
      expect(wikilinkCandidates('PIC.PNG')).toEqual(['pic.png']);
    });

    it('keeps expanding names whose dot is not a whitelisted extension', () => {
      // `v1.2` 里的 `.2` 不在白名单 —— 它仍然是个短名，要能指向 `v1.2.md`。
      // 判据若是「含点就不展开」，这条会静默失效。
      const candidates = wikilinkCandidates('v1.2');

      expect(candidates).toContain('v1.2');
      expect(candidates).toContain('v1.2.md');
    });

    it('is case insensitive and trims the target', () => {
      expect(wikilinkCandidates('  STM32  ')[0]).toBe('stm32');
    });

    it('returns nothing for an empty target', () => {
      expect(wikilinkCandidates('')).toEqual([]);
      expect(wikilinkCandidates('   ')).toEqual([]);
    });
  });

  describe('attachmentContentFingerprint', () => {
    it('is deterministic for the same stat', () => {
      expect(attachmentContentFingerprint(1024, 1700000000000)).toBe(
        attachmentContentFingerprint(1024, 1700000000000)
      );
    });

    it('changes when size or mtime changes', () => {
      const base = attachmentContentFingerprint(1024, 1700000000000);

      expect(attachmentContentFingerprint(2048, 1700000000000)).not.toBe(base);
      expect(attachmentContentFingerprint(1024, 1700000000001)).not.toBe(base);
    });

    it('truncates fractional milliseconds so the value is stable', () => {
      // node 的 mtimeMs 是浮点。不取整的话，同一个文件在不同读取路径下可能算出
      // 不同指纹，于是「删库重建」就不再等价 —— 那正是索引层最不能破的不变量。
      expect(attachmentContentFingerprint(10, 1234.56)).toBe(
        attachmentContentFingerprint(10, 1234.99)
      );
    });
  });
});
