export type LogSourceType = 'manual' | 'voice' | 'ai_summary' | 'activity_summary';

export const LOG_SOURCE_TYPES: readonly LogSourceType[] = ['manual', 'voice', 'ai_summary', 'activity_summary'];
export const isLogSourceType = (value: unknown): value is LogSourceType =>
  typeof value === 'string' && LOG_SOURCE_TYPES.includes(value as LogSourceType);

export type SearchLogsInput = {
  query?: string;
  date?: string;
  sourceType?: LogSourceType;
  offset?: number;
  limit?: number;
};
export type SearchLogsResult = { logs: LogEntry[]; total: number };

export type LogEntry = {
  id: number;
  content: string;
  createdAt: string;
  sourceType: LogSourceType;
};

export type CreateLogInput = {
  content: string;
  sourceType?: LogSourceType;
};

export type UpdateLogInput = {
  id: number;
  content: string;
};

export type DeleteLogInput = {
  id: number;
};

export type LogDateRange = {
  start: string;
  end: string;
};

export type TranscribeAudioInput = {
  wavData: ArrayBuffer;
  language?: string;
};

export type TranscribeAudioResult = {
  text: string;
};

export type BrowserHistoryItem = {
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: string;
};

export type BrowserHistorySource = {
  browser: string;
  profile: string;
  itemCount: number;
  truncated?: boolean;
};

export type BrowserDomainStat = {
  domain: string;
  visits: number;
  percentage: number;
  representativeTitle: string;
};

export type BrowserHistorySummary = {
  generatedAt: string;
  start: string;
  end: string;
  rangeLabel: string;
  totalVisits: number;
  uniqueDomains: number;
  totalItems: number;
  topDomains: BrowserDomainStat[];
  topItems: BrowserHistoryItem[];
  summaryText: string;
  sources: BrowserHistorySource[];
  warnings?: string[];
  truncated?: boolean;
};

export type CaptureBrowserHistoryInput = {
  sinceDays?: number;
  limit?: number;
};

export type CaptureBrowserHistoryResult = {
  items: BrowserHistoryItem[];
  sources: BrowserHistorySource[];
  start: string;
  end: string;
  warnings?: string[];
  truncated?: boolean;
};

export type GenerateBrowserHistorySummaryInput = {
  sinceDays?: number;
  limit?: number;
};

export type ExportBackupResult = {
  filePath: string;
  logCount: number;
};

export type ImportBackupResult = {
  importedCount: number;
  snapshotPath?: string;
};

export type ForegroundWindowInfo = {
  processName: string;
  windowTitle: string;
};

export type ActivitySession = {
  id: number;
  processName: string;
  windowTitle: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
};

export type ActivityProcessStat = {
  processName: string;
  durationSeconds: number;
  sessionCount: number;
  percentage: number;
};

export type ActivityTitleStat = {
  windowTitle: string;
  processName: string;
  durationSeconds: number;
};

export type ActivitySummary = {
  generatedAt: string;
  start: string;
  end: string;
  totalActiveSeconds: number;
  sessionCount: number;
  topProcesses: ActivityProcessStat[];
  topTitles: ActivityTitleStat[];
  summaryText: string;
};

export type ActivitySettings = {
  enabled: boolean;
  pollIntervalSeconds: number;
  periodicSummaryMinutes: number;
  nightlySummaryTime: string;
  openAtLogin: boolean;
  startMinimized: boolean;
  captureWindowTitles: boolean;
  excludedProcesses?: string[];
  retentionDays?: number;
  autoBrowserClues?: boolean;
};

export type ClueAutomationStatus = {
  syncing: boolean;
  lastSyncAt: string | null;
  added: number;
  warnings: string[];
  error: string | null;
  reviewError: string | null;
};

export type ActivityRange = {
  start: string;
  end: string;
};

export type ActivityClue = {
  id: number;
  kind: 'window' | 'browser';
  title: string;
  processName: string;
  url: string;
  browser: string;
  profile: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  label: string;
  note: string;
  dismissed: boolean;
  savedLogId: number | null;
};
export type SearchCluesInput = { date: string; query?: string; kind?: ActivityClue['kind']; dismissed?: boolean; offset?: number };
export type SearchCluesResult = { clues: ActivityClue[]; total: number };
export type UpdateClueInput = { id: number; label?: string; note?: string; dismissed?: boolean };
export type BrowserVisit = { key: string; title: string; url: string; browser: string; profile: string; visitedAt: string };
export type BrowserVisitsResult = { visits: BrowserVisit[]; sources: BrowserHistorySource[]; warnings: string[]; truncated: boolean };
export type ImportBrowserCluesResult = { added: number; scanned: number; warnings: string[]; truncated: boolean };

export type DailyReviewGroup = {
  key: string;
  kind: ActivityClue['kind'];
  title: string;
  label: string;
  source: string;
  url: string;
  firstAt: string;
  lastAt: string;
  count: number;
  activeSeconds: number;
  notes: string[];
};
export type DailyReview = {
  date: string;
  clueCount: number;
  windowCount: number;
  visitCount: number;
  activeSeconds: number;
  groups: DailyReviewGroup[];
};
export type SaveDailyReviewInput = { date: string; content: string };

export type GenerateActivitySummaryInput = {
  start?: string;
  end?: string;
  maxProcesses?: number;
  maxTitles?: number;
};

export type LifeLoggerApi = {
  platform: string;
  appVersion: string;
  createLog(input: CreateLogInput): Promise<LogEntry>;
  getLogsByDateRange(range: LogDateRange): Promise<LogEntry[]>;
  searchLogs(input: SearchLogsInput): Promise<SearchLogsResult>;
  updateLog(input: UpdateLogInput): Promise<LogEntry | null>;
  deleteLog(input: DeleteLogInput): Promise<boolean>;
  transcribeAudio(input: TranscribeAudioInput): Promise<TranscribeAudioResult>;
  cancelTranscription(): Promise<void>;
  generateBrowserHistorySummary(input: GenerateBrowserHistorySummaryInput): Promise<BrowserHistorySummary>;
  exportBackup(): Promise<ExportBackupResult | null>;
  importBackup(): Promise<ImportBackupResult | null>;
  getActivitySettings(): Promise<ActivitySettings>;
  getClueAutomationStatus(): Promise<ClueAutomationStatus>;
  updateActivitySettings(input: ActivitySettings): Promise<ActivitySettings>;
  getRecentActivitySessions(limit?: number): Promise<ActivitySession[]>;
  generateActivitySummary(input?: GenerateActivitySummaryInput): Promise<ActivitySummary>;
  onLogsChanged(listener: () => void): () => void;
  searchClues(input: SearchCluesInput): Promise<SearchCluesResult>;
  updateClue(input: UpdateClueInput): Promise<ActivityClue>;
  saveClueAsLog(input: { id: number }): Promise<LogEntry>;
  importBrowserClues(input: { date: string }): Promise<ImportBrowserCluesResult>;
  getDailyReview(input: { date: string }): Promise<DailyReview>;
  saveDailyReview(input: SaveDailyReviewInput): Promise<LogEntry>;
  exportDailyReview(input: SaveDailyReviewInput): Promise<{ filePath: string } | null>;
};
