/**
 * 内置文档处理器的 id。
 *
 * ## 为什么提成常量、为什么住在 core
 *
 * 这两个字符串**两个进程都要用**：主进程拿它注册处理器（`apps/desktop/electron/processor`），
 * 渲染进程拿它拼出厂能力名册（`renderer/src/capability-roster.ts`），名册又决定
 * `plugins.disabled` 的取值域。两处各写一份字面量的话，改名一处不会报错 ——
 * 症状是「设置页里那个开关点了没反应」（名册里的 id 与主进程注册的 id 对不上）。
 *
 * 渲染进程**不能**从 `electron/processor/index.ts` 取这两个常量：那个模块顶层 import 了
 * pdfjs 与 mammoth，把它们拉进渲染包是实打实的体积与安全边界问题。所以常量必须住在
 * 一个两边都已依赖、且零依赖的模块里 —— `@nexus/core` 就是那个模块，而且
 * `ProcessorRegistry` 这份契约本来也在这里。
 *
 * ## 它**不是**文档类型
 *
 * `pdf-text` 认领 `pdf`、`docx-text` 认领 `docx`，但 id 不等于类型名 ——
 * `DocumentProcessor.id` 的注释写着「别拿文档类型当 id：同一类型将来可能有两个处理器」。
 * 能力名册里两者会同时出现（`pdf` 是渲染器、`pdf-text` 是处理器），
 * 判「关掉了哪个」必须整词比对（见 `disabledMembers`），不能靠子串。
 */
export const PDF_TEXT_PROCESSOR_ID = 'pdf-text';

export const DOCX_TEXT_PROCESSOR_ID = 'docx-text';
