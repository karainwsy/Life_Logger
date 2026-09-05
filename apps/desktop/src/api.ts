import type { LifeLoggerApi, LogSourceType } from '@life-logger/domain';
declare global { interface Window { lifeLogger: LifeLoggerApi } }
export const api = window.lifeLogger;
export const sourceLabels: Record<LogSourceType, string> = { manual: '随手记', voice: '语音记录', ai_summary: '浏览回顾', activity_summary: '活动摘要' };
export type Notify = (text: string, kind?: 'success' | 'error') => void;
export const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败，请重试';
export const durationLabel = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : minutes > 0 ? `${minutes} 分钟` : `${Math.round(seconds)} 秒`;
};
