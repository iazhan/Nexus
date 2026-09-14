import React, { useMemo, useState, useCallback } from 'react';
import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type MarkdownListItem,
  type MarkdownParseResult
} from '@nexus/markdown';

export interface WysiwygViewProps {
  source: string;
  className?: string;
}

export const WysiwygView: React.FC<WysiwygViewProps> = ({
  source,
  className
}) => {
  const parseResult: MarkdownParseResult = useMemo(
    () => parseMarkdown(source),
    [source]
  );

  // State to track image load failures
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const handleImageError = useCallback((imgKey: string) => {
    setFailedImages((prev) => ({ ...prev, [imgKey]: true }));
  }, []);

  const renderInline = useCallback(
    (node: MarkdownInlineNode, key: number | string): React.ReactNode => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'bold':
          return (
            <strong key={key} className="nexus-wysiwyg-bold">
              {node.children.map(renderInline)}
            </strong>
          );
        case 'italic':
          return (
            <em key={key} className="nexus-wysiwyg-italic">
              {node.children.map(renderInline)}
            </em>
          );
        case 'inline-code':
          return (
            <code key={key} className="nexus-wysiwyg-inline-code">
              {node.value}
            </code>
          );
        case 'link': {
          if (node.isBlocked || !node.safeHref) {
            return (
              <span
                key={key}
                className="nexus-wysiwyg-link blocked"
                title="Blocked potentially unsafe link protocol"
              >
                {node.children.map(renderInline)}
              </span>
            );
          }
          return (
            <a
              key={key}
              href={node.safeHref}
              title={node.title}
              target="_blank"
              rel="noopener noreferrer"
              className="nexus-wysiwyg-link"
              onClick={(e) => {
                // Prevent navigation inside the electron shell preview
                e.preventDefault();
              }}
            >
              {node.children.map(renderInline)}
            </a>
          );
        }
        case 'image': {
          const imgKey = `${key}_${node.src}`;
          const isFailed = failedImages[imgKey] || node.isBlocked || !node.safeSrc;

          if (isFailed) {
            return (
              <span
                key={key}
                className="nexus-wysiwyg-image-fallback"
                title={node.isBlocked ? 'Blocked unsafe image URL' : 'Image failed to load'}
              >
                🖼️ {node.alt || 'Image'}
              </span>
            );
          }

          return (
            <img
              key={key}
              src={node.safeSrc ?? undefined}
              alt={node.alt}
              title={node.title}
              className="nexus-wysiwyg-image"
              onError={() => handleImageError(imgKey)}
            />
          );
        }
        case 'inline-math':
          return (
            <span
              key={key}
              className="nexus-wysiwyg-math-inline"
              title={`Math formula: ${node.formula}`}
            >
              <span className="math-delim">$</span>
              <span className="math-body">{node.formula}</span>
              <span className="math-delim">$</span>
            </span>
          );
        case 'wikilink':
          return (
            <span
              key={key}
              className="nexus-wysiwyg-wikilink"
              title={`Wiki link to: ${node.target}`}
            >
              <span className="wiki-delim">[[</span>
              <span className="wiki-text">{node.alias ?? node.target}</span>
              <span className="wiki-delim">]]</span>
            </span>
          );
        case 'raw':
          return node.value;
      }
    },
    [failedImages, handleImageError]
  );

  const renderListItem = useCallback(
    (item: MarkdownListItem, idx: number): React.ReactNode => {
      return (
        <li
          key={idx}
          className={`nexus-wysiwyg-list-item ${item.task ? 'task-item' : ''}`}
        >
          {item.task && (
            <input
              type="checkbox"
              checked={item.checked}
              readOnly
              className="nexus-task-checkbox"
            />
          )}
          <div className="nexus-list-content">
            {item.children.map((child, cIdx) =>
              'type' in child &&
              (child.type === 'heading' ||
                child.type === 'paragraph' ||
                child.type === 'blockquote' ||
                child.type === 'list' ||
                child.type === 'code-block' ||
                child.type === 'block-math' ||
                child.type === 'table' ||
                child.type === 'raw')
                ? renderBlock(child as MarkdownBlockNode, cIdx)
                : renderInline(child as MarkdownInlineNode, cIdx)
            )}
          </div>
        </li>
      );
    },
    [renderInline]
  );

  const renderBlock = useCallback(
    (node: MarkdownBlockNode, key: number | string): React.ReactNode => {
      switch (node.type) {
        case 'heading': {
          const content = node.children.map(renderInline);
          switch (node.depth) {
            case 1:
              return <h1 key={key} className="nexus-wysiwyg-h1">{content}</h1>;
            case 2:
              return <h2 key={key} className="nexus-wysiwyg-h2">{content}</h2>;
            case 3:
              return <h3 key={key} className="nexus-wysiwyg-h3">{content}</h3>;
            case 4:
              return <h4 key={key} className="nexus-wysiwyg-h4">{content}</h4>;
            case 5:
              return <h5 key={key} className="nexus-wysiwyg-h5">{content}</h5>;
            case 6:
              return <h6 key={key} className="nexus-wysiwyg-h6">{content}</h6>;
          }
          break;
        }
        case 'paragraph':
          return (
            <p key={key} className="nexus-wysiwyg-p">
              {node.children.map(renderInline)}
            </p>
          );
        case 'blockquote':
          return (
            <blockquote key={key} className="nexus-wysiwyg-blockquote">
              {node.children.map(renderBlock)}
            </blockquote>
          );
        case 'list': {
          if (node.ordered) {
            return (
              <ol
                key={key}
                start={node.start}
                className="nexus-wysiwyg-ol"
              >
                {node.items.map(renderListItem)}
              </ol>
            );
          }
          return (
            <ul key={key} className="nexus-wysiwyg-ul">
              {node.items.map(renderListItem)}
            </ul>
          );
        }
        case 'code-block':
          return (
            <div key={key} className="nexus-wysiwyg-code-container">
              {node.language && (
                <div className="nexus-code-header">
                  <span className="nexus-code-lang">{node.language}</span>
                </div>
              )}
              <pre className="nexus-wysiwyg-pre">
                <code
                  className={
                    node.language ? `language-${node.language}` : undefined
                  }
                >
                  {node.value}
                </code>
              </pre>
            </div>
          );
        case 'block-math':
          return (
            <div
              key={key}
              className="nexus-wysiwyg-math-block"
              title={`Math block: ${node.formula}`}
            >
              <div className="math-header">Display Math</div>
              <pre className="math-formula">{node.formula}</pre>
            </div>
          );
        case 'table':
          return (
            <div key={key} className="nexus-wysiwyg-table-wrapper">
              <table className="nexus-wysiwyg-table">
                <thead>
                  <tr>
                    {node.headers.map((headerCell, hIdx) => (
                      <th
                        key={hIdx}
                        style={{ textAlign: node.align[hIdx] ?? undefined }}
                      >
                        {headerCell.map(renderInline)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {node.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          style={{ textAlign: node.align[cIdx] ?? undefined }}
                        >
                          {cell.map(renderInline)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        case 'raw':
          return (
            <pre key={key} className="nexus-wysiwyg-raw">
              {node.value}
            </pre>
          );
      }
    },
    [renderInline, renderListItem]
  );

  const hasDiagnostics = parseResult.diagnostics.length > 0;

  return (
    <div
      className={`nexus-wysiwyg-container ${className ?? ''}`}
      data-testid="nexus-wysiwyg-view"
    >
      {hasDiagnostics && (
        <div className="nexus-wysiwyg-diagnostics-banner" role="status">
          {parseResult.diagnostics.map((diag, idx) => (
            <span key={idx} className={`diag-item ${diag.severity}`}>
              {diag.severity.toUpperCase()}: {diag.message}
            </span>
          ))}
        </div>
      )}

      <div className="nexus-wysiwyg-content">
        {parseResult.root.children.length === 0 ? (
          <div className="nexus-wysiwyg-empty">
            <p>Document is empty</p>
          </div>
        ) : (
          parseResult.root.children.map(renderBlock)
        )}
      </div>
    </div>
  );
};
