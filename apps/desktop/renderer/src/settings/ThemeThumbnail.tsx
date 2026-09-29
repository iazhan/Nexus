import React from 'react';
import type { NexusThemeScheme } from '@nexus/theme';

/**
 * 主窗口缩略图：一扇（或两扇并排的）小窗，画的是**某套种子的真实配色**。
 *
 * 一扇窗 = 一扇主窗口，分区照真窗口来：标题栏 / 活动栏 + 侧栏 + 编辑区 / 状态栏，对应
 * `.nexus-header-bar`、`.nexus-activity-bar`、`.nexus-activity-panel`、`.nexus-main-content`、
 * `.nexus-status-bar`。底色也照这些区域的 token 语义取种子：`bg-surface` = `base01`（标题栏、
 * 侧栏、状态栏），`bg-canvas` = `base00`（活动栏、编辑区），内部分隔线 = `base02`（base16 的
 * 「默认边框」槽位）。
 *
 * 所以缩略图是「**这套主题下主窗口长什么样**」，不是一张通用的示意图。活动栏与编辑区同色
 * （真窗口里就是如此），靠中间那条侧栏隔开才分得出来 —— 给它换个颜色反而与真窗口不符。
 *
 * **被画的那扇窗全部走种子内联样式**：`--nexus-*` 只有当前主题一套，画不出别的主题。分隔线同理
 * 用种子而不是 `--nexus-border-*`，那是窗口内部的东西。只有缩略图外框与两扇之间的分隔线用当前
 * 主题的 token —— 那些属于这个控件本身，在 CSS 里。
 *
 * **两扇并排 = 「跟随系统」**，不是把一扇切成两半：切一半会读成「深色的壳配浅色的内容」，
 * 那是混搭，不是跟随系统。单变体预设与用户主题只有一套种子，也就只画一扇 —— 这正好是
 * 「没得切」的样子，不用另画一个灰掉的占位。
 */

/** 活动栏里的图标点、侧栏的列表项、编辑区的正文行。长短由 CSS 按 `nth-child` 错开。 */
const RAIL_ICONS = [0, 1, 2, 3];
const SIDE_LINES = [0, 1, 2, 3];
const EDITOR_LINES = [0, 1, 2, 3, 4];

const MiniWindow: React.FC<{ scheme: NexusThemeScheme }> = ({ scheme }) => {
  const { palette } = scheme;
  const edge = { borderColor: palette.base02 };
  return (
    <span className="nexus-theme-mini" style={{ backgroundColor: palette.base00 }}>
      <span
        className="nexus-theme-mini-titlebar"
        style={{ backgroundColor: palette.base01, ...edge }}
      >
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
      </span>

      <span className="nexus-theme-mini-body">
        <span className="nexus-theme-mini-rail">
          {RAIL_ICONS.map((icon) => (
            <span
              key={icon}
              className="nexus-theme-mini-icon"
              style={{ backgroundColor: palette.base04 }}
            />
          ))}
        </span>
        <span className="nexus-theme-mini-side" style={{ backgroundColor: palette.base01 }}>
          {SIDE_LINES.map((line) => (
            <span
              key={line}
              className="nexus-theme-mini-line"
              style={{ backgroundColor: palette.base03 }}
            />
          ))}
        </span>
        <span className="nexus-theme-mini-editor">
          {/* 第一行画成 Markdown 标题（更亮更宽）：编辑区里全是一样的细线，看起来像任何一款
              编辑器；有一行标题才像「打开着一篇文档」。 */}
          <span className="nexus-theme-mini-heading" style={{ backgroundColor: palette.base05 }} />
          {EDITOR_LINES.map((line) => (
            <span
              key={line}
              className="nexus-theme-mini-line"
              style={{ backgroundColor: palette.base04 }}
            />
          ))}
        </span>
      </span>

      <span
        className="nexus-theme-mini-status"
        style={{ backgroundColor: palette.base01, ...edge }}
      >
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
        <span className="nexus-theme-mini-chip" style={{ backgroundColor: palette.base04 }} />
      </span>
    </span>
  );
};

export const ThemeThumbnail: React.FC<{
  /** 要画的种子，一扇窗一套。自动模式下两套 = 两扇并排，先暗后亮。 */
  schemes: readonly NexusThemeScheme[];
  /**
   * 高度档。模式卡片 92px、预设卡片 64px —— 后者要小一半：预设网格有五十多张卡，
   * 缩略图高度直接乘进行数，而 64px 是**不裁掉编辑区最后一行**的下限（见 CSS）。
   */
  size: 'mode' | 'card';
}> = ({ schemes, size }) => (
  <span className={`nexus-theme-thumb nexus-theme-thumb-${size}`} aria-hidden="true">
    {schemes.map((scheme, index) => (
      <span key={index} className="nexus-theme-thumb-pane">
        <MiniWindow scheme={scheme} />
      </span>
    ))}
  </span>
);
