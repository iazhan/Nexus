import { MATH_EXTENSION_ID, MERMAID_EXTENSION_ID } from '@nexus/editor';
import {
  DOCX_TEXT_PROCESSOR_ID,
  PDF_TEXT_PROCESSOR_ID,
  VIEWER_DOCUMENT_TYPES
} from '@nexus/core';

/**
 * 内置能力的**静态名册** —— 「Nexus 出厂带哪些能力、它们叫什么」的唯一答案。
 *
 * 它之所以是一份**独立的静态表**而不是「去问注册表」，是因为有两个消费者在**没有注册表**的地方：
 * 设置窗口（另一个窗口，注册表根本不存在）要拿它画启停开关；`capability-manifest.ts` 要拿它把
 * 裸 id 翻成人话。注册表回答的是「现在是什么状态」，名册回答的是「出厂有哪些」—— 两个问题。
 *
 * **id 不手抄，从常量拼出来。** 少一项的后果是那个能力在设置页里没有开关（用户以为它不存在），
 * 而手抄的字符串在常量改名时不会报错。顺序即设置页里的顺序，也是 `plugins.disabled` 的**存储顺序**
 * （见 `GroupSettingSpec`）。
 *
 * 顺序**按能力住在哪个进程分组**：先渲染进程（编辑器扩展 → 附件渲染器），再主进程（文档处理器）。
 * 处理器那两项**追加在末尾**（P1-4b）—— 插在中间会改变已有用户存档的规范化顺序，
 * 让「值变了没有」误报一次。
 *
 * 七个成员分属两个进程，但它们**共用同一个 `plugins.disabled` 值**：渲染进程按名册过滤出
 * 自己认识的那 5 个（`isCapabilityDisabled`），主进程按自己注册的那 2 个 id 查表
 * （`hostCapabilityEnabled`）。名册在这里是完整的「出厂清单」，不是「本进程认识的清单」。
 */
export const BUILTIN_CAPABILITY_IDS: readonly string[] = [
  MATH_EXTENSION_ID,
  MERMAID_EXTENSION_ID,
  ...VIEWER_DOCUMENT_TYPES,
  PDF_TEXT_PROCESSOR_ID,
  DOCX_TEXT_PROCESSOR_ID
];

/**
 * 能力 id → 可读名称的 i18n 键。
 *
 * 少一项的后果是那一行显示裸 id（`pdf`），而不是那一行消失 —— 静默消失比一个丑名字糟得多。
 * 有一条用例断言名册里每个 id 都能翻出非 id 的名字，所以漏登记会在测试里变红。
 *
 * 处理器那两项的名字要与对应的查看器**区分开**：`pdf` 是「PDF 查看器」（打开它看），
 * `pdf-text` 是「PDF 文本提取」（把它的文字喂给搜索索引）。叫成同一个名字会让用户
 * 关掉一个之后不知道另一个还开着。
 */
const LABEL_KEYS: Record<string, string> = {
  [MATH_EXTENSION_ID]: 'plugins.capability.math',
  [MERMAID_EXTENSION_ID]: 'plugins.capability.mermaid',
  image: 'plugins.capability.image',
  pdf: 'plugins.capability.pdf',
  docx: 'plugins.capability.docx',
  [PDF_TEXT_PROCESSOR_ID]: 'plugins.capability.pdfText',
  [DOCX_TEXT_PROCESSOR_ID]: 'plugins.capability.docxText'
};

/** 认不出的 id 回落成裸 id —— 新加能力却忘了登记名字时，用户至少能看到它存在。 */
export function capabilityLabelKey(id: string): string {
  return LABEL_KEYS[id] ?? id;
}

/**
 * 这个 id 是不是**出厂能力**（P2-6 形状冻结里的 `source: 'builtin'`）。
 *
 * 判据就是「在不在名册里」—— 名册的定义本来就是「Nexus **出厂**带哪些能力」，所以这不是
 * 一条新事实，只是把那张表读第二遍。**别改成让注册表报 `source`**：同一个问题有两个答案，
 * 而注册表并不知道「出厂」是什么（它只知道谁 `register()` 过自己）。
 *
 * 认不出 ≠ 出错：第三方能力本来就不在名册里（它们的可读名由 `capabilityLabelKey` 回落成
 * 裸 id，那条路早就在）。所以「不在名册里」的正确含义是 `'community'`，不是「非法」。
 */
export function isBuiltinCapability(id: string): boolean {
  return BUILTIN_CAPABILITY_IDS.includes(id);
}
