/**
 * 编辑器格式的图标：行内七枚 + 块级十一枚。
 *
 * 规格照 `section-icons.tsx`：16×16、`viewBox="0 0 24 24"`、线宽 1.8、`stroke="currentColor"`、`fill="none"`。
 * 线宽取 1.8 而不是 `workspace-icons.tsx` 那套 2.0：那套是 14px 的树行 / 侧栏按钮，
 * 这是 16px，按 24 视箱缩下去更细一点才不会糊。
 *
 * **行内六枚画「字形」**（`B` / 斜体的 `I` / 带横线的 `S`）—— 它们在
 * 别的编辑器里已经是同一个意思，用户不必重新学。块级十一枚画「版式」，见文件末尾那一段。
 *
 * **删除线这一枚在 16px 下与「§」有歧义，这是通例、不是没画好。** 真机对比过七种画法
 * （弧更宽 / 单笔 S / 矮胖 S / 放大 S / 腰部交叠…），16px 下全都偏「§」：S 的腰本来就是一个
 * 点，横线正好切在腰上，两碗看着就分家了。32px 起才稳定读成「S 被划掉」。选了**腰部交叠**
 * 那一版（两碗在中心交叉出一段斜脊穿过横线），它是 20px 以上轮廓最正的一版。
 * ⇒ **真机上格式按钮若小于 16px，必须靠 `title` / `aria-label` 兜底**，不能指望图形自解释。
 *
 * **颜色一律走 `currentColor`**，由调用方按「默认 / 悬停 / 激活 / 禁用」给色。图标自持
 * 颜色就得多写几条覆盖规则，还会漏掉「激活」那一态 —— 而激活态的视觉与 `aria-pressed`
 * 必须从同一个表达式派生，漏一处就两处不一致。
 */

const PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/** 加粗：字母 `B`。上碗窄、下碗宽，与真实字形一致 —— 两碗等宽会读成 `8`。 */
export const BoldIcon = (
  <svg {...PROPS}>
    <path d="M8 4.5h4.2a3.5 3.5 0 0 1 0 7H8z" />
    <path d="M8 11.5h5a3.75 3.75 0 0 1 0 7.5H8z" />
    <path d="M8 4.5v14.5" />
  </svg>
);

/** 斜体：斜体的 `I` —— 上下两条衬线横杆 + 中间那根向右倾的主干。 */
export const ItalicIcon = (
  <svg {...PROPS}>
    <line x1="10" y1="5.5" x2="19" y2="5.5" />
    <line x1="5" y1="18.5" x2="14" y2="18.5" />
    <line x1="15" y1="5.5" x2="9" y2="18.5" />
  </svg>
);

/** 删除线：字母 `S` 被一根横线穿过。横线画满整宽，读的是「划掉」而不是「减号」。 */
export const StrikeIcon = (
  <svg {...PROPS}>
    <path d="M17.6 7.2c-.9-1.7-3-2.8-5.6-2.8-2.9 0-5 1.4-5 3.3 0 1.9 2 3 5.3 3.8 1.6.4 2.3.9 2.3 1.6" />
    <path d="M6.4 16.8c.9 1.7 3 2.8 5.6 2.8 2.9 0 5-1.4 5-3.3 0-1.9-2-3-5.3-3.8-1.6-.4-2.3-.9-2.3-1.6" />
    <line x1="3.5" y1="12" x2="20.5" y2="12" />
  </svg>
);

/**
 * 高亮：一支斜置的荧光笔 + 笔下一道加粗横线。
 *
 * **不能画字母 `H`** —— 标题那六枚已经占了它（`H` + 层级数字），并排只差一条底线。
 * 荧光笔是跨编辑器的「高亮」符号（同 Material 的 `format_ink_highlighter`）：底线**比其余
 * 线条粗一档**（2.4 vs 1.8），读的是「笔在纸下划出一道底色」，而不是 `StrikeIcon` 那种
 * **穿过**字形的删除线。
 */
export const HighlightIcon = (
  <svg {...PROPS}>
    <path d="M13.5 4.5 19.5 10.5 11.5 18.5H6v-5.5z" />
    <path d="M4 21.5h16" strokeWidth={2.4} />
  </svg>
);

/**
 * 行内代码：一对尖括号。**不画反引号本身** —— 反引号在 16px 下就是两个点，
 * 与「省略号」分不开；尖括号是跨编辑器的「代码」符号，不必重新学。
 */
export const InlineCodeIcon = (
  <svg {...PROPS}>
    <path d="M9 7 4.5 12 9 17" />
    <path d="M15 7l4.5 5-4.5 5" />
  </svg>
);

/**
 * 清除格式：字母 `T` 被一根斜线划掉（Material 的 `format_clear`）。
 *
 * 斜线**两端都超出 `T` 的包围盒**（`y` 从 4.5 到 19.5，`T` 只占 6.5–18），
 * 否则 16px 下斜线缩在字形里，会读成「T 的一笔」而不是「划掉」。
 */
export const ClearFormatIcon = (
  <svg {...PROPS}>
    <path d="M6 6.5h11" />
    <path d="M11.5 6.5v11.5" />
    <line x1="19.5" y1="4.5" x2="4.5" y2="19.5" />
  </svg>
);

/**
 * 插入链接：两节扣在一起的链环（Feather 的 `link`）。
 *
 * 与前面五枚不同，这一枚**没有字形可借** —— 链接不是字符。链环是跨编辑器 / 浏览器的
 * 通用符号（地址栏、邮件客户端都用它），不需要重新学；试过的另两种画法（`[ ]` 方括号、
 * 带箭头的方框）在 16px 下分别读成「方框」与「分享」。
 */
export const LinkIcon = (
  <svg {...PROPS}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

/**
 * 引用与三个列表：版式这一路剩下的四枚（正文与标题六枚见上）。**行内画「字形」，
 * 块级这一路画「版式」** —— 块级动作没有字形可借（「变成引用」不是一个字符），
 * 只能画它在版面上的样子：左边一条竖杠、左边一排点、左边一排勾。
 * 这一套是跨编辑器的通例，用户不必重新学。
 *
 * 三个列表图标**共用同一条文字列**（`x=10.5` 起，宽 9.5），只有左侧的标记不同 ——
 * 三枚并排放在工具栏上，文字列对不齐会比标记不同更显眼。标题那六枚同理，共用一个 `H`。
 *
 * `OrderedListIcon` / `TaskListIcon` 的几何取自 Lucide 的 `list-ordered` / `list-checks`
 * （**三行文字、两个标记**，不是三行三标记）：16px 下三个数字或三个勾挤成一列会糊成噪点，
 * 两个标记已经足够表达「这是一串有编号 / 有勾选的条目」。许可证同 `LinkIcon` 那条。
 */

/** 标题六枚共用的 `H`：缩到左侧，右边留给层级数字。六枚必须逐点相同，否则并排像六种按钮。 */
const headingH = (
  <>
    <path d="M3.5 5.5v13" />
    <path d="M10.5 5.5v13" />
    <path d="M3.5 12h7" />
  </>
);

/**
 * 正文：段落符号 `¶` —— 一个圆环 + 一条贯通的竖线。
 *
 * 与标题那一组同属「版式」：正文不是一个字符，而是「这一段是普通段落」。
 * **不画 `T`** —— `ClearFormatIcon` 正是 `T` 被斜线划掉，16px 下只差那条线。
 */
export const ParagraphIcon = (
  <svg {...PROPS}>
    <circle cx="10.5" cy="8.5" r="4" />
    <path d="M14.5 4.5v15" />
  </svg>
);

/**
 * 标题 1–6：`H` + 层级数字。数字以**直线段**为主 —— 16px 下曲线的抗锯齿会把
 * `2` `3` `5` `6` 的弧糊在一起（`OrderedListIcon` 只画两个数字正是这个原因）。
 */
export const Heading1Icon = (
  <svg {...PROPS}>
    {headingH}
    <path d="M15 8.5 17.25 6.5V18" />
  </svg>
);

export const Heading2Icon = (
  <svg {...PROPS}>
    {headingH}
    <path d="M13.25 9.75c0-3.25 7.25-3 7.25 0 0 3.25-7.25 5.25-7.25 8.25h7.25" />
  </svg>
);

export const Heading3Icon = (
  <svg {...PROPS}>
    {headingH}
    <path d="M13.25 8.25c1.25-2.75 7.25-2.25 7.25.75 0 1.75-2.5 2.5-3.75 2.5" />
    <path d="M16.75 11.5c2.5 0 3.75 1.5 3.75 3.25 0 2.25-2 3.5-7.25 2.5" />
  </svg>
);

export const Heading4Icon = (
  <svg {...PROPS}>
    {headingH}
    <path d="M18 6.5 13.25 13.75h7.25" />
    <path d="M18 6.5V18" />
  </svg>
);

export const Heading5Icon = (
  <svg {...PROPS}>
    {headingH}
    <path d="M20.5 6.5h-7.25v4.75" />
    <path d="M13.25 11.25c4.75 0 7.25 1.25 7.25 3.5s-2.5 3.75-7.25 2.5" />
  </svg>
);

export const Heading6Icon = (
  <svg {...PROPS}>
    {headingH}
    <path d="M19.75 6.5c-4.75.25-6.5 3.5-6.5 6.5" />
    <path d="M13.25 13c0 3.5 1.5 5 3.5 5s3.5-1.5 3.5-3.5-1.5-3.5-3.5-3.5c-2 0-3.5 1.5-3.5 3.5" />
  </svg>
);

/** 引用：左侧一条贯通竖杠 + 三行文字（末行短），就是引用段落在版面上的样子。 */
export const QuoteIcon = (
  <svg {...PROPS}>
    <path d="M5 5.5v13" />
    <path d="M9.5 8.5h9.5" />
    <path d="M9.5 12h9.5" />
    <path d="M9.5 15.5h6" />
  </svg>
);

/** 无序列表：三行文字，每行左边一个实心点。 */
export const BulletListIcon = (
  <svg {...PROPS}>
    <circle cx="4.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
    <path d="M10.5 6.5h9.5" />
    <path d="M10.5 12h9.5" />
    <path d="M10.5 17.5h9.5" />
  </svg>
);

/** 有序列表：三行文字，左侧一个 `1` 与一个 `2`。 */
export const OrderedListIcon = (
  <svg {...PROPS}>
    <path d="M10.5 6h9.5" />
    <path d="M10.5 12h9.5" />
    <path d="M10.5 18h9.5" />
    <path d="M4 10h2" />
    <path d="M4 6h1v4" />
    <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
  </svg>
);

/** 任务列表：三行文字，左侧两个勾。勾与复选框的区别在于「勾」自带「已完成」的意思。 */
export const TaskListIcon = (
  <svg {...PROPS}>
    <path d="M3 7l2 2 4-4" />
    <path d="M3 17l2 2 4-4" />
    <path d="M10.5 6h9.5" />
    <path d="M10.5 12h9.5" />
    <path d="M10.5 18h9.5" />
  </svg>
);
