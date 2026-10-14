import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Nexus Unified Theme using CSS Variables (Design Tokens)
//
// 排版四项（字号 / 字体 / 行高 / 段间距）、内容宽度、代码块行号开关与表格列宽走 `--nx-editor-*`
// 而不是主题 token：它们是**用户偏好**，不是主题的一部分 —— 换主题不该把字号或行号重置回去。
// 变量由宿主（App.css 的 `:root` 给默认值、渲染进程按设置覆盖）提供，包内只引用。
//
// 代码块是唯一的例外：它固定用宿主的等宽栈 `--font-mono`，**不跟随** `--nx-editor-font-family` ——
// 编辑器字体可以设成衬线，代码必须留在等宽。
//
// 字号是**基准**：标题与行内元素一律用 `em`，所以改这一个值整篇一起缩放。
export const nexusBaseTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--nexus-text-primary)",
    backgroundColor: "var(--nexus-bg-canvas)",
    fontSize: "var(--nx-editor-font-size, 14px)",
    fontFamily: "var(--nx-editor-font-family, monospace)"
  },
  ".cm-content": {
    caretColor: "var(--nexus-accent-indicator)",
    padding: "12px 16px 12px 36px",
    lineHeight: "var(--nx-editor-line-height, 1.6)"
  },
  // CRLF 文档的行内容末尾带 `\r`（`Text.of(source.split('\n'))` 为了保住「doc 偏移 == source
  // 偏移」而刻意保留它）。`\r` 是零宽且不产生行盒的字符，于是**只有 `\r` 的空行高度会塌成 0**
  // —— 内容行与行号槽同时塌，行号数字全被压在上一行的下边缘上，看上去就是「行号重叠」。
  // 兜底给一个最小行高：正常行本来就 >= 这个值，只有塌陷行被撑回来。
  // 用 `calc(... * 1em)` 而不是写死像素，跟随 `--nx-editor-line-height` 设置。
  ".cm-line": {
    position: "relative",
    minHeight: "calc(var(--nx-editor-line-height, 1.6) * 1em)"
  },
  // 块与块之间的空行。间距用 `padding-bottom` 而不是 `margin`：行高变化会被 CM 的高度测量
  // 吃掉（编辑器开着 `lineWrapping`，逐行高度本来就是测出来的），而 margin 不计入行盒。
  ".cm-block-gap": {
    paddingBottom: "var(--nx-editor-paragraph-spacing, 0px)"
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--nexus-accent-indicator)",
    borderLeftWidth: "2px"
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--nexus-selection-bg) !important"
  },

  // 查找 / 替换与「选中即高亮」的底色。CM 自带的是写死的十六位色，且不分主题 ——
  // 这里换成与主题联动的 token，两个用途刻意分开：搜出来的命中与 `==x==` 文档高亮
  // 同族（`bg-highlight` 黄），选中词与系统选区同族（`selection-bg` 蓝紫）——
  // 用户对「选中的东西是什么颜色」已有认知，全文相同词延续它比另娶一色好懂。
  //
  // 第三条是 **CM 自带的防叠显规则**（嵌套在 searchMatch 里的 selectionMatch 透明）：
  // 选中词与查询词相同时，一个 span 上同时落两个 class；没有这条，后应用的底色
  // 会盖掉前一个，「刚才是黄底怎么变紫了」没有解释。覆盖前两条时不能顺手删它。
  ".cm-searchMatch": {
    backgroundColor: "var(--nexus-bg-highlight)"
  },
  // 当前跳到的那一处用 accent 描边而不是换底色：底色只有「又一档黄」可走，
  // 而 accent-indicator 正是「图形级当前项」的既有口径（设置里当前项同款手法：
  // 选中感由底色 + accent 边框给，不把文字也染色）。
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--nexus-bg-highlight)",
    outline: "1.5px solid var(--nexus-accent-indicator)",
    outlineOffset: "-1px"
  },
  ".cm-selectionMatch": {
    backgroundColor: "var(--nexus-selection-bg)"
  },
  ".cm-searchMatch .cm-selectionMatch": {
    backgroundColor: "transparent"
  },
  // 被投影 widget 整块替换的区间的命中代理（`WikiLinkWidget.searchHit`）：
  // CM 的 `cm-searchMatch` mark 落在 replace range 上不落 DOM，widget 自己画。
  // 用与正文命中同一个黄底，两种命中在用户眼里是同一种东西。
  ".cm-search-hit-shadow": {
    backgroundColor: "var(--nexus-bg-highlight)",
    borderRadius: "2px"
  },

  // ---- 查找面板：右上角悬浮卡片 ----
  //
  // 面板是自绘的（`search-panel.ts` 的 `NexusFindPanel`），CM 对它没有任何默认样式
  // （`.cm-panel.cm-search` 那条只匹配内置面板），所以这里是从零画一张卡片。
  // 两件事必须一起做，少一件面板就会「占流」或盖出死区：
  //
  // 1. `.cm-panels` 默认是 `position: sticky; left: 0; right: 0` —— 它**占文档流**，
  //    把正文往下挤。改成 absolute 贴到编辑器右上角，正文才不被推走。定位基准是
  //    `.cm-editor`（CM baseTheme 给它 `position: relative !important`），不必另加包裹层。
  // 2. 容器设 `pointer-events: none`。它横向铺满编辑器（卡片靠 `margin-left: auto` 右对齐），
  //    不设就会在整条顶部盖出一片点不动的死区。卡片自己再设回 `auto`。
  //
  // 这两条的选择器都是 `.cm-panels.cm-panels-top`：CM 的主题构造会给每个 key 前面接上
  // 主题类名，所以实际是 `.ͼX .cm-panels.cm-panels-top`（0,3,0），压得住 baseTheme 的
  // `.ͼL .cm-panels-top`（0,2,0）—— 不必动用 `!important`。
  ".cm-panels.cm-panels-top": {
    position: "absolute",
    top: "8px",
    left: "8px",
    right: "8px",
    bottom: "auto",
    border: "none",
    backgroundColor: "transparent",
    pointerEvents: "none"
  },
  ".nexus-find": {
    pointerEvents: "auto",
    // 靠右：容器铺满编辑器，卡片自己缩到「内容宽度上限」。
    marginLeft: "auto",
    // 右侧让开滚动条。容器贴的是 `.cm-editor` 的右边缘，而滚动条就在那里面 ——
    // 不让开卡片会压住滚动条的上半截。值由面板现量（`NexusFindPanel.syncGutter`），
    // 覆盖层滚动条的平台量出来是 0，本来也不用让。
    marginRight: "var(--nexus-find-gutter, 0px)",
    // 上限里也要把那段让位减掉：容器窄的时候 `100%` 会把卡片顶出去、又压回滚动条上。
    width: "min(calc(100% - var(--nexus-find-gutter, 0px)), 420px)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "6px",
    border: "1px solid var(--nexus-border-default)",
    borderRadius: "6px",
    backgroundColor: "var(--nexus-bg-surface)",
    color: "var(--nexus-text-primary)",
    // 阴影从**主题的正文色**派生，不写死黑色 —— 与 `.cm-inline-edit-popover` 同一个理由：
    // 深色主题下 `--nexus-text-primary` 是近白的，那一圈浅色晕就是「浮起来」的读法；
    // 写死 `rgba(0,0,0,.16)` 在深色底上等于没有阴影。
    boxShadow: "0 8px 24px color-mix(in oklab, var(--nexus-text-primary) 18%, transparent)",
    fontFamily: "var(--font-family)",
    fontSize: "12px",
    lineHeight: "1.4"
  },
  ".nexus-find-row": {
    display: "flex",
    alignItems: "center",
    gap: "2px"
  },
  // 放大镜。与替换行的占位块同宽，于是两行的输入框左边对齐。
  ".nexus-find-leading": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    flexShrink: "0",
    color: "var(--nexus-text-muted)"
  },
  // 替换行行首的占位块，宽度对齐查找行的折叠按钮（22px）—— 少那 2px 两行就错开。
  ".nexus-find-placeholder": {
    flexShrink: "0",
    width: "22px"
  },
  ".nexus-find svg": {
    display: "block",
    width: "14px",
    height: "14px"
  },
  ".nexus-find-input": {
    flex: "1 1 auto",
    minWidth: "0",
    height: "26px",
    boxSizing: "border-box",
    padding: "0 6px",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "4px",
    // 输入框退回 `canvas`（卡片是 `surface`）：凹进去一格，与卡片分得开。
    backgroundColor: "var(--nexus-bg-canvas)",
    color: "var(--nexus-text-primary)",
    fontFamily: "inherit",
    fontSize: "12px",
    outline: "none"
  },
  ".nexus-find-input:focus": {
    borderColor: "var(--nexus-accent-solid)"
  },
  // 计数。`tabular-nums` 让「1/9 → 10/9」时按钮列不跟着抖；颜色走 muted，
  // 它是辅助信息，不该比输入框抢眼。
  ".nexus-find-count": {
    flexShrink: "0",
    minWidth: "3.4em",
    padding: "0 4px",
    color: "var(--nexus-text-muted)",
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    textAlign: "right",
    whiteSpace: "pre"
  },
  // 有查询但零命中：计数换成警示色。这是「搜了但没结果」的唯一视觉反馈 ——
  // 面板不挡正文，用户不会自己发现「一处都没高亮」。
  '.nexus-find[data-state="none"] .nexus-find-count': {
    color: "var(--nexus-status-warning-text)"
  },
  // 图标按钮（上一个 / 下一个 / 关闭 / 折叠替换行）。方形无边框，悬停才出底。
  ".nexus-find-icon": {
    appearance: "none",
    flexShrink: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    padding: "0",
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: "var(--nexus-text-secondary)",
    cursor: "pointer"
  },
  ".nexus-find-icon:hover:not(:disabled)": {
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-primary)"
  },
  ".nexus-find-icon:disabled": {
    color: "var(--nexus-text-muted)",
    opacity: "0.5",
    cursor: "default"
  },
  // 三个开关（Aa / ab / .*）。等宽字体让它们同宽，不然 `.*` 比 `Aa` 窄一截、
  // 三个按钮看起来没对齐。
  ".nexus-find-switch": {
    appearance: "none",
    flexShrink: "0",
    minWidth: "24px",
    height: "22px",
    padding: "0 4px",
    border: "1px solid transparent",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: "var(--nexus-text-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    lineHeight: "1",
    cursor: "pointer"
  },
  ".nexus-find-switch:hover": {
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-primary)"
  },
  // **按下态必须看得出来** —— 三个开关是纯文字，没有勾选框可看，`aria-pressed` 是唯一依据。
  // 底色 + 反色文字，与设置里「当前项」同一套口径。
  '.nexus-find-switch[aria-pressed="true"]': {
    backgroundColor: "var(--nexus-accent-solid)",
    borderColor: "var(--nexus-accent-solid)",
    color: "var(--nexus-accent-contrast)"
  },
  ".nexus-find-text": {
    appearance: "none",
    flexShrink: "0",
    height: "22px",
    padding: "0 8px",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "4px",
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-primary)",
    fontFamily: "inherit",
    fontSize: "12px",
    lineHeight: "1",
    cursor: "pointer",
    whiteSpace: "nowrap"
  },
  ".nexus-find-text:hover:not(:disabled)": {
    backgroundColor: "var(--nexus-bg-surface-active)"
  },
  ".nexus-find-text:disabled": {
    color: "var(--nexus-text-muted)",
    cursor: "default"
  },
  // 开关列与跳转按钮之间的一道竖线：左边是「怎么找」，右边是「跳到哪一处」。
  ".nexus-find-separator": {
    flexShrink: "0",
    width: "1px",
    height: "16px",
    margin: "0 2px",
    backgroundColor: "var(--nexus-border-subtle)"
  },
  // 替换行的显隐**用属性而不是删 DOM**：面板的 `update()` 只写属性、不重建结构，
  // 焦点才不会在用户输入中途丢。
  '.nexus-find[data-replace="closed"] .nexus-find-replace-row': {
    display: "none"
  },
  // 只读文档没有替换：替换行与折叠按钮一起收起（点了也展不开，留着只会让人以为坏了）。
  '.nexus-find[data-readonly="true"] .nexus-find-replace-row': {
    display: "none"
  },
  '.nexus-find[data-readonly="true"] button[name="toggle-replace"]': {
    display: "none"
  },
  ".cm-gutters": {
    backgroundColor: "var(--nexus-bg-surface)",
    color: "var(--nexus-text-muted)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    paddingRight: "4px"
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 12px",
    minWidth: "36px",
    textAlign: "right"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--nexus-bg-surface-hover)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-secondary)"
  },

  // UI widgets and interactive elements
  ".cm-visual-drag-handle": {
    position: "absolute",
    left: "-26px",
    top: "calc(0.5lh)",
    transform: "translateY(-50%)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "18px",
    color: "var(--nexus-text-muted)",
    cursor: "grab",
    userSelect: "none",
    opacity: "0",
    transition: "opacity 0.15s ease, color 0.15s ease",
    zIndex: "5"
  },
  ".cm-visual-code-header-line > .cm-visual-drag-handle": {
    top: "50%"
  },
  ".cm-visual-drag-handle::after": {
    content: "''",
    position: "absolute",
    top: "0",
    bottom: "0",
    right: "-10px",
    width: "10px"
  },
  ".cm-line:hover > .cm-visual-drag-handle, .cm-visual-drag-handle:focus-within": {
    opacity: "0.5"
  },
  ".cm-visual-drag-handle:hover": {
    opacity: "1",
    color: "var(--nexus-text-primary)"
  },
  // 拖动中手柄**一直可见**。它原先和 hover 共用一条 0.5 的规则 —— 按住不放时与悬停
  // 长得一模一样，用户看不出「已经拿起来了」。`grabbing` 与基础样式的 `grab` 配对。
  ".cm-visual-drag-handle.is-dragging": {
    opacity: "1",
    color: "var(--nexus-accent-text)",
    cursor: "grabbing"
  },
  ".cm-visual-drag-handle.disabled": {
    cursor: "not-allowed",
    opacity: "0 !important"
  },
  // 正在被拖动的源块：**整体压暗**，表示「这块已经被拿起来了」。
  //
  // 为什么是 opacity 而不是底色：代码块、引用块、公式块、表格各有自己的背景与边框，
  // 再叠一层底色会看起来像坏掉；透明度对任何块都成立，且不碰任何既有配色。
  //
  // 过渡走宿主的 `--nx-motion-*`（`App.css` 的 `:root` 提供），带兜底是因为本包是独立
  // 依赖、测试与别的宿主不一定注入这两个变量。**不写裸值**：散落的时长与曲线迟早漂开。
  ".cm-visual-drag-source": {
    opacity: "0.4",
    transition: "opacity var(--nx-motion-fast, 120ms) var(--nx-motion-ease, ease)"
  },
  // 放置指示器：一条横线，表示「松手后源块会落到这个边界上」。
  //
  // **线的方位由 side 决定**（`resolveDropIndicatorLine` 算出装饰哪一行 + 哪个方位类）：
  //
  // - `-top` / `-bottom`：边界两侧都是块正文，线贴边画 —— `before` 画目标块首行顶边、
  //   `after` 画末行底边。相邻的列表项之间就是这一种。
  // - `-mid`：边界紧邻一条空行（`.cm-block-gap`），线画在那条空行的**垂直中间**。
  //   这不是美化：「落在块 A 之后」与「落在块 B 之前」（A、B 之间有空行）是**同一个插入位**，
  //   移动语义下结果完全相同；若各自贴边画，线会在两行之间跳 20 多像素，看起来像两个落点。
  //
  // 用 `background-image` 渐变，不用 `border-top` / `border-bottom`（会占位、把行内容推走 2px），
  // 也不用 `::before` / `::after`（`.cm-line` 的两个伪元素已被代码块行号
  // `attr(data-code-line-number)` 与引用内代码块的底纹占用，撞上就把它们顶掉）。
  //
  // **刻意不加过渡**：它跟着指针逐帧改目标行，带过渡会让它追不上指针、看起来发飘。
  // 会动的只有源块那一处（拿起来 / 放下）。
  ".cm-visual-drop-target-top": {
    backgroundImage:
      "linear-gradient(to bottom, var(--nexus-accent-indicator) 0 2px, transparent 2px)"
  },
  ".cm-visual-drop-target-bottom": {
    backgroundImage:
      "linear-gradient(to top, var(--nexus-accent-indicator) 0 2px, transparent 2px)"
  },
  // 空行上的线画在正中：`50%` 让那 2px 落在行盒垂直中点。起点与另两条一致 ——
  // 刻意不用 `background-origin: content-box`（虽然段间距 > 0 时中线更准），否则这条会从
  // 内容盒左缘起算、比贴边那两条右移一个 `.cm-line` 的 `padding-left`，指针跨过
  // 有空行 / 无空行的边界时线会横着跳一下。
  ".cm-visual-drop-target-mid": {
    backgroundImage: "linear-gradient(var(--nexus-accent-indicator), var(--nexus-accent-indicator))",
    backgroundSize: "100% 2px",
    backgroundPosition: "0 50%",
    backgroundRepeat: "no-repeat"
  },
  ".cm-marker-inline-math": {
    color: "var(--nexus-accent-text)",
    backgroundColor: "var(--nexus-bg-surface-active)",
    borderRadius: "3px",
    padding: "1px 3px"
  },
  ".cm-marker-block-math": {
    color: "var(--nexus-accent-text)",
    display: "inline-block",
    width: "100%",
    // 底纹与竖条都不在这里画（见下）：跨行 mark 的空行拿不到 span，画在这里会断。
    // padding-left 里含原先 border-left 的 3px，文字位置与改前一致。
    padding: "2px 6px 2px 9px"
  },
  // 按行铺满的底纹与竖条。`Decoration.mark` 跨行时只会给**有字符的行**生成 span，
  // 空行拿不到 → 底纹会断成几截，所以要靠行装饰兜住。
  //
  // 底纹起点为什么用渐变而不是直接 background：CodeMirror baseTheme 给 `.cm-line` 设了
  // `padding-left: 6px`，行盒左边缘比 mark span 靠左 6px。直接铺 background 会让底纹
  // 左边缘在"有内容的行"（span 起点 6px 处）与"空行"（行盒起点 0）之间来回错 6px，
  // 看起来就是竖条与灰块没对齐。渐变把起点对齐到 span 的左边缘。
  ".cm-marker-block-math-band": {
    backgroundImage:
      "linear-gradient(to right, transparent 0 6px, var(--nexus-bg-surface-active) 6px)",
    borderRadius: "0 3px 3px 0"
  },
  // 竖条：位置与底纹起点一致。
  //
  // 用绝对定位而不是 border —— 行装饰上的 border 会把整行文字右推 3px。
  // 绝对定位元素画在行内文字之上，但这里 [6px, 9px] 正好落在 mark span 的
  // padding-left 里（span 自己从 6px 起算、文字从 15px 起），不会压住正文。
  ".cm-marker-block-math-band::before": {
    content: '""',
    position: "absolute",
    left: "6px",
    top: "0",
    bottom: "0",
    width: "3px",
    backgroundColor: "var(--nexus-accent-indicator)"
  },
  ".cm-marker-wikilink": {
    color: "var(--nexus-accent-text)",
    textDecoration: "underline",
    textDecorationColor: "var(--nexus-accent-indicator)",
    backgroundColor: "var(--nexus-bg-surface-active)",
    borderRadius: "3px",
    padding: "1px 3px"
  },
  ".cm-marker-code-fence": {
    color: "var(--nexus-syntax-string)"
  },
  ".cm-visual-hidden-delimiter": {
    display: "none"
  },
  ".cm-visual-delimiter-revealed": {
    opacity: "0.7",
    color: "var(--nexus-text-muted)"
  },
  // 列表标记的视觉替身（无序 `•` / 有序编号）。未进入编辑态时取代被隐藏的 source marker，
  // 因此必须有独立的可见样式，不能落到 .cm-visual-hidden-delimiter 的 display: none。
  ".cm-visual-list-marker": {
    color: "var(--nexus-text-secondary)"
  },
  ".cm-visual-list-marker-ordered": {
    fontVariantNumeric: "tabular-nums"
  },
  // 链接文字现在是真实文档文本（mark 装饰），不再有原生 <a> 的默认链接样式，
  // 必须显式声明，否则链接看起来和普通文字没有区别。
  ".cm-visual-link": {
    color: "var(--nexus-syntax-url)",
    textDecoration: "underline"
  },
  // 被拦截的协议（javascript:、file: 等）不产生任何可点击目标，视觉上明确区分。
  ".cm-visual-link-blocked": {
    color: "var(--nexus-text-muted)",
    textDecoration: "underline dashed"
  },
  // 标签（`#标签`）。用 syntax-property 而不是 syntax-url：两者都是「引用」，但链接
  // 已经占了 url 色，同色会让标签看起来像一条坏掉的链接。**不给背景色** ——
  // 标签常成串出现，底纹连起来会盖过正文本身的强调层级。
  ".cm-nexus-tag": {
    color: "var(--nexus-syntax-property)"
  },
  // 内嵌图片。**`max-width` 是这条链上唯一能兜住图片尺寸的地方** —— 尺寸来自文件本身，
  // 投影层拿不到；缺了它图片按原始像素撑开行宽（实测一张 2001px 的图把行宽推到 2009px，
  // 而编辑区只有 655px），横向滚动条随之出现。
  //
  // `vertical-align: bottom` 去掉行内基线留下的下沉空隙：否则单独成行的图片会比图片本身
  // 高出一个行距，行高与下方内容的点击命中区一起偏移。
  ".cm-visual-image img": {
    maxWidth: "100%",
    height: "auto",
    verticalAlign: "bottom"
  },
  ".cm-visual-image-placeholder": {
    color: "var(--nexus-text-muted)",
    fontStyle: "italic"
  },
  // 图片引用被就地揭示时的底纹（光标落进 `![](…)` / `![[…]]` 内部）。
  // 与 `.cm-marker-wikilink` 那层区分：那层是 Source 模式自带的标记底色，
  // 这层说的是「这一段现在是一张正在编辑的图片引用」。
  ".cm-visual-image-source": {
    backgroundColor: "var(--nexus-bg-surface-active)",
    borderRadius: "3px"
  },
  // 揭示态下与源码并存的图片。这里**必须**是块级：图片是行内 widget（图片节点常在
  // 行中间，块级 widget 要求落在行边界，插不进去），靠 `display: block` 让它独占
  // 一行宽度，把后面的源码挤到下一行 —— 于是「图在上、源码在下」同时在场。
  ".cm-visual-image-alongside": {
    display: "block",
    marginBottom: "6px"
  },
  ".cm-visual-image-alongside img": {
    display: "block"
  },
  // 地址解析不出来时占位符下面那行原因。占位符本身是斜体，这句要是正体，
  // 否则读起来像占位符文本的一部分。
  ".cm-visual-image-hint": {
    display: "block",
    color: "var(--nexus-text-muted)",
    fontStyle: "normal",
    fontSize: "0.85em"
  },
  // 行内编辑浮层：链接 / WikiLink / 行内代码的改写面板，以及图片选择器。
  //
  // 这一族此前**一条样式都没有**，而 `openPopover` 只写 `style.left/top` —— 没有
  // `position: absolute` 时那两个偏移毫无作用，元素以静态块落在编辑区末尾、与正文完全脱节。
  // 补上定位之后，四类浮层才真的"浮"在被编辑节点下方。
  //
  // `z-index` 取 200：CodeMirror 自己的 `.cm-tooltip` 是 100，压不过它就会在
  // 自动补全弹出时被盖住。
  ".cm-inline-edit-popover": {
    position: "absolute",
    zIndex: "200",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    minWidth: "220px",
    maxWidth: "420px",
    padding: "10px",
    borderRadius: "6px",
    backgroundColor: "var(--nexus-bg-surface)",
    border: "1px solid var(--nexus-border-strong)",
    boxShadow: "0 8px 24px color-mix(in oklab, var(--nexus-text-primary) 18%, transparent)"
  },
  ".cm-inline-edit-field": {
    display: "flex",
    flexDirection: "column",
    gap: "2px"
  },
  ".cm-inline-edit-label": {
    color: "var(--nexus-text-secondary)",
    fontSize: "0.85em"
  },
  ".cm-inline-edit-popover input": {
    padding: "4px 6px",
    color: "var(--nexus-text-primary)",
    backgroundColor: "var(--nexus-bg-canvas)",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "4px",
    fontFamily: "inherit",
    fontSize: "inherit"
  },
  ".cm-inline-edit-error": {
    color: "var(--nexus-status-error-text)",
    fontSize: "0.85em"
  },
  ".cm-inline-edit-actions": {
    display: "flex",
    gap: "6px",
    justifyContent: "flex-end"
  },
  ".cm-inline-edit-actions button, .cm-image-upload-btn": {
    padding: "4px 10px",
    cursor: "pointer",
    color: "var(--nexus-text-primary)",
    backgroundColor: "var(--nexus-bg-surface-hover)",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "4px",
    fontFamily: "inherit",
    fontSize: "0.9em"
  },
  // 图片选择器：缩略图网格。列宽用 `auto-fill` 而不是固定列数 —— 面板宽度由
  // `max-width` 夹住，固定列数在窄面板里会把缩略图压成一条。
  ".cm-image-picker-list": {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
    gap: "6px",
    maxHeight: "220px",
    overflowY: "auto"
  },
  ".cm-image-picker-item": {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    padding: "4px",
    cursor: "pointer",
    color: "var(--nexus-text-secondary)",
    backgroundColor: "var(--nexus-bg-surface-hover)",
    border: "1px solid transparent",
    borderRadius: "4px",
    fontFamily: "inherit",
    fontSize: "0.8em"
  },
  ".cm-image-picker-item:hover": {
    borderColor: "var(--nexus-accent-indicator)"
  },
  // 当前引用写着的那张 —— 面板的「预选」。常态就带强调边框，不是只在 hover 时才亮。
  ".cm-image-picker-item[data-current='true']": {
    borderColor: "var(--nexus-accent-indicator)",
    backgroundColor: "var(--nexus-bg-surface-active)"
  },
  ".cm-image-picker-item img": {
    width: "100%",
    height: "48px",
    objectFit: "cover",
    borderRadius: "3px",
    backgroundColor: "var(--nexus-bg-canvas)"
  },
  ".cm-image-picker-name": {
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  },
  ".cm-image-picker-empty": {
    color: "var(--nexus-text-muted)",
    fontStyle: "italic",
    fontSize: "0.85em"
  },
  // 块级公式：KaTeX 的 display 模式会给 `.katex-display` 加上 `margin: 1em 0`。
  //
  // **块级 widget 的高度测量只算 `offsetHeight`，不含 margin**，而子元素的外边距会
  // 塌陷到容器之外——于是 CM 认为这个公式块比实际矮 2em，下方**所有内容**的点击命中区
  // 整体下移（实测 ~28px，症状是"必须点目标行的上方"）。表格漂移当年也是这么修的：
  // 把 margin 换成 padding，让间距落进被测量的盒子里。
  //
  // 所以：子元素 margin 归零，间距改由容器自己的 padding 承担（视觉间距不变）。
  ".cm-visual-block-math .katex-display": {
    margin: "0"
  },
  ".cm-visual-block-math": {
    padding: "14px 0"
  },
  // 块级公式进入编辑态时，源码行下方追加的实时预览。用 border + padding 做分隔，
  // **同样不能用 margin**（理由同上）。
  ".cm-visual-block-math-preview": {
    borderTop: "1px dashed var(--nexus-border-subtle)",
    paddingTop: "6px",
    opacity: "0.85"
  },
  ".cm-visual-quote-marker": {
    color: "var(--nexus-text-muted)",
    opacity: "0.8",
    fontWeight: "500"
  },
  ".cm-visual-strike": {
    textDecoration: "line-through"
  },
  // 跨行高亮时背景要连续，不能每行各断一次。
  ".cm-visual-highlight": {
    backgroundColor: "var(--nexus-bg-highlight)",
    borderRadius: "2px",
    boxDecorationBreak: "clone"
  },
  ".cm-visual-hr-container": {
    display: "block",
    boxSizing: "border-box",
    padding: "16px 0",
    cursor: "pointer"
  },
  ".cm-visual-horizontal-rule": {
    border: "none",
    borderTop: "1px solid var(--nexus-border-strong)",
    margin: "0",
    width: "100%",
    cursor: "pointer"
  },

  // Blockquote styling
  ".cm-visual-blockquote-line": {
    borderLeft: "3.5px solid var(--nexus-accent-indicator)",
    backgroundColor: "var(--nexus-bg-quote)",
    paddingLeft: "16px",
    paddingRight: "16px",
    position: "relative"
  },
  ".cm-visual-blockquote-first-line": {
    borderTopRightRadius: "6px",
    paddingTop: "6px"
  },
  ".cm-visual-blockquote-last-line": {
    borderBottomRightRadius: "6px",
    paddingBottom: "6px"
  },

  // Code block line decorations and styling
  ".cm-visual-code-line": {
    backgroundColor: "var(--nexus-bg-canvas)",
    fontFamily: "var(--font-mono, monospace)",
    paddingLeft: "12px",
    paddingRight: "12px"
  },
  ".cm-visual-code-header-line": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    backgroundColor: "var(--nexus-bg-surface)",
    paddingLeft: "12px",
    paddingRight: "12px",
    height: "28px",
    minHeight: "28px",
    lineHeight: "22px",
    boxSizing: "border-box"
  },
  ".cm-visual-code-header-line .cm-widgetBuffer, .cm-visual-code-closing-line .cm-widgetBuffer": {
    display: "none !important",
    width: "0 !important",
    height: "0 !important"
  },
  ".cm-code-header-widget": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    height: "100%",
    lineHeight: "22px",
    userSelect: "none"
  },
  ".cm-code-header-left": {
    display: "flex",
    alignItems: "center",
    gap: "8px"
  },
  ".cm-code-line-count": {
    fontSize: "0.75em",
    color: "var(--nexus-text-muted)",
    userSelect: "none",
    fontFamily: "inherit"
  },
  ".cm-code-language-select": {
    appearance: "none",
    WebkitAppearance: "none",
    opacity: "0.85",
    pointerEvents: "auto",
    backgroundColor: "transparent",
    color: "var(--nexus-text-muted)",
    border: "none",
    borderRadius: "3px",
    height: "20px",
    padding: "0",
    fontSize: "0.75em",
    fontWeight: "600",
    textTransform: "uppercase",
    fontFamily: "inherit",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "color 0.15s ease"
  },
  ".cm-code-language-select:hover": {
    color: "var(--nexus-text-primary)"
  },
  // 代码块右上角的操作按钮（复制源码 / Mermaid 源码切换）共用一套外观：
  // 默认完全隐藏，只在悬停该块、或用键盘把焦点移进来时出现。
  // 注意 `font: inherit` —— 原生 button 不继承字体，不写会掉回系统 UI 字体。
  ".cm-code-copy-btn, .cm-mermaid-toggle": {
    opacity: "0",
    pointerEvents: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "transparent",
    color: "var(--nexus-text-secondary)",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "3px",
    height: "20px",
    padding: "0 6px",
    fontFamily: "inherit",
    fontSize: "0.75em",
    lineHeight: "1",
    whiteSpace: "nowrap",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "opacity 0.15s ease-out, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease"
  },
  // 两条揭示路径都要覆盖：
  // - 普通代码块走行装饰，hover 目标是 `.cm-visual-code-header-line`；
  // - Mermaid 块整块是一个 widget（`.cm-visual-code-block`），里面既没有
  //   `.cm-visual-code-header-line` 也没有 `.cm-code-header-widget`，
  //   少了后两条选择器它的按钮会**永远显示不出来**。
  ".cm-visual-code-header-line:hover .cm-code-copy-btn, .cm-visual-code-header-line:hover .cm-mermaid-toggle, .cm-visual-code-header-line[data-code-block-hovered='true'] .cm-code-copy-btn, .cm-code-header-widget:focus-within .cm-code-copy-btn, .cm-code-header-widget:focus-within .cm-mermaid-toggle, .cm-visual-code-block:hover .cm-code-copy-btn, .cm-visual-code-block:hover .cm-mermaid-toggle, .cm-visual-code-block:focus-within .cm-code-copy-btn, .cm-visual-code-block:focus-within .cm-mermaid-toggle": {
    opacity: "1 !important",
    pointerEvents: "auto !important"
  },
  ".cm-code-copy-btn:hover, .cm-mermaid-toggle:hover": {
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-text-primary)"
  },
  ".cm-code-copy-btn.copied": {
    color: "var(--nexus-status-success-text)",
    borderColor: "var(--nexus-status-success-border)"
  },
  ".cm-code-copy-icon": {
    flexShrink: "0",
    transition: "transform 0.15s ease"
  },
  ".cm-code-copy-check": {
    color: "var(--nexus-status-success-text)"
  },
  ".cm-visual-code-content-line": {
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    position: "relative"
  },
  ".cm-visual-code-content-line[data-code-line-number]::before": {
    content: "attr(data-code-line-number)",
    // 行号的显示开关。`none` 让整个伪元素盒子不生成，左侧留白一起收掉。
    display: "var(--nx-editor-code-line-numbers, inline-block)",
    minWidth: "2.5ch",
    marginRight: "12px",
    paddingRight: "8px",
    borderRight: "1px solid var(--nexus-border-default)",
    color: "var(--nexus-text-muted)",
    textAlign: "right",
    userSelect: "none",
    fontSize: "0.85em"
  },
  // Mermaid 块是**整块一个 widget**（`.cm-visual-code-block`），走不了上面那套
  // 逐行装饰，所以卡片外观要在这里重画一遍，视觉语言与代码块保持一致：
  // 28px 灰 header 栏 + 1px 边框 + 6px 圆角。
  //
  // 用 border + `overflow: hidden` 而不是 margin：块级 widget 的高度测量只算
  // `offsetHeight`、不含 margin，而且 `<pre>` 默认带 `margin: 1em 0`——
  // 不挡住的话，切到源码态时下方内容的点击命中区会整体下移（同 KaTeX 那次）。
  ".cm-visual-code-block": {
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "6px",
    overflow: "hidden",
    backgroundColor: "var(--nexus-bg-canvas)",
    boxSizing: "border-box"
  },
  ".cm-code-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    height: "28px",
    minHeight: "28px",
    padding: "0 12px",
    backgroundColor: "var(--nexus-bg-surface)",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    boxSizing: "border-box"
  },
  // header 右侧的按钮组：两处渲染（预览 widget / 揭示态代码块）共用。
  ".cm-code-header-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flexShrink: "0"
  },
  ".cm-code-language": {
    color: "var(--nexus-text-secondary)",
    fontSize: "0.75em",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    whiteSpace: "nowrap"
  },
  // 预览体：点它会把光标送进块内、露出可编辑的源码，所以给 text 光标做暗示。
  ".cm-mermaid-preview": {
    padding: "12px",
    backgroundColor: "var(--nexus-bg-canvas)",
    overflowX: "auto",
    textAlign: "center",
    cursor: "text",
    boxSizing: "border-box"
  },
  ".cm-visual-code-closing-line": {
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    backgroundColor: "var(--nexus-bg-canvas)",
    height: "22px",
    minHeight: "22px",
    lineHeight: "22px"
  },
  // 缩进式（无围栏）代码块没有 header/closing 行，
  // 由首个与末尾内容行补出卡片上/下边框与圆角，保持与围栏代码块一致的外观。
  ".cm-visual-code-plain-first-line": {
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    paddingTop: "6px"
  },
  ".cm-visual-code-plain-last-line": {
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    paddingBottom: "6px"
  },
  ".cm-code-exit-widget": {
    display: "block",
    height: "100%",
    width: "100%",
    cursor: "text"
  },

  // Quote-nested code block styling:
  // The outer .cm-line maintains the continuous blockquote blue accent bar and light-blue background.
  // The code block is rendered as an inner card embedded inside the blockquote container.
  ".cm-visual-code-line.cm-visual-code-quote-nested": {
    borderLeft: "3.5px solid var(--nexus-accent-indicator)",
    borderRight: "none",
    backgroundColor: "var(--nexus-bg-quote)",
    paddingLeft: "16px",
    paddingRight: "16px",
    position: "relative"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-header-line": {
    display: "block",
    border: "none",
    borderLeft: "3.5px solid var(--nexus-accent-indicator)",
    borderRadius: "0",
    backgroundColor: "var(--nexus-bg-quote)",
    padding: "8px 16px 0 16px",
    height: "auto",
    minHeight: "36px",
    lineHeight: "normal",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-header-line .cm-code-header-widget": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "var(--nexus-bg-surface)",
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    paddingLeft: "12px",
    paddingRight: "12px",
    height: "28px",
    minHeight: "28px",
    lineHeight: "22px",
    boxSizing: "border-box",
    width: "100%"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-content-line": {
    isolation: "isolate",
    position: "relative",
    border: "none",
    borderLeft: "3.5px solid var(--nexus-accent-indicator)",
    backgroundColor: "var(--nexus-bg-quote)",
    paddingLeft: "28px",
    paddingRight: "28px",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-content-line::after": {
    content: "''",
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "16px",
    right: "16px",
    backgroundColor: "var(--nexus-bg-canvas)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    zIndex: "-1",
    pointerEvents: "none",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-closing-line": {
    display: "block",
    border: "none",
    borderLeft: "3.5px solid var(--nexus-accent-indicator)",
    borderRadius: "0",
    backgroundColor: "var(--nexus-bg-quote)",
    padding: "0 16px 8px 16px",
    height: "auto",
    minHeight: "0",
    lineHeight: "0",
    boxSizing: "border-box"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-closing-line .cm-code-exit-widget": {
    display: "block",
    backgroundColor: "var(--nexus-bg-canvas)",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderLeft: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    borderTop: "none",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    height: "8px",
    minHeight: "8px",
    lineHeight: "8px",
    boxSizing: "border-box",
    width: "100%",
    cursor: "pointer"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-first-line": {
    paddingTop: "8px"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-first-line::after": {
    top: "8px",
    borderTop: "1px solid var(--nexus-border-subtle)",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-last-line": {
    paddingBottom: "8px"
  },
  ".cm-visual-code-quote-nested.cm-visual-code-plain-last-line::after": {
    bottom: "8px",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px"
  },
  // Table visual styling & floating controls
  ".cm-visual-table-container": {
    position: "relative",
    margin: "0",
    padding: "34px 0 16px 0",
    overflow: "visible",
    boxSizing: "border-box",
    maxWidth: "100%"
  },
  ".cm-visual-table-scroll": {
    position: "relative",
    overflowX: "auto",
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    borderRadius: "6px",
    "&::-webkit-scrollbar": {
      height: "6px",
      width: "6px"
    },
    "&::-webkit-scrollbar-track": {
      background: "transparent"
    },
    "&::-webkit-scrollbar-thumb": {
      background: "var(--nexus-border-subtle)",
      borderRadius: "3px"
    },
    "&::-webkit-scrollbar-thumb:hover": {
      background: "var(--nexus-border-strong)"
    }
  },
  ".cm-visual-table": {
    borderCollapse: "separate",
    borderSpacing: "0",
    width: "100%",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "6px",
    backgroundColor: "var(--nexus-bg-canvas)",
    // `auto` 是默认，也是改版前的行为：列宽由内容决定。`fixed` 让各列等宽。
    tableLayout: "var(--nx-editor-table-layout, auto)"
  },
  ".cm-visual-table th": {
    backgroundColor: "var(--nexus-bg-surface)",
    color: "var(--nexus-text-primary)",
    fontWeight: "600",
    padding: "8px 12px",
    borderBottom: "2px solid var(--nexus-border-strong)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    minWidth: "3.5em",
    minHeight: "1.6em",
    textAlign: "left",
    boxSizing: "border-box",
    cursor: "cell",
    userSelect: "text",
    "&:last-child": {
      borderRight: "none"
    }
  },
  ".cm-visual-table td": {
    padding: "8px 12px",
    borderBottom: "1px solid var(--nexus-border-subtle)",
    borderRight: "1px solid var(--nexus-border-subtle)",
    minWidth: "3.5em",
    minHeight: "1.6em",
    color: "var(--nexus-text-primary)",
    boxSizing: "border-box",
    cursor: "cell",
    userSelect: "text",
    transition: "background-color 0.15s ease, outline 0.1s ease",
    "&:last-child": {
      borderRight: "none"
    },
    "&:hover": {
      backgroundColor: "var(--nexus-bg-surface-hover)"
    },
    "&.is-active, &:focus-within": {
      outline: "2px solid var(--nexus-accent-indicator)",
      outlineOffset: "-2px"
    }
  },
  ".cm-visual-table tr:last-child td": {
    borderBottom: "none"
  },
  ".cm-table-cell-placeholder": {
    color: "var(--nexus-text-muted)",
    opacity: "0.4",
    pointerEvents: "none",
    userSelect: "none",
    display: "inline-block",
    minWidth: "1em",
    minHeight: "1.2em"
  },
  ".cm-table-inline-math": {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "var(--font-mono)",
    backgroundColor: "var(--nexus-bg-surface)",
    padding: "1px 4px",
    borderRadius: "3px",
    fontSize: "0.9em"
  },
  ".cm-table-math-render": {
    fontStyle: "italic"
  },
  ".cm-table-cell-content": {
    minHeight: "1.4em",
    outline: "none",
    boxSizing: "border-box"
  },
  ".cm-table-cell-editor": {
    width: "100%",
    boxSizing: "border-box",
    background: "transparent",
    border: "none",
    outline: "none",
    color: "inherit",
    font: "inherit",
    padding: "0",
    margin: "0"
  },

  // Floating toolbar
  ".cm-table-toolbar, .cm-table-floating-toolbar": {
    position: "absolute",
    top: "2px",
    left: "0",
    zIndex: "20",
    display: "flex",
    alignItems: "center",
    gap: "3px",
    padding: "3px 6px",
    borderRadius: "6px",
    backgroundColor: "var(--nexus-bg-surface)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    border: "1px solid var(--nexus-border-subtle)",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)", // @constant 抬升阴影，与主题无关
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.15s ease, transform 0.15s ease",
    transform: "translateY(2px)"
  },
  ".cm-visual-table-container:hover .cm-table-toolbar, .cm-visual-table-container:hover .cm-table-floating-toolbar, .cm-visual-table-container:focus-within .cm-table-toolbar, .cm-visual-table-container:focus-within .cm-table-floating-toolbar, .cm-table-toolbar.is-open, .cm-table-floating-toolbar.is-open": {
    opacity: "1 !important",
    pointerEvents: "auto !important",
    transform: "translateY(0)"
  },
  ".cm-table-toolbar button, .cm-table-floating-toolbar button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    height: "24px",
    padding: "0 6px",
    borderRadius: "4px",
    border: "1px solid transparent",
    backgroundColor: "transparent",
    color: "var(--nexus-text-secondary)",
    fontSize: "12px",
    cursor: "pointer",
    boxSizing: "border-box",
    transition: "all 0.15s ease",
    "&:hover:not(:disabled)": {
      backgroundColor: "var(--nexus-bg-surface-hover)",
      color: "var(--nexus-text-primary)"
    },
    "&:disabled": {
      opacity: "0.35",
      cursor: "not-allowed"
    },
    "&.is-active": {
      backgroundColor: "var(--nexus-bg-surface-active)",
      color: "var(--nexus-accent-text)",
      borderColor: "var(--nexus-border-subtle)",
      fontWeight: "500"
    }
  },
  ".cm-table-btn-del-table": {
    color: "var(--nexus-status-error-text) !important",
    "&:hover:not(:disabled)": {
      backgroundColor: "var(--nexus-status-error-bg) !important",
      color: "var(--nexus-status-error-text) !important"
    }
  },

  // 8x10 Grid Resizer popover
  ".cm-table-grid-popover": {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: "0",
    zIndex: "35",
    backgroundColor: "var(--nexus-bg-surface)",
    border: "1px solid var(--nexus-border-subtle)",
    borderRadius: "8px",
    padding: "8px",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)", // @constant 抬升阴影，与主题无关
    display: "none",
    flexDirection: "column",
    gap: "6px",
    userSelect: "none",
    "&.is-visible": {
      display: "flex"
    }
  },
  ".cm-table-grid-matrix": {
    display: "grid",
    gridTemplateColumns: "repeat(8, 16px)",
    gridGap: "3px"
  },
  ".cm-table-grid-cell": {
    width: "16px",
    height: "16px",
    borderRadius: "2px",
    border: "1px solid var(--nexus-border-subtle)",
    backgroundColor: "var(--nexus-bg-canvas)",
    cursor: "pointer",
    transition: "background-color 0.1s ease, border-color 0.1s ease",
    "&.is-highlighted": {
      backgroundColor: "var(--nexus-accent-indicator)",
      borderColor: "var(--nexus-accent-indicator)",
      opacity: "0.85"
    }
  },
  ".cm-table-grid-footer": {
    fontSize: "11px",
    color: "var(--nexus-text-muted)",
    textAlign: "center",
    fontVariantNumeric: "tabular-nums"
  },

  // Floating hover handles (+ buttons)
  ".cm-table-handle-add-col": {
    position: "absolute",
    right: "-14px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "22px",
    height: "28px",
    borderRadius: "4px",
    backgroundColor: "var(--nexus-bg-surface)",
    border: "1px solid var(--nexus-border-subtle)",
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.08)", // @constant 抬升阴影，与主题无关
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease",
    zIndex: "15",
    fontSize: "14px",
    fontWeight: "bold",
    color: "var(--nexus-text-secondary)"
  },
  ".cm-visual-table-container:hover .cm-table-handle-add-col": {
    opacity: "0.75",
    pointerEvents: "auto"
  },
  ".cm-table-handle-add-col:hover": {
    opacity: "1 !important",
    pointerEvents: "auto !important",
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-accent-text)"
  },
  ".cm-table-handle-add-row": {
    position: "absolute",
    bottom: "2px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "28px",
    height: "20px",
    borderRadius: "4px",
    backgroundColor: "var(--nexus-bg-surface)",
    border: "1px solid var(--nexus-border-subtle)",
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.08)", // @constant 抬升阴影，与主题无关
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease",
    zIndex: "15",
    fontSize: "14px",
    fontWeight: "bold",
    color: "var(--nexus-text-secondary)"
  },
  ".cm-visual-table-container:hover .cm-table-handle-add-row": {
    opacity: "0.75",
    pointerEvents: "auto"
  },
  ".cm-table-handle-add-row:hover": {
    opacity: "1 !important",
    pointerEvents: "auto !important",
    backgroundColor: "var(--nexus-bg-surface-hover)",
    color: "var(--nexus-accent-text)"
  },
  
  // Extensions status
  ".nexus-ext-loading": {
    color: "var(--nexus-text-muted)",
    fontStyle: "italic",
    fontSize: "0.9em"
  },
  ".nexus-ext-error": {
    color: "var(--nexus-status-error-text)",
    backgroundColor: "var(--nexus-status-error-bg)",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "0.9em",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px"
  },
  ".nexus-ext-retry": {
    backgroundColor: "var(--nexus-bg-surface-active)",
    color: "var(--nexus-text-primary)",
    border: "none",
    borderRadius: "3px",
    padding: "2px 6px",
    fontSize: "0.85em",
    cursor: "pointer"
  },
  ".nexus-ext-retry:hover": {
    backgroundColor: "var(--nexus-bg-surface-hover)"
  },
  ".tok-keyword, .cm-prism-token.tok-keyword": { color: "var(--nexus-syntax-keyword)" },
  ".tok-control, .cm-prism-token.tok-control": { color: "var(--nexus-syntax-control)" },
  ".tok-string, .cm-prism-token.tok-string": { color: "var(--nexus-syntax-string)" },
  ".tok-comment, .cm-prism-token.tok-comment": { color: "var(--nexus-syntax-comment)", fontStyle: "italic" },
  ".tok-number, .cm-prism-token.tok-number": { color: "var(--nexus-syntax-number)" },
  ".tok-boolean, .cm-prism-token.tok-boolean": { color: "var(--nexus-syntax-bool)" },
  ".tok-function, .cm-prism-token.tok-function": { color: "var(--nexus-syntax-function)" },
  ".tok-builtin, .cm-prism-token.tok-builtin": { color: "var(--nexus-syntax-builtin)" },
  ".tok-operator, .cm-prism-token.tok-operator": { color: "var(--nexus-syntax-operator)" },
  ".tok-punctuation, .cm-prism-token.tok-punctuation": { color: "var(--nexus-syntax-punctuation)" },
  ".tok-type, .cm-prism-token.tok-class-name": { color: "var(--nexus-syntax-type)" },
  ".tok-property, .cm-prism-token.tok-property": { color: "var(--nexus-syntax-property)" },
  ".tok-variable, .cm-prism-token.tok-variable": { color: "var(--nexus-syntax-variable)" },
  ".tok-regex, .cm-prism-token.tok-regex": { color: "var(--nexus-syntax-string)" },

  // Prism fallback token coverage.
  // Prism emits many more token types than Lezer. Any type without an explicit
  // rule would inherit the code-fence marker colour, making a highlighted block
  // look uniformly red/grey. Each entry below mirrors its Lezer counterpart.
  ".tok-function-definition, .cm-prism-token.tok-function-definition, .tok-macro, .cm-prism-token.tok-macro, .tok-function-variable, .cm-prism-token.tok-function-variable": { color: "var(--nexus-syntax-function)" },
  ".tok-key, .cm-prism-token.tok-key, .tok-attr-name, .cm-prism-token.tok-attr-name, .tok-title, .cm-prism-token.tok-title, .tok-property-access, .cm-prism-token.tok-property-access, .tok-literal-property, .cm-prism-token.tok-literal-property": { color: "var(--nexus-syntax-property)" },
  ".tok-attr-value, .cm-prism-token.tok-attr-value, .tok-char, .cm-prism-token.tok-char, .tok-entity, .cm-prism-token.tok-entity, .tok-interpolation, .cm-prism-token.tok-interpolation, .tok-triple-quoted-string, .cm-prism-token.tok-triple-quoted-string, .tok-string-property, .cm-prism-token.tok-string-property, .tok-template-string, .cm-prism-token.tok-template-string, .tok-value, .cm-prism-token.tok-value": { color: "var(--nexus-syntax-string)" },
  ".tok-tag, .cm-prism-token.tok-tag, .tok-selector, .cm-prism-token.tok-selector, .tok-namespace, .cm-prism-token.tok-namespace, .tok-generics, .cm-prism-token.tok-generics, .tok-maybe-class-name, .cm-prism-token.tok-maybe-class-name, .tok-class-reference, .cm-prism-token.tok-class-reference, .cm-prism-token.tok-type, .cm-prism-token.tok-section": { color: "var(--nexus-syntax-type)" },
  ".tok-atrule, .cm-prism-token.tok-atrule, .tok-important, .cm-prism-token.tok-important, .tok-annotation, .cm-prism-token.tok-annotation, .tok-attribute, .cm-prism-token.tok-attribute, .tok-decorator, .cm-prism-token.tok-decorator": { color: "var(--nexus-syntax-control)" },
  ".tok-constant, .cm-prism-token.tok-constant, .tok-symbol, .cm-prism-token.tok-symbol, .tok-version, .cm-prism-token.tok-version, .tok-datetime, .cm-prism-token.tok-datetime, .tok-lifetime, .cm-prism-token.tok-lifetime": { color: "var(--nexus-syntax-number)" },
  ".tok-directive, .cm-prism-token.tok-directive, .tok-method, .cm-prism-token.tok-method, .tok-operation, .cm-prism-token.tok-operation, .tok-rule, .cm-prism-token.tok-rule": { color: "var(--nexus-syntax-keyword)" },
  ".tok-label, .cm-prism-token.tok-label, .tok-parameter, .cm-prism-token.tok-parameter, .tok-package, .cm-prism-token.tok-package, .tok-global-variable, .cm-prism-token.tok-global-variable, .tok-argument, .cm-prism-token.tok-argument": { color: "var(--nexus-syntax-variable)" },
  ".tok-delimiter, .cm-prism-token.tok-delimiter, .tok-punctuator, .cm-prism-token.tok-punctuator": { color: "var(--nexus-syntax-punctuation)" },
  ".tok-url, .cm-prism-token.tok-url": { color: "var(--nexus-syntax-url)" },
  ".tok-doctype, .cm-prism-token.tok-doctype, .tok-prolog, .cm-prism-token.tok-prolog, .tok-cdata, .cm-prism-token.tok-cdata": { color: "var(--nexus-syntax-comment)" },
  ".tok-inserted, .cm-prism-token.tok-inserted": { color: "var(--nexus-status-success-text)" },
  ".tok-deleted, .cm-prism-token.tok-deleted": { color: "var(--nexus-status-error-text)" },
  ".tok-bold, .cm-prism-token.tok-bold": { fontWeight: "bold" },
  ".tok-italic, .cm-prism-token.tok-italic": { fontStyle: "italic" }
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.4em", fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.heading, fontWeight: "bold", color: "var(--nexus-syntax-heading)" },
  { tag: t.strong, fontWeight: "bold", color: "var(--nexus-text-primary)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--nexus-text-primary)" },
  { tag: t.link, color: "var(--nexus-syntax-url)", textDecoration: "underline" },
  { tag: t.url, color: "var(--nexus-syntax-url)" },
  { tag: t.monospace, color: "var(--nexus-syntax-inline-code-text)", backgroundColor: "var(--nexus-syntax-inline-code-bg)" },
  { tag: t.quote, color: "var(--nexus-text-secondary)", fontStyle: "italic" },
  { tag: t.controlKeyword, class: "tok-control", color: "var(--nexus-syntax-control)" },
  { tag: t.moduleKeyword, class: "tok-control", color: "var(--nexus-syntax-module)" },
  { tag: [t.keyword, t.self, t.modifier, t.null, t.atom], class: "tok-keyword", color: "var(--nexus-syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], class: "tok-string", color: "var(--nexus-syntax-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment", color: "var(--nexus-syntax-comment)", fontStyle: "italic" },
  { tag: t.number, class: "tok-number", color: "var(--nexus-syntax-number)" },
  { tag: t.bool, class: "tok-boolean", color: "var(--nexus-syntax-bool)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], class: "tok-function", color: "var(--nexus-syntax-function)" },
  { tag: t.standard(t.variableName), class: "tok-builtin", color: "var(--nexus-syntax-builtin)" },
  { tag: [t.propertyName, t.labelName], class: "tok-property", color: "var(--nexus-syntax-property)" },
  { tag: [t.variableName, t.definition(t.variableName)], class: "tok-variable", color: "var(--nexus-syntax-variable)" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type", color: "var(--nexus-syntax-type)" },
  { tag: t.operator, class: "tok-operator", color: "var(--nexus-syntax-operator)" },
  { tag: t.punctuation, class: "tok-punctuation", color: "var(--nexus-syntax-punctuation)" }
]);

export const editorSyntaxHighlighting = syntaxHighlighting(markdownHighlightStyle, {
  fallback: true
});

// Single unified theme exporter
export function getEditorTheme() {
  return [nexusBaseTheme, editorSyntaxHighlighting];
}
