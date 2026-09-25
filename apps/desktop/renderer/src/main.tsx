import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './App.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find root element');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* 最外层兜底：任何渲染期异常都降级成可见的错误卡片，而不是整窗白屏。 */}
    <ErrorBoundary titleKey="error.appTitle">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
