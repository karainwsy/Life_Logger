import { useEffect, useRef, useState } from 'react';
import type { ActivitySession, ActivitySettings, ActivitySummary, BrowserHistorySummary } from '@life-logger/domain';
import { api, durationLabel, errorText, type Notify } from '../api';
import { Icon } from './Icon';
export function BrowserPanel({ notify }: { notify: Notify }) {
  const [summary, setSummary] = useState<BrowserHistorySummary | null>(null);
  const [days, setDays] = useState(7); const [busy, setBusy] = useState(false); const [saving, setSaving] = useState(false);
  const saveLock = useRef(false); const [saved, setSaved] = useState(false);
  const generate = async () => {
    setBusy(true); setSummary(null); setSaved(false);
    try { setSummary(await api.generateBrowserHistorySummary({ sinceDays: days })); }
    catch (error) { notify(errorText(error), 'error'); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!summary || saveLock.current || saved) return; saveLock.current = true; setSaving(true);
    try { await api.createLog({ content: summary.summaryText, sourceType: 'ai_summary' }); setSaved(true); notify('浏览回顾已保存到日志'); }
    catch (error) { notify(errorText(error), 'error'); } finally { saveLock.current = false; setSaving(false); }
  };
  return <div className="panel-stack">
    <section className="surface insight-intro"><div className="section-icon"><Icon name="globe" size={26} /></div><div><h2>回看你的数字足迹</h2><p>从本机浏览器历史中，整理常去的网站和近期关注的内容。</p></div><div className="inline-actions"><select aria-label="浏览统计范围" value={days} disabled={busy} onChange={event => setDays(Number(event.target.value))}><option value={7}>最近 7 天</option><option value={1}>最近 24 小时</option><option value={30}>最近 30 天</option></select><button className="primary-button" disabled={busy} onClick={() => void generate()}><Icon name="refresh" size={17} />{busy ? '整理中…' : '生成回顾'}</button></div></section>
    {!summary && <div className="surface empty-state"><span className={busy ? 'spinner' : 'empty-symbol'}>{!busy && <Icon name="globe" size={34} />}</span><h3>{busy ? '正在整理浏览记录' : '选择时间范围，开始一次回顾'}</h3><p>支持 Chrome、Edge、Brave 和 Chromium。原始浏览记录不会保存到日志。</p></div>}
    {summary && <>
      {(summary.warnings?.length || summary.truncated) ? <div className="notice warning" role="status"><Icon name="info" /><div>{summary.truncated && <p>部分记录超过读取上限，以下为已读取数据的统计。</p>}{summary.warnings?.map(text => <p key={text}>{text}</p>)}</div></div> : null}
      <div className="stat-grid"><Stat label="已统计访问" value={summary.totalVisits.toLocaleString()} unit="次" /><Stat label="访问网站" value={String(summary.uniqueDomains)} unit="个" /><Stat label="成功读取" value={String(summary.sources.length)} unit="个浏览器配置" /></div>
      <div className="insight-columns"><section className="surface"><div className="section-heading"><h2>常去的网站</h2><span>按访问次数</span></div>{summary.topDomains.length ? summary.topDomains.map((domain, index) => <div className="ranking-row" key={domain.domain}><span className="ranking-index">{String(index + 1).padStart(2, '0')}</span><div className="ranking-body"><div><strong>{domain.domain}</strong><span>{domain.visits} 次</span></div><div className="bar-track"><div style={{ width: `${Math.max(1, domain.percentage)}%` }} /></div></div></div>) : <p className="muted">没有可展示的访问记录。</p>}</section>
      <section className="surface"><div className="section-heading"><h2>近期高频页面</h2></div>{summary.topItems.map(item => <div className="history-item" key={item.url}><Icon name="globe" size={17} /><div><strong>{item.title}</strong><span title={item.url}>{item.url}</span></div><small>{item.visitCount} 次</small></div>)}{!summary.topItems.length && <p className="muted">浏览器未安装、没有历史或读取失败时，这里不会显示页面。</p>}</section></div>
      <section className="surface summary-output"><div className="section-heading"><h2>这段时间的回顾</h2><span>{summary.rangeLabel}</span></div><p>{summary.summaryText}</p><div className="summary-footer"><span><Icon name="shield" size={16} />仅在本机处理</span><button className="primary-button" disabled={saving || saved || !summary.totalVisits} onClick={() => void save()}><Icon name={saved ? 'check' : 'plus'} size={17} />{saved ? '已保存' : saving ? '保存中…' : '保存为日志'}</button></div></section>
    </>}
  </div>;
}
function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return <div className="surface stat-card"><span>{label}</span><div><strong>{value}</strong><small>{unit}</small></div></div>;
}
export function ActivityPanel({ notify, openSettings }: { notify: Notify; openSettings: () => void }) {
  const [settings, setSettings] = useState<ActivitySettings | null>(null); const [sessions, setSessions] = useState<ActivitySession[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null); const [busy, setBusy] = useState(true); const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false); const saveLock = useRef(false);
  const load = async () => {
    setBusy(true); setSaved(false);
    try { const [config, recent, result] = await Promise.all([api.getActivitySettings(), api.getRecentActivitySessions(30), api.generateActivitySummary()]); setSettings(config); setSessions(recent); setSummary(result); }
    catch (error) { notify(errorText(error), 'error'); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!summary || saved || saveLock.current) return; saveLock.current = true; setSaving(true);
    try { await api.createLog({ content: summary.summaryText, sourceType: 'activity_summary' }); setSaved(true); notify('今日活动摘要已保存'); }
    catch (error) { notify(errorText(error), 'error'); } finally { saveLock.current = false; setSaving(false); }
  };
  return <div className="panel-stack">
    <section className="surface insight-intro"><div className="section-icon"><Icon name="activity" size={26} /></div><div><h2>时间花在了哪里</h2><p>{api.platform !== 'win32' ? '当前系统暂不支持前台活动采集，已有记录仍可查看。' : settings?.enabled ? '自动记录已开启。锁屏、休眠及闲置时暂停计时。' : '自动记录尚未开启，可以在设置中选择采集方式。'}</p></div><button className="secondary-button" onClick={openSettings}>采集设置<Icon name="arrow" size={16} /></button></section>
    <div className="section-heading"><h2>今日活动</h2><button className="text-button" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={16} />{busy ? '刷新中…' : '刷新'}</button></div>
    <div className="stat-grid"><Stat label="已记录前台时长" value={summary ? durationLabel(summary.totalActiveSeconds) : '—'} unit="" /><Stat label="活动片段" value={summary ? String(summary.sessionCount) : '—'} unit="段" /><Stat label="采集状态" value={settings ? settings.enabled ? '已开启' : '已暂停' : '—'} unit="" /></div>
    <div className="insight-columns"><section className="surface"><div className="section-heading"><h2>主要应用</h2><span>今日</span></div>{summary?.topProcesses.filter(process => process.durationSeconds > 0).map((process, index) => <div className="ranking-row" key={process.processName}><span className="ranking-index">{String(index + 1).padStart(2, '0')}</span><div className="ranking-body"><div><strong>{process.processName}</strong><span>{durationLabel(process.durationSeconds)}</span></div><div className="bar-track"><div style={{ width: `${process.percentage}%` }} /></div></div></div>)}{!summary?.totalActiveSeconds && <div className="compact-empty"><Icon name="monitor" size={30} /><p>今天还没有活动记录</p></div>}</section>
    <section className="surface"><div className="section-heading"><h2>最近的活动</h2><span>最近 7 天 · 最多 30 段</span></div><div className="activity-list">{sessions.map(session => <div className="activity-item" key={session.id}><span className="app-symbol"><Icon name="monitor" size={18} /></span><div><strong>{session.processName}</strong><p title={session.windowTitle}>{session.windowTitle || '未记录窗口标题'}</p><small>{new Date(session.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div><span>{durationLabel(session.durationSeconds)}</span></div>)}</div>{!sessions.length && <div className="compact-empty"><Icon name="clock" size={30} /><p>开启采集后，记录会出现在这里</p></div>}</section></div>
    {summary && summary.totalActiveSeconds > 0 && <section className="surface summary-output"><div className="section-heading"><h2>今日小结</h2></div><p>{summary.summaryText}</p><div className="summary-footer"><span>前台时长是采样估计，不代表精确工作时长。</span><button className="primary-button" disabled={saving || saved} onClick={() => void save()}>{saved ? '已保存' : saving ? '保存中…' : '保存为日志'}<Icon name="check" size={17} /></button></div></section>}
  </div>;
}
export function SettingsPanel({ notify }: { notify: Notify }) {
  const [settings, setSettings] = useState<ActivitySettings | null>(null); const [excluded, setExcluded] = useState('');
  const [busy, setBusy] = useState(false); const [backupBusy, setBackupBusy] = useState(''); const [dirty, setDirty] = useState(false);
  useEffect(() => { void api.getActivitySettings().then(config => { setSettings(config); setExcluded((config.excludedProcesses ?? []).join(', ')); }).catch(error => notify(errorText(error), 'error')); }, []);
  const change = <K extends keyof ActivitySettings>(key: K, value: ActivitySettings[K]) => { setSettings(current => current ? { ...current, [key]: value } : current); setDirty(true); };
  const save = async () => {
    if (!settings || busy) return; setBusy(true);
    try { const saved = await api.updateActivitySettings({ ...settings, excludedProcesses: excluded.split(/[,，\n]/).map(item => item.trim()).filter(Boolean) }); setSettings(saved); setExcluded((saved.excludedProcesses ?? []).join(', ')); setDirty(false); notify('设置已保存'); }
    catch (error) { notify(errorText(error), 'error'); } finally { setBusy(false); }
  };
  const backup = async (importing: boolean) => {
    if (backupBusy) return; setBackupBusy(importing ? 'import' : 'export');
    try {
      if (importing) { const result = await api.importBackup(); if (result) notify(`已恢复 ${result.importedCount} 条日志。原日志副本：${result.snapshotPath}`); }
      else { const result = await api.exportBackup(); if (result) notify(`已导出 ${result.logCount} 条日志至 ${result.filePath}`); }
    } catch (error) { notify(errorText(error), 'error'); } finally { setBackupBusy(''); }
  };
  return <div className="settings-layout">{settings && <div className={`settings-save ${dirty ? 'is-dirty' : ''}`}><div><strong>记录偏好</strong><span role="status">{dirty ? '有尚未保存的更改' : '设置已同步'}</span></div><button className="primary-button" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}<Icon name="check" size={17} /></button></div>}<div className="panel-stack">
    <section className="surface settings-section"><div className="section-heading"><h2><Icon name="activity" />自动记录</h2><span className="subtle-badge">{api.platform === 'win32' ? 'Windows' : '当前系统不支持采集'}</span></div>
      {!settings ? <p role="status" className="muted">正在读取设置…</p> : <fieldset disabled={busy}>
        <Toggle label="后台活动采集" description="记录前台应用；闲置 5 分钟后暂停。" checked={settings.enabled} disabled={api.platform !== 'win32'} onChange={value => change('enabled', value)} />
        <Toggle label="自动补充网页线索" description="每 15 分钟在本机补充当天网页访问。遵循应用排除设置；锁屏或休眠时暂停。" checked={Boolean(settings.autoBrowserClues)} onChange={value => change('autoBrowserClues', value)} />
        <div className="settings-fields"><label>采集间隔<span className="input-unit"><input type="number" min={10} max={600} value={settings.pollIntervalSeconds} onChange={event => change('pollIntervalSeconds', Number(event.target.value))} /><span>秒</span></span></label><label>周期摘要<span className="input-unit"><input type="number" min={0} max={1440} value={settings.periodicSummaryMinutes} onChange={event => change('periodicSummaryMinutes', Number(event.target.value))} /><span>分钟</span></span><small>设为 0 可关闭</small></label></div>
        <Toggle label="每晚生成今日总结" description="按当天已采集的窗口标题、网页访问和备注生成回顾并保存。开启任一种自动采集后生效。" checked={Boolean(settings.nightlySummaryTime)} onChange={value => change('nightlySummaryTime', value ? '22:00' : '')} />
        {settings.nightlySummaryTime && <label className="setting-time">总结时间<input type="time" value={settings.nightlySummaryTime} onChange={event => change('nightlySummaryTime', event.target.value)} /></label>}
        <Toggle label="开机自动启动" description="安装后的应用生效。" checked={settings.openAtLogin} onChange={value => change('openAtLogin', value)} />
        <Toggle label="开机启动时收起到托盘" description="手动打开应用时，仍会显示主窗口。" checked={settings.startMinimized} onChange={value => change('startMinimized', value)} />
      </fieldset>}
    </section>
    {settings && <section className="surface settings-section"><div className="section-heading"><h2><Icon name="shield" />采集与隐私</h2></div><fieldset disabled={busy}>
      <Toggle label="记录窗口标题" description="标题可能包含文档名称或网页内容。关闭后仅记录应用名。" checked={settings.captureWindowTitles} onChange={value => change('captureWindowTitles', value)} />
      <label className="stacked-label">不记录这些应用<input placeholder="例如：KeePass, 1Password" value={excluded} onChange={event => { setExcluded(event.target.value); setDirty(true); }} /><small>填写进程名，用逗号分隔；不区分大小写。</small></label>
      <label className="stacked-label">原始活动保留时间<select value={settings.retentionDays ?? 0} onChange={event => change('retentionDays', Number(event.target.value))}><option value={0}>不自动清理</option><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option><option value={365}>1 年</option><option value={3650}>10 年</option></select><small>采集运行时每天清理过期活动与未批注线索；有名称或备注的线索、已保存的日志会保留。</small></label>
    </fieldset></section>}
  </div><aside className="panel-stack"><section className="surface settings-section"><div className="section-heading"><h2><Icon name="download" />日志备份</h2></div><p className="muted">导出全部日志，在其他电脑上恢复，或留存一份副本。</p><div className="backup-actions"><button className="secondary-button" disabled={Boolean(backupBusy)} onClick={() => void backup(false)}><Icon name="download" size={18} />{backupBusy === 'export' ? '导出中…' : '导出日志备份'}</button><button className="secondary-button" disabled={Boolean(backupBusy)} onClick={() => void backup(true)}><Icon name="upload" size={18} />{backupBusy === 'import' ? '恢复中…' : '从备份恢复'}</button></div><p className="footnote">备份包含所有来源的日志。活动线索及备注需先保存为日志才会纳入；不包含原始活动和自动化设置。恢复会替换当前日志，并先保存安全副本。</p></section>
  <section className="surface settings-section"><div className="section-heading"><h2><Icon name="mic" />本地语音</h2></div><p className="muted">录音在本机转为文字，每段最长 5 分钟。</p><p className="footnote">首次使用请将 ggml-base.bin 放入应用数据目录下的 whisper-models 文件夹。无需联网转写。</p></section>
  <div className="privacy-note"><Icon name="shield" size={24} /><h3>你的记录，留在你的电脑</h3><p>日志与活动数据在本机保存。浏览统计和语音转写不使用云端服务。</p><span>Life Logger · {api.appVersion}</span></div></aside></div>;
}
function Toggle({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="toggle-row"><span><strong>{label}</strong><small>{description}</small></span><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label>;
}
