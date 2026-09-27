import React from 'react';
import { useLocale } from '../hooks.js';
import type { ViewerDocumentDescriptor } from './types.js';

export interface ViewerPlaceholderProps {
  readonly document: ViewerDocumentDescriptor;
}

/**
 * 「这个类型已识别，但还没有渲染器」的如实说明。
 *
 * P3-05 只搭框架，所以**所有**附件类型都会落到这里；P3-06 注册图片渲染器之后
 * 只剩 pdf / docx 走它，P3-07 / P3-08 注册完就再也没有类型走它 ——
 * 那时这个组件仍然要留着，因为用户的工作区里随时可能出现在白名单内、
 * 但当前构建没有打包渲染器的类型（§7 第 9 条的懒加载正是这个意思）。
 *
 * 为什么不复用「工作区空态」的文案：那是「还没选文件」，这是「选了但看不了」。
 * 两者混起来会让用户以为文件没打开成功。
 *
 * 布局沿用 `.nexus-workspace-empty` 那几个类：它是「内容区里的居中纵向堆叠」这个
 * 布局原语，两个空态用的是同一套间距与配色。类名里的 workspace 是历史包袱，
 * 重命名会牵动既有断言而收益只有名字好看 —— 真正的识别钩子是
 * `.nexus-viewer-placeholder` 与 `data-viewer-type`。
 */
export const ViewerPlaceholder: React.FC<ViewerPlaceholderProps> = ({ document: doc }) => {
  const { t } = useLocale();
  const typeLabel = t(`document.type.${doc.type}`);

  return (
    <div
      className="nexus-workspace-empty nexus-viewer-placeholder"
      data-viewer-type={doc.type}
    >
      <span className="nexus-workspace-empty-title">{typeLabel}</span>
      <code className="nexus-workspace-empty-path">{doc.path}</code>
      <p className="nexus-workspace-empty-note">
        {t('viewer.pending', { type: typeLabel })}
      </p>
    </div>
  );
};
