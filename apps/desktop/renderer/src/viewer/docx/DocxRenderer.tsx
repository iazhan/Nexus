import React, { useEffect, useRef, useState } from 'react';
import mammoth from 'mammoth';
import { toAssetUrl } from '@nexus/core';
import { useLocale } from '../../hooks.js';
import type { ViewerRendererProps } from '../types.js';

/**
 * DOCX Viewer（P3-08）—— 三个 Viewer 里唯一需要「格式转换」的那个。
 *
 * ## 转换方向：DOCX → 语义 HTML，不是「还原 Word 版式」
 *
 * `mammoth` 的定位是**语义转换**：`Heading 1` → `<h1>`、`List Paragraph` → `<ul><li>`，
 * 它**刻意丢掉**字体、字号、缩进、页边距这些表现层信息（见其 README 的
 * 「Philosophy」一节）。所以这个 Viewer 不能承诺「和 Word 一样」——
 * 那既做不到，也会让「转换结果不对」看起来像 bug。
 *
 * 界面因此如实标注「只读预览，版式与原文件可能不同」（`viewer.docx.readOnlyNotice`），
 * 并把 mammoth 报出的未转换条目数一并显示（§8 风险 3 的处置：**在 UI 上如实标注**）。
 *
 * ## 为什么要 Shadow DOM，而不是直接把 HTML 塞进 App
 *
 * mammoth 的输出是一段**自带标签的 HTML**（`<h1>` `<p>` `<table>` …）。
 * 直接 `innerHTML` 进 App 的 DOM 会有两个后果，都不是理论风险：
 *
 * 1. **样式互相污染** —— App 的 `h1` / `p` / `table` 规则会作用到文档内容上，
 *    反过来文档内容也可能撞上编辑器的选择器。而 DOCX 里出现 `<h1>` 是常态。
 * 2. **被 CSP 之外的样式规则影响后，「保真度」问题会变成「谁覆盖了谁」的调试** ——
 *    这类问题改一次样式就会复现一次。
 *
 * Shadow DOM 把这两件事一次解决：边界内的样式不外泄、外面的选择器不进来。
 * **不用 iframe** 是因为 iframe 要额外的 `frame-src` 放行，且父子通信、
 * 尺寸同步都要另写一套 —— 收益完全相同，成本高得多（§7 第 5 条）。
 *
 * 注意 **CSS 自定义属性是继承属性，会穿过 shadow 边界**，所以边界内的样式表
 * 可以直接用 `var(--nexus-*)` / `var(--font-family)` 跟随主题，不必复制一份色板。
 *
 * ## 严格只读
 *
 * 这个组件**没有**任何写回路径：`fetch` 是只读的，mammoth 只吃 `ArrayBuffer`、
 * 只吐字符串。`ViewerDocumentDescriptor` 里也没有 `session`（见 `viewer/types.ts`），
 * 所以「往 DOCX 里写东西」在这条链路上没有可用的入口（验收第 3 条）。
 */
const DocxRenderer: React.FC<ViewerRendererProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [warningCount, setWarningCount] = useState(0);
  const [failed, setFailed] = useState(false);

  // ── 取字节 → 转换 ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // 走 `nexus-asset://` 与图片 / PDF 同一条通道 —— 于是边界校验、类型白名单、
        // symlink 逃逸检查全都照旧生效（详见 `packages/core/src/asset/url.ts`）。
        // DOCX 不需要 Range（mammoth 要的是完整 ArrayBuffer），所以整份读进来。
        const response = await fetch(toAssetUrl(doc.path));
        if (!response.ok) throw new Error(`asset responded ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        const result = await mammoth.convertToHtml(
          { arrayBuffer },
          // 显式写出图片转换器，而不是依赖默认值：**这就是 `img-src` 里那条
          // `data:` 的由来**（内嵌图片被转成 base64 data URI）。写成默认值的话，
          // 将来 CSP 收紧时没人能从调用点看出这条依赖。
          { convertImage: mammoth.images.dataUri }
        );

        if (cancelled) return;
        setHtml(result.value);
        // mammoth 把「认不出来的样式 / 元素」报成 warning 而不是抛错 ——
        // 沉默地丢掉一部分内容才是最糟的选项，所以计数上界面。
        setWarningCount(result.messages.filter((message) => message.type === 'warning').length);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc.path]);

  // ── 把转换结果写进 shadow root ─────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || html === null) return;

    // `attachShadow` 对同一个元素第二次调用会抛，所以先看 `shadowRoot`。
    // React 19 的 StrictMode 会重复执行 effect，这条守卫是必需的而不是防御性写法。
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${SHADOW_STYLES}</style><div class="docx-body">${html}</div>`;

    // **拦掉链接的默认行为。** 只读预览器没有地址栏也没有后退键：让
    // `<a href="https://…">` 照常导航，等于点一下就把整个应用窗口换成了网页，
    // 用户回不来。CSP 也拦不住它 —— 顶层导航不归 `default-src` 管
    // （那是 fetch 指令，导航由 `navigate-to` 管，而它已从 CSP 规范移除）。
    //
    // 用事件委托而不是给每个 `<a>` 挂监听：转换结果是字符串，挂监听要再遍历一次 DOM，
    // 而每次重渲染都会重建整棵子树。
    const onClick = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('a') !== null) {
        event.preventDefault();
      }
    };
    shadow.addEventListener('click', onClick);

    return () => {
      shadow.removeEventListener('click', onClick);
    };
  }, [html]);

  if (failed) {
    return (
      <div className="nexus-state-container">
        <div className="nexus-error-card" role="alert">
          <span className="error-title">{t('viewer.docx.loadError')}</span>
          <p className="error-description nexus-docx-error-path">{doc.path}</p>
        </div>
      </div>
    );
  }

  const isLoading = html === null;
  const isEmpty = html !== null && html.trim() === '';

  return (
    <div className="nexus-docx-viewer">
      <div className="nexus-docx-stage">
        {isLoading && (
          <div className="nexus-state-container">
            <div className="nexus-loading-spinner" />
            <p className="nexus-state-text">{t('viewer.docx.loading')}</p>
          </div>
        )}
        {isEmpty && (
          <div className="nexus-state-container">
            <p className="nexus-state-text">{t('viewer.docx.empty')}</p>
          </div>
        )}
        {/* 宿主元素始终在位：shadow root 要挂在一个已经挂载的元素上，
            所以它不能跟着状态条件渲染 —— 否则转换完成时 ref 还是 null。 */}
        <div ref={hostRef} className="nexus-docx-content" />
      </div>
      <div className="nexus-docx-caption">
        <span className="nexus-docx-name">{doc.name}</span>
        {/* `data-docx-warnings` 让「有没有未还原的内容」可以**不依赖文案**断言 ——
            i18n 的默认语言受 userData 影响，拿文案做判据会变成
            「单跑绿、全跑红」那类脆弱用例（AGENTS.md 记过这个 locale 陷阱）。 */}
        <span className="nexus-docx-notice" data-docx-warnings={String(warningCount)}>
          {warningCount > 0
            ? t('viewer.docx.partialNotice', { count: String(warningCount) })
            : t('viewer.docx.readOnlyNotice')}
        </span>
      </div>
    </div>
  );
};

/**
 * Shadow DOM 里的样式表。
 *
 * 三条约束决定了它长这样：
 *
 * 1. **不能依赖外层选择器** —— 边界外的规则一条都进不来，所以 `h1` / `p` / `table`
 *    的基础排版必须在这里写全。指望「App 里已经有 h1 样式了」是行不通的。
 * 2. **可以用主题变量** —— CSS 自定义属性是继承属性，会穿过 shadow 边界，
 *    于是深浅色主题自动跟随，不必在这里复制色板。
 * 3. **只做文档排版，不做「像素级还原 Word」** —— 后者与 mammoth 的语义转换
 *    定位冲突（见文件头）。目标是「像一份排版正常的文档」，不是「像 Word」。
 */
const SHADOW_STYLES = `
  :host { display: block; }
  .docx-body {
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.7;
    color: var(--nexus-text-primary);
    overflow-wrap: break-word;
  }
  .docx-body > :first-child { margin-top: 0; }
  .docx-body > :last-child { margin-bottom: 0; }
  .docx-body h1, .docx-body h2, .docx-body h3,
  .docx-body h4, .docx-body h5, .docx-body h6 {
    margin: 1.4em 0 0.6em;
    line-height: 1.3;
    font-weight: 600;
  }
  .docx-body h1 { font-size: 1.7em; }
  .docx-body h2 { font-size: 1.4em; }
  .docx-body h3 { font-size: 1.2em; }
  .docx-body h4, .docx-body h5, .docx-body h6 { font-size: 1.05em; }
  .docx-body p { margin: 0.7em 0; }
  .docx-body ul, .docx-body ol { margin: 0.7em 0; padding-left: 2em; }
  .docx-body li { margin: 0.25em 0; }
  .docx-body a { color: var(--nexus-accent-text); text-decoration: underline; cursor: default; }
  .docx-body img { max-width: 100%; height: auto; }
  .docx-body table {
    margin: 1em 0;
    border-collapse: collapse;
    font-size: 0.95em;
  }
  .docx-body th, .docx-body td {
    border: 1px solid var(--nexus-border-default);
    padding: 4px 10px;
    text-align: left;
    vertical-align: top;
  }
  .docx-body th { background-color: var(--nexus-bg-surface); font-weight: 600; }
  .docx-body blockquote {
    margin: 0.8em 0;
    padding: 0.2em 0 0.2em 1em;
    border-left: 3px solid var(--nexus-border-default);
    color: var(--nexus-text-secondary);
  }
  .docx-body code, .docx-body pre { font-family: var(--font-mono); font-size: 0.92em; }
  .docx-body pre {
    margin: 0.8em 0;
    padding: 10px 12px;
    overflow-x: auto;
    background-color: var(--nexus-bg-surface);
    border-radius: 4px;
  }
  .docx-body hr {
    margin: 1.4em 0;
    border: none;
    border-top: 1px solid var(--nexus-border-subtle);
  }
`;

export default DocxRenderer;
