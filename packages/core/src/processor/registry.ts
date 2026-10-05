import type { DocumentType } from '../document/types.js';
import { ALL_CAPABILITIES_ENABLED, type CapabilityEnabled } from '../plugins/enabled.js';
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
 * **发现 / 隔离仍属 Phase 5；启停已经做了**（P1-4b）—— 方式与另两个注册表同形：收一个
 * `CapabilityEnabled` 谓词，`find()` 每次调用现问，所以拨开关立即生效、不用重新注册、
 * 也没有任何「撤销注册」的机制。
 *
 * ## 这里没有 `disabled` 这个状态，是有意的
 *
 * `ViewerRendererRegistry` 与 `ExtensionHost` 都要把「没登记」与「被关掉」分开画两张卡，
 * 所以它们的 `list*()` 会报 `disabled`。**这个注册表没有状态概念**：它只有「注册进来
 * 就是启用」这一条，而它唯一的消费者（索引器）问的是「有谁认领这个类型，能跑吗」——
 * 被关掉与没登记对它的答案**完全相同**（不提取、记 `none`），所以 `find()` 一律返回
 * `null` 就够。多造一个词表只会让两处判据有机会拼出不同结果（§4 不变量 3）。
 */
export class ProcessorRegistry {
  private readonly byId = new Map<string, DocumentProcessor>();
  private readonly byType = new Map<DocumentType, DocumentProcessor>();
  private readonly isEnabled: CapabilityEnabled;

  constructor(isEnabled: CapabilityEnabled = ALL_CAPABILITIES_ENABLED) {
    this.isEnabled = isEnabled;
  }

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

  /**
   * 认领了该类型**且现在没被关掉**的处理器；否则返回 `null`（「没处理器」是正常情况，不抛错）。
   *
   * 判据在返回前现问谓词，所以「在设置里关掉 pdf-text」之后**下一次调用**就变了 ——
   * 不需要重建注册表。这也意味着 `find()` 的答案不是常量：别把它缓存进字段。
   */
  find(documentType: DocumentType | null | undefined): DocumentProcessor | null {
    if (documentType === null || documentType === undefined) return null;
    const processor = this.byType.get(documentType) ?? null;
    if (processor === null) return null;
    return this.isEnabled(processor.id) ? processor : null;
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
