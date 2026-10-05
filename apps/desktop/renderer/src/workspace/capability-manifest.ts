import type { ExtensionHost, ExtensionStatus } from '@nexus/editor';
import type { ViewerRendererRegistry } from '../viewer/registry.js';
import { capabilityLabelKey } from '../capability-roster.js';

/**
 * 一份内置能力的清单 —— 「Nexus 有哪些能力、现在什么状态」的**唯一答案**。
 *
 * 它是一层**只读投影**，不是新的事实源：数据来自两个已经存在的注册表
 * （`ExtensionHost` 管编辑器扩展，`ViewerRendererRegistry` 管附件渲染器），
 * 这里只做汇总与状态归一。加一个能力仍然只改注册表那一处。
 *
 * ## 为什么需要它
 *
 * 三个注册表里只有 `ExtensionHost` 有 UI。于是插件面板显示「2 个扩展」，而**渲染进程内**
 * 实际有 5 个能力（2 编辑器扩展 + 3 渲染器）—— 用户以为 Nexus 只有两个能力。这不是
 * 「少了功能」，是**谎报了现状**。
 *
 * ## 它**不含**主进程的文档处理器（pdf-text / docx-text）
 *
 * 那两个能力在主进程，状态要显示在这里就得再开一条 IPC 通道（P0 刻意避开的代价）。
 * 但它们在**设置页的启停开关里是有的** —— 那份名单来自静态名册（`capability-roster.ts`，
 * 7 项），不需要运行时状态。所以「面板 5 条 / 设置 7 个开关」是有意的差异：
 * 面板答「现在是什么状态」，设置答「出厂有哪些、要不要关」。
 *
 * ## 词表只有一份
 *
 * `CapabilityStatus` 直接引用 `ExtensionStatus['state']`，不重写那四个字面量。
 * 渲染器那侧只暴露三个原始 boolean（`listRenderers()`），由这里映射 ——
 * 两边各定一套枚举的话，同一个渲染器会在两处拼出不同状态。
 *
 * ## 不显示裸 id
 *
 * `nexus-math` 是标识符不是名字。可读名称来自 `capability-roster.ts`（出厂名册）；**认不出的 id
 * 回落显示裸 id**，而不是跳过那一条 —— 新加能力却忘了登记名字时，用户至少能看到它存在。
 * 静默消失比一个丑名字糟得多。
 */

/**
 * 能力来自哪个注册表。**只有渲染进程内那两张** —— 主进程的文档处理器（pdf-text / docx-text）
 * 的状态要进这份清单，得先有一条读它们状态的 IPC 通道（见文件头）。它们不在这里，
 * 但仍在设置页的启停名单里。
 */
export type CapabilityKind = 'editor-extension' | 'viewer';

/**
 * 与 `ExtensionStatus['state']` 同一套值。引用它而不是重写那几个字面量，理由见文件头。
 *
 * 五个值：`idle` / `loading` / `loaded` / `failed` / `disabled`。不设第六个 `unavailable` ——
 * 「清单里没有这一条」就是「这台机器上没有这个能力」，再给一个同义的状态值只会让
 * 「失败」和「没有」在两处被拼错。注册了却加载不出来是 `failed`。
 *
 * `disabled` 与 `idle` 必须分开：两者都「没加载」，但 `idle` 的意思是「用到它就会加载」，
 * 而 `disabled` 是「用户关掉了，永远不加载」。画成同一个词就是谎报现状。
 */
export type CapabilityStatus = ExtensionStatus['state'];

export interface CapabilityEntry {
  /** 注册表里的原生标识（编辑器扩展是 `nexus-math`，渲染器是 `pdf`）。启停列表用它。 */
  readonly id: string;
  readonly kind: CapabilityKind;
  /** 可读名称的 i18n key；名册里没有时是裸 id。 */
  readonly labelKey: string;
  readonly status: CapabilityStatus;
}

/**
 * 渲染器的四个 boolean → 一个状态。
 *
 * **判断顺序是有意的，两处都不能动**：
 *
 * 1. `disabled` 最先判。用户关掉它之后，包可能已经驻留在内存里（`import()` 收不回来），
 *    但它**永远不会被用来渲染** —— 显示「已加载」是在说一件不会发生的事。
 * 2. `failed` 在 `requested` 之前。失败之后 `requested` 仍是 `true`（那个 chunk 确实开始下载了），
 *    若放在后面判，失败的渲染器会显示成「加载中」—— 一个永远转不完的圈。
 */
function viewerStatus(renderer: {
  requested: boolean;
  loaded: boolean;
  failed: boolean;
  disabled: boolean;
}): CapabilityStatus {
  if (renderer.disabled) return 'disabled';
  if (renderer.failed) return 'failed';
  if (renderer.loaded) return 'loaded';
  if (renderer.requested) return 'loading';
  return 'idle';
}

/**
 * 汇总两个注册表。**编辑器扩展在前、渲染器在后** —— 顺序稳定，列表不会每次重排。
 *
 * 参数只声明「需要什么方法」而不是整个注册表类型：调用方传真对象结构兼容，测试可以直接
 * 喂一个带 `listRenderers()` 的字面量，两边都受类型保护（改签名会报错，不是静默漂移）。
 *
 * 两个参数都可选：轻量模式（单文件）下扩展宿主可能还没建。缺哪个就少哪一半，**不抛错** ——
 * 这个面板是只读展示，不该因为一个注册表缺失就整块消失。
 */
export function buildCapabilityManifest(
  host: Pick<ExtensionHost, 'listExtensions'> | undefined,
  viewers: Pick<ViewerRendererRegistry, 'listRenderers'> | undefined
): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];

  for (const extension of host?.listExtensions() ?? []) {
    entries.push({
      id: extension.id,
      kind: 'editor-extension',
      labelKey: capabilityLabelKey(extension.id),
      status: extension.state
    });
  }

  for (const renderer of viewers?.listRenderers() ?? []) {
    entries.push({
      id: renderer.type,
      kind: 'viewer',
      labelKey: capabilityLabelKey(renderer.type),
      status: viewerStatus(renderer)
    });
  }

  return entries;
}
