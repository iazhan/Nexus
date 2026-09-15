import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  parseMarkdown,
  type MarkdownBlockNode,
  type MarkdownInlineNode,
  type MarkdownListItem,
  type MarkdownParseResult
} from '@nexus/markdown';
import {
  serializeEditableInlineContent,
  buildBlockReplacement,
  updateSourceWithBlock,
  getBlockNodeKey
} from './edit-model.js';

export interface WysiwygViewProps {
  source: string;
  onChange?: (nextSource: string) => void;
  className?: string;
  readOnly?: boolean;
}

export const WysiwygView: React.FC<WysiwygViewProps> = ({
  source,
  onChange,
  className,
  readOnly = false
}) => {
  const parseResult: MarkdownParseResult = useMemo(
    () => parseMarkdown(source),
    [source]
  );

  // Lifecycle guards and cancellation tracking
  const isMountedRef = useRef(true);
  const cancelledKeysRef = useRef<Set<string>>(new Set());
  const [renderEpoch, setRenderEpoch] = useState(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // State to track image load failures
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const handleImageError = useCallback((imgKey: string) => {
    setFailedImages((prev) => ({ ...prev, [imgKey]: true }));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>, nodeKey: string) => {
      if (e.key === 'Enter') {
        // Prevent illegal nested DOM and commit edit cleanly
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        // Cancel editing and revert to source prior to edit
        e.preventDefault();
        cancelledKeysRef.current.add(nodeKey);
        e.currentTarget.blur();
        setRenderEpoch((prev) => prev + 1);
      }
    },
    []
  );

  const handleBlur = useCallback(
    (
      e: React.FocusEvent<HTMLElement>,
      blockNode: MarkdownBlockNode,
      nodeKey: string
    ) => {
      if (cancelledKeysRef.current.has(nodeKey)) {
        cancelledKeysRef.current.delete(nodeKey);
        return;
      }

      if (readOnly || !onChange) return;

      try {
        const newInlines = serializeEditableInlineContent(e.currentTarget);
        const replacement = buildBlockReplacement(blockNode, newInlines);
        const nextSource = updateSourceWithBlock(source, blockNode.range, replacement);

        if (nextSource !== source && isMountedRef.current) {
          onChange(nextSource);
        }
      } catch (err) {
        console.error('Failed to commit WYSIWYG block edit:', err);
        setRenderEpoch((prev) => prev + 1);
      }
    },
    [readOnly, onChange, source]
  );

  const handleBlockClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (readOnly) return;
      e.stopPropagation();
    },
    [readOnly]
  );

  const renderInline = useCallback(
    (node: MarkdownInlineNode, key: number | string): React.ReactNode => {
      switch (node.type) {
        case 'text': {
          if (node.escaped) {
            return (
              <span
                key={key}
                className="nexus-wysiwyg-escaped"
                data-node-type="escaped"
                data-raw={node.raw}
                data-value={node.value}
              >
                {node.value}
              </span>
            );
          }
          return node.value;
        }
        case 'bold': {
          const delim =
            typeof node.raw === 'string' && node.raw.startsWith('__') ? '__' : '**';
          return (
            <strong
              key={key}
              className="nexus-wysiwyg-bold"
              data-node-type="bold"
              data-delim={delim}
            >
              {node.children.map(renderInline)}
            </strong>
          );
        }
        case 'italic': {
          const delim =
            typeof node.raw === 'string' && node.raw.startsWith('_') ? '_' : '*';
          return (
            <em
              key={key}
              className="nexus-wysiwyg-italic"
              data-node-type="italic"
              data-delim={delim}
            >
              {node.children.map(renderInline)}
            </em>
          );
        }
        case 'inline-code': {
          const raw = node.raw || '';
          const openMatch = raw.match(/^`+/);
          const origDelimLen = openMatch ? openMatch[0].length : 1;
          const fenceStr = openMatch ? openMatch[0] : '`';
          const origInner =
            openMatch && raw.endsWith(fenceStr) && raw.length >= origDelimLen * 2
              ? raw.slice(origDelimLen, raw.length - origDelimLen)
              : '';
          const origHadPadding =
            origInner.length >= 2 &&
            origInner.startsWith(' ') &&
            origInner.endsWith(' ') &&
            origInner.trim().length > 0;

          return (
            <code
              key={key}
              className="nexus-wysiwyg-inline-code"
              data-node-type="inline-code"
              data-raw={raw}
              data-delim-len={origDelimLen}
              data-had-padding={origHadPadding ? 'true' : 'false'}
              data-value={node.value}
            >
              {node.value}
            </code>
          );
        }
        case 'link': {
          if (node.isBlocked || !node.safeHref) {
            return (
              <span
                key={key}
                className="nexus-wysiwyg-link blocked"
                title="Blocked potentially unsafe link protocol"
                contentEditable={false}
                data-node-type="link"
                data-raw={node.raw}
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
              contentEditable={false}
              data-node-type="link"
              data-raw={node.raw}
              onClick={(e) => {
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
                contentEditable={false}
                data-node-type="image"
                data-raw={node.raw}
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
              contentEditable={false}
              data-node-type="image"
              data-raw={node.raw}
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
              contentEditable={false}
              data-node-type="inline-math"
              data-raw={node.raw || `$${node.formula}$`}
            >
              <span className="math-delim">$</span>
              <span className="math-body">{node.formula}</span>
              <span className="math-delim">$</span>
            </span>
          );
        case 'wikilink': {
          const rawFallback = node.alias
            ? `[[${node.target}|${node.alias}]]`
            : `[[${node.target}]]`;
          return (
            <span
              key={key}
              className="nexus-wysiwyg-wikilink"
              title={`Wiki link to: ${node.target}`}
              contentEditable={false}
              data-node-type="wikilink"
              data-raw={node.raw || rawFallback}
            >
              <span className="wiki-delim">[[</span>
              <span className="wiki-text">{node.alias ?? node.target}</span>
              <span className="wiki-delim">]]</span>
            </span>
          );
        }
        case 'raw':
          return (
            <span
              key={key}
              className="nexus-wysiwyg-raw-inline"
              contentEditable={false}
              data-node-type="raw"
              data-raw={node.raw || node.value}
            >
              {node.value}
            </span>
          );
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
                ? renderBlock(child as MarkdownBlockNode, cIdx, false)
                : renderInline(child as MarkdownInlineNode, cIdx)
            )}
          </div>
        </li>
      );
    },
    [renderInline]
  );

  const renderBlock = useCallback(
    (
      node: MarkdownBlockNode,
      key: number | string,
      isTopLevel = true
    ): React.ReactNode => {
      const nodeKey = getBlockNodeKey(node);

      switch (node.type) {
        case 'heading': {
          const content = node.children.map(renderInline);

          // Top-level headings are editable
          if (isTopLevel) {
            const blockKey = `${nodeKey}_${renderEpoch}`;
            const headingProps = {
              'data-testid': 'wysiwyg-editable-block',
              'data-node-type': 'heading',
              'data-range-from': node.range.from,
              'data-range-to': node.range.to,
              'data-block-key': nodeKey,
              contentEditable: !readOnly,
              suppressContentEditableWarning: true,
              onClick: handleBlockClick,
              onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => handleKeyDown(e, nodeKey),
              onBlur: (e: React.FocusEvent<HTMLElement>) => handleBlur(e, node, nodeKey)
            };

            switch (node.depth) {
              case 1:
                return <h1 key={blockKey} {...headingProps} className="nexus-wysiwyg-h1">{content}</h1>;
              case 2:
                return <h2 key={blockKey} {...headingProps} className="nexus-wysiwyg-h2">{content}</h2>;
              case 3:
                return <h3 key={blockKey} {...headingProps} className="nexus-wysiwyg-h3">{content}</h3>;
              case 4:
                return <h4 key={blockKey} {...headingProps} className="nexus-wysiwyg-h4">{content}</h4>;
              case 5:
                return <h5 key={blockKey} {...headingProps} className="nexus-wysiwyg-h5">{content}</h5>;
              case 6:
                return <h6 key={blockKey} {...headingProps} className="nexus-wysiwyg-h6">{content}</h6>;
            }
          }

          // Nested headings are read-only
          const readonlyHeadingProps = {
            'data-testid': 'wysiwyg-readonly-block',
            'data-node-type': 'heading',
            'data-raw': node.raw,
            contentEditable: false
          };
          switch (node.depth) {
            case 1:
              return <h1 key={key} {...readonlyHeadingProps} className="nexus-wysiwyg-h1">{content}</h1>;
            case 2:
              return <h2 key={key} {...readonlyHeadingProps} className="nexus-wysiwyg-h2">{content}</h2>;
            case 3:
              return <h3 key={key} {...readonlyHeadingProps} className="nexus-wysiwyg-h3">{content}</h3>;
            case 4:
              return <h4 key={key} {...readonlyHeadingProps} className="nexus-wysiwyg-h4">{content}</h4>;
            case 5:
              return <h5 key={key} {...readonlyHeadingProps} className="nexus-wysiwyg-h5">{content}</h5>;
            case 6:
              return <h6 key={key} {...readonlyHeadingProps} className="nexus-wysiwyg-h6">{content}</h6>;
          }
          break;
        }
        case 'paragraph': {
          const content = node.children.map(renderInline);

          // Top-level paragraphs are editable
          if (isTopLevel) {
            return (
              <p
                key={`${nodeKey}_${renderEpoch}`}
                className="nexus-wysiwyg-p"
                data-testid="wysiwyg-editable-block"
                data-node-type="paragraph"
                data-range-from={node.range.from}
                data-range-to={node.range.to}
                data-block-key={nodeKey}
                contentEditable={!readOnly}
                suppressContentEditableWarning={true}
                onClick={handleBlockClick}
                onKeyDown={(e) => handleKeyDown(e, nodeKey)}
                onBlur={(e) => handleBlur(e, node, nodeKey)}
              >
                {content}
              </p>
            );
          }

          // Nested paragraphs are read-only
          return (
            <p
              key={key}
              className="nexus-wysiwyg-p"
              data-testid="wysiwyg-readonly-block"
              data-node-type="paragraph"
              data-raw={node.raw}
              contentEditable={false}
            >
              {content}
            </p>
          );
        }
        case 'blockquote':
          return (
            <blockquote
              key={key}
              className="nexus-wysiwyg-blockquote"
              data-testid="wysiwyg-readonly-block"
              data-node-type="blockquote"
              data-raw={node.raw}
              contentEditable={false}
            >
              {node.children.map((child, idx) => renderBlock(child, idx, false))}
            </blockquote>
          );
        case 'list': {
          if (node.ordered) {
            return (
              <ol
                key={key}
                start={node.start}
                className="nexus-wysiwyg-ol"
                data-testid="wysiwyg-readonly-block"
                data-node-type="list"
                data-raw={node.raw}
                contentEditable={false}
              >
                {node.items.map(renderListItem)}
              </ol>
            );
          }
          return (
            <ul
              key={key}
              className="nexus-wysiwyg-ul"
              data-testid="wysiwyg-readonly-block"
              data-node-type="list"
              data-raw={node.raw}
              contentEditable={false}
            >
              {node.items.map(renderListItem)}
            </ul>
          );
        }
        case 'code-block':
          return (
            <div
              key={key}
              className="nexus-wysiwyg-code-container"
              data-testid="wysiwyg-readonly-block"
              data-node-type="code-block"
              data-raw={node.raw}
              contentEditable={false}
            >
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
              data-testid="wysiwyg-readonly-block"
              data-node-type="block-math"
              data-raw={node.raw}
              contentEditable={false}
            >
              <div className="math-header">Display Math</div>
              <pre className="math-formula">{node.formula}</pre>
            </div>
          );
        case 'table':
          return (
            <div
              key={key}
              className="nexus-wysiwyg-table-wrapper"
              data-testid="wysiwyg-readonly-block"
              data-node-type="table"
              data-raw={node.raw}
              contentEditable={false}
            >
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
            <pre
              key={key}
              className="nexus-wysiwyg-raw"
              data-testid="wysiwyg-readonly-block"
              data-node-type="raw"
              data-raw={node.raw}
              contentEditable={false}
            >
              {node.value}
            </pre>
          );
      }
    },
    [
      renderEpoch,
      readOnly,
      handleBlockClick,
      handleKeyDown,
      handleBlur,
      renderInline,
      renderListItem
    ]
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
          parseResult.root.children.map((block, idx) => renderBlock(block, idx, true))
        )}
      </div>
    </div>
  );
};
