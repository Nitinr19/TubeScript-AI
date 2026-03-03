export interface TranscriptSegment {
  startTime: string;
  text: string;
}

export interface VideoMetadata {
  title: string;
  channel: string;
  duration?: string;
}

export interface VideoResult {
  id: string;
  url: string;
  status: 'idle' | 'fetching' | 'summarizing' | 'completed' | 'error';
  error?: string;
  metadata?: VideoMetadata;
  transcript?: TranscriptSegment[];
  rawTranscript?: string;
  summary?: string;
  progress?: number;
}

export type ExportFormat = 'json' | 'markdown';
