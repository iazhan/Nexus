import { describe, it, expect } from 'vitest';
import { ProcessorRegistry, type DocumentProcessor, type ProcessorResult } from '../src/index.js';

/** 一个可控的处理器：`result` 可以是结果，也可以是抛出的异常。 */
function processor(
  id: string,
  documentTypes: DocumentProcessor['documentTypes'],
  behavior: ProcessorResult | Error
): DocumentProcessor {
  return {
    id,
    documentTypes,
    extract: async () => {
      if (behavior instanceof Error) throw behavior;
      return behavior;
    }
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('ProcessorRegistry', () => {
  describe('注册', () => {
    it('按注册顺序列出处理器', () => {
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'extracted', text: 'a' }));
      registry.register(processor('docx', ['docx'], { status: 'extracted', text: 'b' }));

      expect(registry.list().map((item) => item.id)).toEqual(['pdf', 'docx']);
    });

    it('拒绝重复的 id', () => {
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'empty', text: '' }));

      expect(() =>
        registry.register(processor('pdf', ['image'], { status: 'empty', text: '' }))
      ).toThrow(/id 重复/);
    });

    it('拒绝两个处理器认领同一个类型', () => {
      // 覆盖会静默生效、忽略会静默失效，两种都难查 —— 所以在装配期直接抛。
      const registry = new ProcessorRegistry();
      registry.register(processor('first', ['pdf'], { status: 'empty', text: '' }));

      expect(() =>
        registry.register(processor('second', ['pdf'], { status: 'empty', text: '' }))
      ).toThrow(/已被处理器 first 认领/);
    });

    it('一个处理器认领多个类型时，撞车也算撞车', () => {
      const registry = new ProcessorRegistry();
      registry.register(processor('docx', ['docx'], { status: 'empty', text: '' }));

      expect(() =>
        registry.register(processor('multi', ['pdf', 'docx'], { status: 'empty', text: '' }))
      ).toThrow(/docx/);
    });

    it('id 撞车时不会留下半个注册（byType 未被写入）', () => {
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'empty', text: '' }));

      expect(() =>
        registry.register(processor('pdf', ['docx'], { status: 'empty', text: '' }))
      ).toThrow();

      // 抛在写 byId 之前，所以 docx 仍然空着 —— 没有「注册失败但类型被占了」
      expect(registry.find('docx')).toBeNull();
    });
  });

  describe('查找', () => {
    it('按类型找到认领它的处理器', () => {
      const registry = new ProcessorRegistry();
      const pdf = processor('pdf', ['pdf'], { status: 'empty', text: '' });
      registry.register(pdf);

      expect(registry.find('pdf')).toBe(pdf);
    });

    it('没有处理器时返回 null，而不是抛错', () => {
      // 「这个类型没有处理器」是正常情况（图片、Markdown），不是异常
      const registry = new ProcessorRegistry();
      expect(registry.find('image')).toBeNull();
      expect(registry.find('markdown')).toBeNull();
      expect(registry.find(null)).toBeNull();
      expect(registry.find(undefined)).toBeNull();
    });
  });

  describe('提取', () => {
    it('把处理器的结果原样透出', async () => {
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'extracted', text: '正文' }));

      await expect(registry.extract('pdf', { relativePath: 'a.pdf', bytes: bytes('') })).resolves.toEqual({
        status: 'extracted',
        text: '正文'
      });
    });

    it('没有处理器时返回 none', async () => {
      const registry = new ProcessorRegistry();
      await expect(
        registry.extract('image', { relativePath: 'a.png', bytes: bytes('') })
      ).resolves.toEqual({ status: 'none', text: '' });
    });

    it('把抛出的异常收成 failed，并带上消息', async () => {
      // 调用方是索引器，一次要处理成百上千个附件 ——
      // 一个坏文件不该让整次索引失败。
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], new Error('坏的 xref')));

      const outcome = await registry.extract('pdf', { relativePath: 'a.pdf', bytes: bytes('') });
      expect(outcome.status).toBe('failed');
      expect(outcome.text).toBe('');
      expect(outcome.message).toBe('坏的 xref');
    });

    it('非 Error 的抛出也收得住', async () => {
      const registry = new ProcessorRegistry();
      registry.register({
        id: 'pdf',
        documentTypes: ['pdf'],
        extract: async () => {
          throw '字符串异常';
        }
      });

      const outcome = await registry.extract('pdf', { relativePath: 'a.pdf', bytes: bytes('') });
      expect(outcome).toEqual({ status: 'failed', text: '', message: '字符串异常' });
    });

    it('把「声称 extracted 但文本为空」降成 empty', async () => {
      // 这是注册表唯一一处替处理器做的归一化：让下游只看 status 就够，
      // 不必再写 `status === 'extracted' && text.length > 0` 这种两处判据。
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'extracted', text: '' }));

      await expect(
        registry.extract('pdf', { relativePath: 'a.pdf', bytes: bytes('') })
      ).resolves.toEqual({ status: 'empty', text: '' });
    });

    it('处理器报 empty 但给了文本时，不把文本丢掉', async () => {
      // 与上一条相反的方向：status 是处理器说的，text 也是。
      // 这里不做「反向修正」—— 只保证「extracted 必然有文本」这一条不变量。
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'empty', text: '意外有字' }));

      await expect(
        registry.extract('pdf', { relativePath: 'a.pdf', bytes: bytes('') })
      ).resolves.toEqual({ status: 'empty', text: '意外有字' });
    });

    it('扫描版 PDF 的形态：处理器不抛错，只报 empty', async () => {
      const registry = new ProcessorRegistry();
      registry.register(processor('pdf', ['pdf'], { status: 'empty', text: '' }));

      const outcome = await registry.extract('pdf', { relativePath: 'scan.pdf', bytes: bytes('') });
      expect(outcome.status).toBe('empty');
      expect(outcome.message).toBeUndefined();
    });
  });
});
