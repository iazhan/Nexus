import type { DocumentType } from '../document/types.js';

/**
 * 文本提取的状态。
 *
 * 「提取不到文本」单独成值而不用空串：空文本有两种成因 —— 本来就没有（图片、没有
 * 处理器的类型），与应该有却没有（扫描版 PDF；Phase 3 不做 OCR，见 `phase-3-plan.md`
 * §7 难点 6）。后者要如实告诉用户，混成空串就分不开了。`none` = 没有任何处理器跑过
 * （类型不适用，或这一轮它没被引用，§10.1 决策 1），不是错误。
 */
export type ExtractionStatus = 'none' | 'extracted' | 'empty' | 'failed';

/**
 * 处理器自己返回的结果。刻意没有 `failed` —— 处理器失败的方式是**抛异常**，由注册表
 * 转成 `failed`；同一件事留两条路就会出现「改一处忘一处」的静默不一致。
 */
export interface ProcessorResult {
  status: 'extracted' | 'empty';
  /** 提取出的纯文本，`empty` 时为空串。**不做清洗** —— 切分与归一化是索引层的事。 */
  text: string;
}

/** 处理器的输入。 */
export interface ProcessorExtractInput {
  /** 工作区相对路径，只用于日志与错误信息。不给绝对路径：处理器不需要，也免得它绕开 FileService 自己读盘。 */
  relativePath: string;
  /** 文件字节。边界与白名单校验是调用方的职责（`FileService`，P3-03），处理器拿到什么就解析什么。 */
  bytes: Uint8Array;
}

/**
 * 文档处理器：把一份非 Markdown 文档的字节变成纯文本。与 `ExtensionHost` 无关 ——
 * 名字里都有「处理器」而已，那个管的是 Markdown 源码怎么渲染。
 *
 * 只有三个字段是有意的：完整插件系统（清单、启停、依赖、权限）是 Phase 5，蓝图 §19.2
 * 警告插件 API 过早冻结会限制演进。Phase 3 只要「注册 → 按类型找 → 跑」。
 */
export interface DocumentProcessor {
  /** 稳定标识，用于日志与错误信息。别拿文档类型当 id —— 同一类型将来可能有两个处理器。 */
  readonly id: string;
  /**
   * 认领的文档类型。写成数组而不是 `supports()` 谓词：注册表要能在注册那一刻就查出
   * 「一个类型只有一个处理器」，而谓词问不出「你都认领了什么」。
   */
  readonly documentTypes: readonly DocumentType[];
  extract(input: ProcessorExtractInput): Promise<ProcessorResult>;
}

/**
 * 注册表给出的结论，比 `ProcessorResult` 多两种「处理器没跑成」的状态：`none`
 * （没有处理器认领）与 `failed`（处理器抛了）是注册表的结论，另两个是处理器的结论。
 */
export interface ProcessorOutcome {
  status: ExtractionStatus;
  /** 失败时为 `''`；其余与 `ProcessorResult.text` 同义。 */
  text: string;
  /** 只有 `failed` 才有：抛出异常的消息。 */
  message?: string;
}
