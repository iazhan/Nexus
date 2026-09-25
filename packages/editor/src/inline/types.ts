import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { MarkdownDocumentSession } from '../document-session.js';

export type InlineEditNodeType = 'link' | 'image' | 'inline-code' | 'wikilink';

export interface InlineEditContext {
  nodeType: InlineEditNodeType;
  range: { from: number; to: number };
  raw: string;
  source: string;
}

export interface LinkEditValue {
  label: string;
  destination: string;
  title?: string;
  syntax?: 'inline' | 'angle' | 'autolink';
}

export interface ImageEditValue {
  alt: string;
  destination: string;
  title?: string;
}

export interface InlineCodeEditValue {
  value: string;
}

export interface WikiLinkEditValue {
  target: string;
  alias?: string;
}

export interface ImageEditContext {
  range: { from: number; to: number };
  raw: string;
  alt: string;
  destination: string;
  title?: string;
}

export type ImageSourceResolver = (
  currentSource: string,
  context: ImageEditContext
) => Promise<string | null> | string | null;

export interface InlineEditExtensionOptions {
  imageSourceResolver?: ImageSourceResolver;
  surfaceId?: string;
}

export const inlineEditOptionsFacet = Facet.define<InlineEditExtensionOptions, InlineEditExtensionOptions>({
  combine: (values) => values[0] ?? {}
});

export interface ActivePopoverState {
  view: EditorView;
  session: MarkdownDocumentSession;
  context: InlineEditContext;
  initialRevision: number;
  popoverEl: HTMLElement;
  targetEl: HTMLElement;
  cleanupListeners: () => void;
  committed: boolean;
}

