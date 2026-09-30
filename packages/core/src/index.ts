export {
  type AppMode,
  type LaunchContext,
  DEFAULT_LAUNCH_CONTEXT
} from './types/mode.js';

export {
  type DocumentType,
  type ViewerDocumentType,
  VIEWER_DOCUMENT_TYPES,
  isViewerDocumentType
} from './document/types.js';

export {
  getPathExtension,
  documentTypeForPath,
  isMarkdownPath,
  supportedDocumentExtensions
} from './document/extensions.js';

export {
  wikilinkCandidates,
  normalizeWikilinkTarget,
  attachmentContentFingerprint
} from './document/links.js';

export {
  attachmentReferences,
  resolveWorkspacePath,
  type AttachmentReferences
} from './document/references.js';

export {
  parsePageAnchor,
  pageAnchorOf,
  relativePathFrom,
  fileNameOf,
  documentTitleOf,
  formatDocumentCitation,
  type DocumentCitationInput
} from './document/citation.js';

export {
  type ExtractionStatus,
  type ProcessorResult,
  type ProcessorExtractInput,
  type ProcessorOutcome,
  type DocumentProcessor
} from './processor/types.js';

export { ProcessorRegistry } from './processor/registry.js';

export {
  parseLaunchArgs,
  type ParseLaunchArgsOptions
} from './launch/parser.js';

export {
  type FileDocument,
  type WorkspaceMarkdownFile,
  type WorkspaceDocumentFile,
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

export {
  ASSET_SCHEME,
  ASSET_HOST,
  ASSET_PATH_PARAM,
  toAssetUrl,
  assetPathFromUrl
} from './asset/url.js';

export { countDocumentCharacters } from './document/text-stats.js';

export {
  DEFAULT_ATTACHMENT_DIRECTORY,
  DEFAULT_ATTACHMENT_NAME_TEMPLATE,
  expandAttachmentName,
  sanitizeFileNameSegment,
  attachmentExtension,
  normalizeAttachmentDirectory,
  formatAttachmentReference
} from './document/attachments.js';
