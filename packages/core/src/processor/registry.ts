import type { DocumentType } from '../document/types.js';
import type {
  DocumentProcessor,
  ProcessorExtractInput,
  ProcessorOutcome
} from './types.js';

/**
 * 轻量处理器注册表（Phase 3 / P3-10）。
 *
 * 不用 `ExtensionHost`：见 `types.ts` 里 `DocumentProcessor` 的说明。
 *
 * 做成类而不是几个函数，是因为「谁认领了哪个类型」这份状态必须只有一份 —— 两个模块
 * 各自 `new` 一个、各自注册一半，症状是「有的类型能提、有的不能」，而两边单看都是对的。
 *
 * 不做发现 / 启停 / 隔离：那三件事属于 Phase 5 的插件系统，Phase 3 的处理器都是仓库
 * 自己的代码，注册进来就是启用。
 */
export class ProcessorRegistry {
  private readonly byId = new Map<string, DocumentProcessor>();
  private readonly byType = new Map<DocumentType, DocumentProcessor>();

  /**
   * 注册一个处理器。id 重复或类型撞车**立即抛错**，不覆盖也不忽略 ——
   * 这两件事都只发生在装配期（进程启动、测试 setup），抛错不会炸在用户操作中途。
   */
  register(processor: DocumentProcessor): void {
    if (this.byId.has(processor.id)) {
      throw new Error(`处理器 id 重复：${processor.id}`);
    }

    for (const documentType of processor.documentTypes) {
      const existing = this.byType.get(documentType);
      if (existing !== undefined) {
        throw new Error(
          `文档类型 ${documentType} 已被处理器 ${existing.id} 认领，${processor.id} 不能再认领`
        );
      }
    }

    this.byId.set(processor.id, processor);
    for (const documentType of processor.documentTypes) {
      this.byType.set(documentType, processor);
    }
  }

  /** 已注册的处理器，**按注册顺序**。 */
  list(): readonly DocumentProcessor[] {
    return [...this.byId.values()];
  }

  /** 认领了该类型的处理器；没有则返回 `null`（「没处理器」是正常情况，不抛错）。 */
  find(documentType: DocumentType | null | undefined): DocumentProcessor | null {
    if (documentType === null || documentType === undefined) return null;
    return this.byType.get(documentType) ?? null;
  }

  /**
   * 跑一次提取，**永不抛错** —— 处理器抛的异常在这里收成 `failed`。
   *
   * 调用方是索引器，一次要处理成百上千个附件，一个损坏的 PDF 不该让整次索引失败
   * （与索引器「单个文件读不动就记一条 error 继续」同一口径）。
   *
   * 顺带一处归一化：报告 `extracted` 却给了空串是自相矛盾的，统一降成 `empty`，
   * 于是下游只看 status 就够，不必再写 `status === 'extracted' && text.length > 0`。
   */
  async extract(
    documentType: DocumentType,
    input: ProcessorExtractInput
  ): Promise<ProcessorOutcome> {
    const processor = this.find(documentType);
    if (processor === null) {
      return { status: 'none', text: '' };
    }

    try {
      const result = await processor.extract(input);
      if (result.text.length === 0) {
        return { status: 'empty', text: '' };
      }
      return { status: result.status, text: result.text };
    } catch (err) {
      return {
        status: 'failed',
        text: '',
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
