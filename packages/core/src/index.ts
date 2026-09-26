export {
  type AppMode,
  type LaunchContext,
  DEFAULT_LAUNCH_CONTEXT
} from './types/mode.js';

export {
  type DocumentType,
  type ViewerDocumentType
} from './document/types.js';

export {
  getPathExtension,
  documentTypeForPath,
  isMarkdownPath,
  supportedDocumentExtensions
} from './document/extensions.js';

export {
  parseLaunchArgs,
  type ParseLaunchArgsOptions
} from './launch/parser.js';

export {
  type FileDocument,
  type WorkspaceMarkdownFile,
  type WorkspaceScanResult,
  type IndexedDocument,
  type SearchHit,
  type IndexWorkspaceResult,
  type GraphNode,
  type GraphEdge,
  type WorkspaceGraph,
  type HistoryEntry,
  type DiffLineKind,
  type DiffLine,
  type FileWatchEvent,
  type FileWatchListener,
  type Unsubscribe,
  type FileServiceErrorCode,
  FileServiceError
} from './types/file.js';
