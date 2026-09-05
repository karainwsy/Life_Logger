import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { sanitizeClueUrl } from '@life-logger/shared';
import type { ActivityRange, BrowserVisitsResult } from '@life-logger/domain';
import type {
  BrowserHistoryItem,
  BrowserHistorySource,
  CaptureBrowserHistoryInput,
  CaptureBrowserHistoryResult,
  ForegroundWindowInfo
} from '@life-logger/domain';

const execFileAsync = promisify(execFile);

const DEFAULT_SINCE_DAYS = 7;
const DEFAULT_LIMIT = 2000;
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

type BrowserProfileRoot = {
  browser: string;
  roots: string[];
};

type HistoryRow = {
  url: string;
  title: string | null;
  visit_count: number;
  last_visit_time: number;
};

const getBrowserProfileRoots = (homeDir: string, platform: NodeJS.Platform): BrowserProfileRoot[] => {
  if (platform === 'win32') {
    return [
      {
        browser: 'Edge',
        roots: [path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data')]
      },
      {
        browser: 'Chrome',
        roots: [path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')]
      },
      {
        browser: 'Brave',
        roots: [path.join(homeDir, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data')]
      },
      {
        browser: 'Chromium',
        roots: [path.join(homeDir, 'AppData', 'Local', 'Chromium', 'User Data')]
      }
    ];
  }

  if (platform === 'darwin') {
    return [
      {
        browser: 'Chrome',
        roots: [path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')]
      },
      {
        browser: 'Edge',
        roots: [path.join(homeDir, 'Library', 'Application Support', 'Microsoft', 'Edge')]
      },
      {
        browser: 'Brave',
        roots: [path.join(homeDir, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')]
      }
    ];
  }

  return [
    {
      browser: 'Chrome',
      roots: [path.join(homeDir, '.config', 'google-chrome')]
    },
    {
      browser: 'Edge',
      roots: [path.join(homeDir, '.config', 'microsoft-edge')]
    },
    {
      browser: 'Brave',
      roots: [path.join(homeDir, '.config', 'BraveSoftware', 'Brave-Browser')]
    },
    {
      browser: 'Chromium',
      roots: [path.join(homeDir, '.config', 'chromium')]
    }
  ];
};

const findHistoryDatabases = (rootDir: string): string[] => {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const profileDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootDir, entry.name));

    return [rootDir, ...profileDirs]
      .map((profileDir) => path.join(profileDir, 'History'))
      .filter((historyPath) => fs.existsSync(historyPath));
  } catch {
    return [];
  }
};

const chromeTimeToIso = (value: number) =>
  new Date(value / 1000 - CHROME_EPOCH_OFFSET_MS).toISOString();

const readChromiumHistory = (
  historyPath: string,
  sinceMicros: number,
  untilMicros: number,
  limit: number
): BrowserHistoryItem[] => {
  const db = new Database(historyPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1500
  });

  try {
    db.pragma('query_only = ON');
    const rows = db
      .prepare<[number, number, number], HistoryRow>(
        `
          SELECT
            urls.url,
            urls.title,
            COUNT(visits.id) AS visit_count,
            MAX(visits.visit_time) AS last_visit_time
          FROM urls
          INNER JOIN visits ON visits.url = urls.id
          WHERE visits.visit_time >= ? AND visits.visit_time < ?
          GROUP BY urls.id
          ORDER BY last_visit_time DESC
          LIMIT ?
        `
      )
      .all(sinceMicros, untilMicros, limit);

    return rows
      .filter((row) => row.url.trim().length > 0)
      .map((row) => ({
        url: row.url,
        title: row.title?.trim() || row.url,
        visitCount: row.visit_count,
        lastVisitAt: chromeTimeToIso(row.last_visit_time)
      }));
  } finally {
    db.close();
  }
};

export const captureBrowserHistory = async (
  input: CaptureBrowserHistoryInput = {}
): Promise<CaptureBrowserHistoryResult> => {
  const sinceDays = Number.isFinite(input.sinceDays) ? Math.max(1, Math.min(365, Math.floor(input.sinceDays!))) : DEFAULT_SINCE_DAYS;
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(10_000, Math.floor(input.limit!))) : DEFAULT_LIMIT;
  const now = new Date();
  const start = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);
  const sinceMicros = (start.getTime() + CHROME_EPOCH_OFFSET_MS) * 1000;
  const items: BrowserHistoryItem[] = [];
  const sources: BrowserHistorySource[] = [];
  const warnings: string[] = [];

  const homeDir = os.homedir();
  const roots = getBrowserProfileRoots(homeDir, process.platform);

  for (const { browser, roots: browserRoots } of roots) {
    for (const rootDir of browserRoots) {
      for (const historyPath of findHistoryDatabases(rootDir)) {
        try {
          const browserItems = readChromiumHistory(historyPath, sinceMicros, (now.getTime() + CHROME_EPOCH_OFFSET_MS) * 1000, limit + 1);
          items.push(...browserItems.slice(0, limit));
          sources.push({
            browser,
            profile: path.basename(path.dirname(historyPath)),
            itemCount: Math.min(browserItems.length, limit),
            truncated: browserItems.length > limit
          });
        } catch {
          warnings.push(`${browser} / ${path.basename(path.dirname(historyPath))} 读取失败，请关闭浏览器后重试。`);
          // 浏览器数据库可能正在被占用，或该浏览器使用了不兼容的表结构。
          continue;
        }
      }
    }
  }

  return {
    items,
    sources,
    warnings,
    truncated: sources.some(source => source.truncated),
    start: start.toISOString(),
    end: now.toISOString()
  };
};

// Read individual visits: the URL table alone only retains the latest visit time.
export const captureBrowserVisits = async (
  input: ActivityRange & { excludedProcesses?: string[] },
  environment = { homeDir: os.homedir(), platform: process.platform }
): Promise<BrowserVisitsResult> => {
  const start = Date.parse(input.start); const end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 26 * 60 * 60 * 1000) throw new Error('请选择一天来补充网页线索');
  const result: BrowserVisitsResult = { visits: [], sources: [], warnings: [], truncated: false };
  const excluded = new Set((input.excludedProcesses ?? []).map(name => name.toLowerCase().replace(/\.exe$/, '')));
  const processNames: Record<string, string[]> = { Edge: ['msedge', 'microsoft edge'], Chrome: ['chrome', 'google chrome'], Brave: ['brave', 'brave browser'], Chromium: ['chromium', 'chrome'] };
  for (const { browser, roots } of getBrowserProfileRoots(environment.homeDir, environment.platform)) {
    if (processNames[browser]?.some(name => excluded.has(name))) continue;
    for (const root of roots) for (const historyPath of findHistoryDatabases(root)) {
      const profile = path.basename(path.dirname(historyPath));
      let db: Database.Database | undefined;
      try {
        db = new Database(historyPath, { readonly: true, fileMustExist: true, timeout: 1500 });
        db.pragma('query_only = ON');
        const rows = db.prepare(`SELECT visits.id, visits.visit_time, urls.url, urls.title FROM visits
          INNER JOIN urls ON urls.id = visits.url WHERE visits.visit_time >= ? AND visits.visit_time < ?
          ORDER BY visits.visit_time DESC, visits.id DESC LIMIT 5001`)
          .all((start + CHROME_EPOCH_OFFSET_MS) * 1000, (end + CHROME_EPOCH_OFFSET_MS) * 1000) as { id: number; visit_time: number; url: string; title: string | null }[];
        let itemCount = 0;
        for (const row of rows.slice(0, 5000)) {
          const url = sanitizeClueUrl(row.url);
          if (!url) continue;
          const key = createHash('sha256').update(JSON.stringify([browser, profile, row.id, row.visit_time, row.url])).digest('hex');
          const title = row.title?.trim();
          result.visits.push({ key, url, title: title && title !== row.url ? title.slice(0, 2000) : url, browser, profile, visitedAt: chromeTimeToIso(row.visit_time) });
          itemCount++;
        }
        result.sources.push({ browser, profile, itemCount, truncated: rows.length > 5000 });
        if (rows.length > 5000) { result.truncated = true; result.warnings.push(`${browser} / ${profile} 当天访问较多，仅读取最近 5000 次。`); }
      } catch { result.warnings.push(`${browser} / ${profile} 读取失败，请关闭浏览器后重试。`); }
      finally { db?.close(); }
    }
  }
  if (!result.sources.length && !result.warnings.length) result.warnings.push('未找到可读取的浏览器历史。支持 Edge、Chrome、Brave 和 Chromium；排除的应用和无痕访问不会被读取。');
  return result;
};

const WINDOWS_POWERSHELL_SCRIPT = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public class LifeLoggerWin32 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'

$handle = [LifeLoggerWin32]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) {
  exit 1
}

$length = [LifeLoggerWin32]::GetWindowTextLength($handle)
$builder = New-Object System.Text.StringBuilder ($length + 1)
[LifeLoggerWin32]::GetWindowText($handle, $builder, $builder.Capacity) | Out-Null

$processId = 0
[LifeLoggerWin32]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$title = $builder.ToString() -replace "\\r", " " -replace "\\n", " "
$result = [PSCustomObject]@{
  windowTitle = $title
  processName = $process.ProcessName
}
$result | ConvertTo-Json -Compress
`;

const parseWindowsOutput = (stdout: string): ForegroundWindowInfo | null => {
  const parsed = JSON.parse(stdout.trim()) as {
    windowTitle?: unknown;
    processName?: unknown;
  };

  const windowTitle =
    typeof parsed.windowTitle === 'string' && parsed.windowTitle.trim()
      ? parsed.windowTitle.trim()
      : '无标题窗口';

  if (
    typeof parsed.processName !== 'string' ||
    !parsed.processName.trim() ||
    parsed.processName === 'Idle'
  ) {
    return null;
  }

  return {
    windowTitle,
    processName: parsed.processName.trim()
  };
};

export const captureForegroundWindow = async (): Promise<ForegroundWindowInfo | null> => {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_POWERSHELL_SCRIPT],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5000
      }
    );

    return parseWindowsOutput(stdout);
  } catch {
    return null;
  }
};
