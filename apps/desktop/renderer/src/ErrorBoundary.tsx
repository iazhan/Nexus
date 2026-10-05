import React from 'react';
import { localeManager } from './platform.js';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * 变化时自动清除错误状态。
   * 传 surfaceKind 就能让「切回 Source 模式」成为一条真实的恢复路径——
   * 否则错误是确定性的，Retry 只会再崩一次。
   */
  resetKey?: unknown;
  /**
   * 错误标题的词典键。收键而不是收文案：这个组件在 `main.tsx` 里包着 `<App />`，
   * 拿不到 `useLocale()`，只能自己订阅 `localeManager` 才跟得上语言切换。
   */
  titleKey?: string;
  /**
   * 自定义兜底卡片。**在错误发生之后调用** —— 所以函数体里读到的外部状态（注册表、
   * 全局单例）已经是新的。这正是「第一次加载就失败也能当场换成对的卡」所依赖的：
   * 闭包里捕获的状态是**出错前**那一版，读到的会是 `false`。
   *
   * 返回 `null` 表示「用默认卡」—— 只关心某一类错误的调用方不必把默认卡的标记抄一遍。
   */
  fallback?: (error: Error) => React.ReactNode;
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

  /**
   * 语言切换时重渲染兜底卡片。
   *
   * 这个组件在 `main.tsx` 里包着 `<App />`，没有 `useLocale()` 可用；
   * 不订阅的话，切语言后错误卡片会留着上一种语言的文案——
   * 和编辑器 widget 里「文案走 i18n 必须把 locale 纳入重渲染判据」是同一个坑。
   */
  public componentDidMount(): void {
    this.unsubscribeLocale = localeManager.subscribe(() => this.forceUpdate());
  }

  public componentWillUnmount(): void {
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = undefined;
  }

  private unsubscribeLocale: (() => void) | undefined;

  private readonly handleRetry = (): void => {
    this.setState({ error: null });
  };

  public render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const custom = this.props.fallback?.(error);
    if (custom !== null && custom !== undefined) {
      return <>{custom}</>;
    }

    const t = (key: string) => localeManager.t(key);

    return (
      <div className="nexus-state-container">
        <div className="nexus-error-card" role="alert">
          <span className="error-title">{t(this.props.titleKey ?? 'error.editorCrashed')}</span>
          <p className="error-description">{error.message}</p>
          <p className="error-description">{t('error.recoveryHint')}</p>
          <button type="button" className="nexus-retry-btn" onClick={this.handleRetry}>
            {t('editor.retry')}
          </button>
        </div>
      </div>
    );
  }
}
