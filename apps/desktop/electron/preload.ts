import { contextBridge, ipcRenderer } from 'electron';
import type { LifeLoggerApi } from '@life-logger/domain';
const api: LifeLoggerApi = {
  platform: process.platform,
  appVersion: ipcRenderer.sendSync('app:getVersion') as string,
  searchClues: input => ipcRenderer.invoke('clues:search', input),
  getDailyReview: input => ipcRenderer.invoke('review:get', input),
  saveDailyReview: input => ipcRenderer.invoke('review:save', input),
  exportDailyReview: input => ipcRenderer.invoke('review:export', input),
  updateClue: input => ipcRenderer.invoke('clues:update', input),
  saveClueAsLog: input => ipcRenderer.invoke('clues:save', input),
  importBrowserClues: input => ipcRenderer.invoke('clues:importBrowser', input),
  createLog: input => ipcRenderer.invoke('logs:create', input),
  getLogsByDateRange: input => ipcRenderer.invoke('logs:listByRange', input),
  searchLogs: input => ipcRenderer.invoke('logs:search', input),
  updateLog: input => ipcRenderer.invoke('logs:update', input),
  deleteLog: input => ipcRenderer.invoke('logs:delete', input),
  transcribeAudio: input => ipcRenderer.invoke('voice:transcribe', input),
  cancelTranscription: () => ipcRenderer.invoke('voice:cancel'),
  generateBrowserHistorySummary: input => ipcRenderer.invoke('browser:generateSummary', input),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  getActivitySettings: () => ipcRenderer.invoke('activity:getSettings'),
  getClueAutomationStatus: () => ipcRenderer.invoke('clues:getAutomationStatus'),
  updateActivitySettings: input => ipcRenderer.invoke('activity:updateSettings', input),
  getRecentActivitySessions: limit => ipcRenderer.invoke('activity:getRecentSessions', limit),
  generateActivitySummary: input => ipcRenderer.invoke('activity:generateSummary', input),
  onLogsChanged(listener) {
    const callback = () => listener();
    ipcRenderer.on('logs:changed', callback);
    return () => ipcRenderer.removeListener('logs:changed', callback);
  }
};
contextBridge.exposeInMainWorld('lifeLogger', api);
