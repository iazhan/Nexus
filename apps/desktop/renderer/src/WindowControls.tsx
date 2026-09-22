import React, { useEffect, useState } from 'react';

interface WindowControlsProps {
  /** 由调用方按当前语言传入，保证 tooltip 跟随应用内语言切换。 */
  labels: {
    minimize: string;
    maximize: string;
    restore: string;
    close: string;
  };
}

const iconProps = {
  width: 10,
  height: 10,
  viewBox: '0 0 10 10',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/**
 * 窗口按钮点击后立即移除焦点：
 * 否则最小化再还原窗口后，按钮会带着持久焦点环，且 Enter/Space 会重复触发窗口动作。
 */
const createWindowAction = (action: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
  event.currentTarget.blur();
  action();
};

/**
 * 自绘窗口按钮（最小化 / 最大化·还原 / 关闭）。
 * 不使用原生 Window Controls Overlay，其 tooltip 只跟随系统语言且无法运行时切换。
 */
export const WindowControls: React.FC<WindowControlsProps> = ({ labels }) => {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;

    void window.nexus?.getWindowState?.()
      .then((state) => {
        if (!disposed) setMaximized(state.maximized);
      })
      .catch(() => {
        // 桥接不可用时保持默认状态，不影响编辑
      });

    const unsubscribe = window.nexus?.onWindowStateChanged?.((state) => {
      setMaximized(state.maximized);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return (
    <div className="nexus-window-controls">
      <button
        type="button"
        className="nexus-window-button"
        aria-label={labels.minimize}
        title={labels.minimize}
        onClick={createWindowAction(() => window.nexus?.minimizeWindow?.())}
      >
        <svg {...iconProps}>
          <line x1="0.5" y1="5" x2="9.5" y2="5" />
        </svg>
      </button>

      <button
        type="button"
        className="nexus-window-button"
        aria-label={maximized ? labels.restore : labels.maximize}
        title={maximized ? labels.restore : labels.maximize}
        onClick={createWindowAction(() => window.nexus?.maximizeWindow?.())}
      >
        <svg {...iconProps}>
          {maximized ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" />
              <polyline points="2.5,2.5 2.5,0.5 9.5,0.5 9.5,7.5 7.5,7.5" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" />
          )}
        </svg>
      </button>

      <button
        type="button"
        className="nexus-window-button nexus-window-button-close"
        aria-label={labels.close}
        title={labels.close}
        onClick={createWindowAction(() => window.nexus?.closeWindow?.())}
      >
        <svg {...iconProps}>
          <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
          <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
        </svg>
      </button>
    </div>
  );
};
