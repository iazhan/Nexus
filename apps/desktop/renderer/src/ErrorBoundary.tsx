import React from 'react';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * 变化时自动清除错误状态。
   * 传 surfaceKind 就能让「切回 Source 模式」成为一条真实的恢复路径——
   * 否则错误是确定性的，Retry 只会再崩一次。
   */
  resetKey?: unknown;
  title?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 渲染期异常的最后一道防线。
 *
 * 没有它时，任何一个组件在 render 阶段抛错，React 都会卸载整棵树，
 * `#root` 变空 → 整窗白屏，用户既看不到原因，也没有任何恢复入口。
 *
 * 触发过的真实案例：Visual 投影在 `EditorState` 构造阶段抛错
 * （`buildVisualProjection` 的装饰排序契约被破坏，
 * 见 packages/editor/src/visual-projection.ts）。那一次表现为
 * 「用视觉模式打开 markdown-syntax-reference.md 直接白屏」。
 *
 * 注意这是**兜底**，不是修复手段：投影层仍然必须自己保证不抛。
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 白屏时控制台是唯一的现场，务必留下完整堆栈。
    console.error('[Nexus] renderer crashed during render:', error, info.componentStack);
  }

  public componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  public render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div className="nexus-state-container">
        <div className="nexus-error-card" role="alert">
          <span className="error-title">{this.props.title ?? 'Editor crashed'}</span>
          <p className="error-description">{error.message}</p>
          <p className="error-description">
            Switch the editor surface (Mod-M) or reopen the file to recover.
          </p>
          <button type="button" className="nexus-retry-btn" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
