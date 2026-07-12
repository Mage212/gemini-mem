export { MemoryDatabase } from './core/database';
export type {
  Session,
  Observation,
  Note,
  NoteWithSession,
  SessionStatus,
  ObservationStatus,
  NoteSource,
  SearchResult,
} from './core/database';

export { ContextManager } from './core/context-manager';
export type { BuildContextOptions } from './core/context-manager';

export { normalizeProjectPath } from './core/paths';
export { CompressionQueue } from './core/compression-queue';
export type { CompressionJob, DrainResult } from './core/compression-queue';

export { GeminiClient } from './gemini/client';
export type { CompressInput } from './gemini/client';

export { SessionSummarizer } from './gemini/summarizer';
