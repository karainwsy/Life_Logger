import fs from 'node:fs';
import path from 'node:path';
import type {
  ActivityProcessStat,
  ActivitySession,
  ActivitySummary,
  ActivityTitleStat,
  BrowserDomainStat,
  BrowserHistoryItem,
  BrowserHistorySummary,
  CaptureBrowserHistoryResult
} from '@life-logger/domain';

export type TranscribeWavFileInput = {
  wavFilePath: string;
  modelsDir: string;
  language?: string;
};

const MODEL_FILE_NAME = 'ggml-base.bin';

const flattenTranscription = (value: string[] | string[][]) => {
  const segments = Array.isArray(value[0])
    ? (value as string[][]).flat()
    : (value as string[]);

  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
};

const resolveModelPath = (modelsDir: string) => {
  const modelPath = path.join(modelsDir, MODEL_FILE_NAME);

  if (!fs.existsSync(modelPath)) {
    throw new Error(
      `未找到本地 Whisper 模型文件：${modelPath}。请先将 ${MODEL_FILE_NAME} 放到该目录。`
    );
  }

  return modelPath;
};

export const transcribeWavFile = async ({
  wavFilePath,
  modelsDir,
  language = 'zh'
}: TranscribeWavFileInput) => {
  if (!fs.existsSync(wavFilePath)) {
    throw new Error('待转写的音频文件不存在');
  }

  const modelPath = resolveModelPath(modelsDir);
  const { default: whisper } = await import('@kutalia/whisper-node-addon');
  const result = await whisper.transcribe({
    fname_inp: wavFilePath,
    model: modelPath,
    language,
    translate: false,
    no_timestamps: true,
    no_prints: true,
    use_gpu: false
  });

  const text = flattenTranscription(result.transcription);
  if (!text) {
    throw new Error('未识别到有效语音内容');
  }

  return { text };
};

const getDomain = (value: string) => {
  try {
    return new URL(value).hostname.replace(/^www\./, '') || '未知网站';
  } catch {
    return '未知网站';
  }
};

const formatRangeLabel = (start: string, end: string) => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameYear = startDate.getFullYear() === endDate.getFullYear();

  return [
    startDate.toLocaleDateString('zh-CN', {
      month: 'long',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' })
    }),
    endDate.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  ].join(' 至 ');
};

const getTopDomains = (
  items: BrowserHistoryItem[],
  limit: number
): BrowserDomainStat[] => {
  const domainMap = new Map<
    string,
    { visits: number; representativeTitle: string; lastVisitAt: number }
  >();

  for (const item of items) {
    const domain = getDomain(item.url);
    const current = domainMap.get(domain);
    const lastVisitAt = new Date(item.lastVisitAt).getTime();

    if (!current) {
      domainMap.set(domain, {
        visits: item.visitCount,
        representativeTitle: item.title || domain,
        lastVisitAt
      });
      continue;
    }

    current.visits += item.visitCount;
    if (lastVisitAt > current.lastVisitAt) {
      current.representativeTitle = item.title || domain;
      current.lastVisitAt = lastVisitAt;
    }
  }

  const totalVisits = Array.from(domainMap.values()).reduce(
    (sum, item) => sum + item.visits,
    0
  );

  return Array.from(domainMap.entries())
    .map(([domain, stat]) => ({
      domain,
      visits: stat.visits,
      percentage: totalVisits > 0 ? Math.round((stat.visits / totalVisits) * 100) : 0,
      representativeTitle: stat.representativeTitle
    }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, limit);
};

const getTopItems = (items: BrowserHistoryItem[], limit: number) => {
  const merged = new Map<string, BrowserHistoryItem>();
  for (const item of items) {
    const previous = merged.get(item.url);
    merged.set(item.url, previous ? {
      ...(item.lastVisitAt > previous.lastVisitAt ? item : previous),
      visitCount: previous.visitCount + item.visitCount
    } : { ...item });
  }
  return [...merged.values()]
    .sort((a, b) => b.visitCount - a.visitCount)
    .slice(0, limit);
};

const buildSummaryText = (
  totalVisits: number,
  uniqueDomains: number,
  topDomains: BrowserDomainStat[],
  rangeLabel: string
) => {
  const domainLines = topDomains
    .slice(0, 5)
    .map((item) => `${item.domain}（${item.visits} 次）`)
    .join('、');

  if (totalVisits === 0) {
    return `在 ${rangeLabel} 内没有发现浏览器访问记录。`;
  }

  return [
    `在 ${rangeLabel} 内，共访问 ${totalVisits} 次网页，来自 ${uniqueDomains} 个不同网站。`,
    domainLines ? `最常访问：${domainLines}。` : '',
    '这些内容由本地浏览器历史统计生成，未上传到云端。'
  ]
    .filter(Boolean)
    .join('\n');
};

export const generateBrowserHistorySummary = async (
  history: CaptureBrowserHistoryResult,
  options: { maxDomains?: number; maxItems?: number } = {}
): Promise<BrowserHistorySummary> => {
  const maxDomains = options.maxDomains ?? 8;
  const maxItems = options.maxItems ?? 6;
  const totalVisits = history.items.reduce((sum, item) => sum + item.visitCount, 0);
  const topDomains = getTopDomains(history.items, maxDomains);
  const topItems = getTopItems(history.items, maxItems);
  const rangeLabel = formatRangeLabel(history.start, history.end);
  const uniqueDomains = new Set(history.items.map((item) => getDomain(item.url))).size;

  return {
    generatedAt: new Date().toISOString(),
    start: history.start,
    end: history.end,
    rangeLabel,
    totalVisits,
    uniqueDomains,
    totalItems: history.items.length,
    topDomains,
    topItems,
    sources: history.sources,
    warnings: history.warnings ?? [],
    truncated: history.truncated ?? false,
    summaryText: buildSummaryText(
      totalVisits,
      uniqueDomains,
      topDomains,
      rangeLabel
    ) + (history.truncated ? '\n部分浏览器记录已截断，以上数字仅代表已读取的数据。' : '') +
      (history.warnings?.length ? '\n部分浏览器未能读取，统计可能不完整。' : '')
  };
};

export type ActivitySummaryInput = {
  sessions: ActivitySession[];
  start: string;
  end: string;
  maxProcesses?: number;
  maxTitles?: number;
};

const formatDuration = (seconds: number) => {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) {
    return '不到 1 分钟';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} 分钟`;
  }

  return `${hours} 小时 ${minutes} 分钟`;
};

const getEffectiveActivityDuration = (
  session: ActivitySession,
  start: string,
  end: string
) => {
  const sessionStart = new Date(session.startedAt).getTime();
  const sessionEnd = new Date(session.endedAt).getTime();
  const rangeStart = new Date(start).getTime();
  const rangeEnd = new Date(end).getTime();
  const overlap = Math.min(sessionEnd, rangeEnd) - Math.max(sessionStart, rangeStart);

  return Math.max(0, Math.round(overlap / 1000));
};

const buildTopProcesses = (
  sessions: ActivitySession[],
  start: string,
  end: string,
  totalSeconds: number,
  limit: number
): ActivityProcessStat[] => {
  const processMap = new Map<string, { durationSeconds: number; sessionCount: number }>();

  for (const session of sessions) {
    const durationSeconds = getEffectiveActivityDuration(session, start, end);
    const current = processMap.get(session.processName) ?? {
      durationSeconds: 0,
      sessionCount: 0
    };
    current.durationSeconds += durationSeconds;
    current.sessionCount += 1;
    processMap.set(session.processName, current);
  }

  return Array.from(processMap.entries())
    .map(([processName, stat]) => ({
      processName,
      durationSeconds: stat.durationSeconds,
      sessionCount: stat.sessionCount,
      percentage:
        totalSeconds > 0 ? Math.round((stat.durationSeconds / totalSeconds) * 100) : 0
    }))
    .sort((a, b) => b.durationSeconds - a.durationSeconds)
    .slice(0, limit);
};

const buildTopTitles = (
  sessions: ActivitySession[],
  start: string,
  end: string,
  limit: number
): ActivityTitleStat[] => {
  const titleMap = new Map<string, ActivityTitleStat>();

  for (const session of sessions) {
    const key = `${session.processName}\u0000${session.windowTitle}`;
    const current = titleMap.get(key) ?? {
      windowTitle: session.windowTitle,
      processName: session.processName,
      durationSeconds: 0
    };
    current.durationSeconds += getEffectiveActivityDuration(session, start, end);
    titleMap.set(key, current);
  }

  return Array.from(titleMap.values())
    .sort((a, b) => b.durationSeconds - a.durationSeconds)
    .slice(0, limit);
};

const buildActivitySummaryText = (
  totalSeconds: number,
  sessionCount: number,
  topProcesses: ActivityProcessStat[],
  rangeLabel: string
) => {
  if (sessionCount === 0) {
    return `在 ${rangeLabel} 内没有记录到前台活动。`;
  }

  const processLines = topProcesses
    .slice(0, 5)
    .map((item) => `${item.processName}（${formatDuration(item.durationSeconds)}）`)
    .join('、');

  return [
    `在 ${rangeLabel} 内，共记录 ${sessionCount} 段前台活动，活跃时长约 ${formatDuration(totalSeconds)}。`,
    processLines ? `主要集中在：${processLines}。` : '',
    '活动记录仅包含前台进程名和窗口标题，不包含键盘内容或截图。'
  ]
    .filter(Boolean)
    .join('\n');
};

export const generateActivitySummary = ({
  sessions,
  start,
  end,
  maxProcesses = 8,
  maxTitles = 6
}: ActivitySummaryInput): ActivitySummary => {
  const totalActiveSeconds = sessions.reduce(
    (sum, session) => sum + getEffectiveActivityDuration(session, start, end),
    0
  );
  const topProcesses = buildTopProcesses(
    sessions,
    start,
    end,
    totalActiveSeconds,
    maxProcesses
  );
  const topTitles = buildTopTitles(sessions, start, end, maxTitles);
  const rangeLabel = formatRangeLabel(start, end);

  return {
    generatedAt: new Date().toISOString(),
    start,
    end,
    totalActiveSeconds,
    sessionCount: sessions.length,
    topProcesses,
    topTitles,
    summaryText: buildActivitySummaryText(
      totalActiveSeconds,
      sessions.length,
      topProcesses,
      rangeLabel
    )
  };
};
