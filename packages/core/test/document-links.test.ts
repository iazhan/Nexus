import { describe, it, expect } from 'vitest';
import {
  attachmentContentFingerprint,
  supportedDocumentExtensions,
  wikilinkCandidates
} from '../src/index.js';

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
