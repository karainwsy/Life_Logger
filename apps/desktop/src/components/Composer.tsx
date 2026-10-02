import { useEffect, useRef, useState } from 'react';
import type { LogSourceType } from '@life-logger/domain';
import { startAudioRecording, MAX_RECORDING_SECONDS, type AudioRecorder } from '../audio/recorder';
import { api, errorText, type Notify } from '../api';
import { Icon } from './Icon';
const DRAFT_KEY = 'life-logger.draft.v1';
type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'saving';
const readDraft = (): { draft: { content: string; source: LogSourceType }; error: boolean } => {
  try { const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}'); return { draft: { content: typeof saved.content === 'string' ? saved.content : '', source: saved.source === 'voice' ? 'voice' : 'manual' }, error: false }; }
  catch { return { draft: { content: '', source: 'manual' }, error: true }; }
};
export function Composer({ notify, onSaved }: { notify: Notify; onSaved: () => void }) {
  const [initial] = useState(readDraft);
  const [draft, setDraft] = useState(initial.draft);
  const [draftError, setDraftError] = useState<'read' | 'write' | ''>(initial.error ? 'read' : '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const phaseRef = useRef<Phase>('idle'); const recorder = useRef<AudioRecorder | null>(null);
  const controller = useRef<AbortController | null>(null); const version = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null); const mounted = useRef(true);
  const changePhase = (value: Phase) => { phaseRef.current = value; if (mounted.current) setPhase(value); };
  useEffect(() => {
    if (initial.error && draft === initial.draft) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); setDraftError(''); } catch { setDraftError('write'); }
  }, [draft]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; version.current++; controller.current?.abort(); void recorder.current?.cancel(); if (phaseRef.current === 'transcribing') void api.cancelTranscription().catch(() => {}); };
  }, []);
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now(); setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.min(MAX_RECORDING_SECONDS, Math.floor((Date.now() - started) / 1000))), 500);
    return () => clearInterval(timer);
  }, [phase]);
  const finishRecording = async () => {
    if (phaseRef.current !== 'recording' || !recorder.current) return;
    const active = recorder.current; recorder.current = null; changePhase('transcribing'); const token = version.current;
    try {
      const wavData = await active.stop();
      if (token !== version.current) return;
      const result = await api.transcribeAudio({ wavData, language: 'zh' });
      if (token !== version.current || !mounted.current) return;
      setDraft(current => ({ content: current.content.trim() ? `${current.content.trim()}\n${result.text}` : result.text, source: 'voice' }));
      input.current?.focus();
    } catch (error) { if (token === version.current && mounted.current) notify(errorText(error), 'error'); }
    finally { if (token === version.current) changePhase('idle'); }
  };
  const startRecording = async () => {
    if (phaseRef.current !== 'idle') return;
    changePhase('starting'); const token = ++version.current; controller.current = new AbortController();
    try {
      const active = await startAudioRecording({ signal: controller.current.signal, onLimit: () => void finishRecording() });
      if (token !== version.current || !mounted.current) { await active.cancel(); return; }
      recorder.current = active; changePhase('recording');
    } catch (error) {
      if (token !== version.current) return;
      changePhase('idle');
      if (error instanceof DOMException && error.name === 'NotAllowedError') notify('请在系统设置中允许麦克风权限。', 'error');
      else if (!(error instanceof DOMException && error.name === 'AbortError')) notify(errorText(error), 'error');
    }
  };
  const cancelAudio = async () => {
    version.current++; controller.current?.abort(); const active = recorder.current; recorder.current = null;
    if (phaseRef.current === 'transcribing') await api.cancelTranscription().catch(() => {});
    await active?.cancel(); changePhase('idle');
  };
  const save = async () => {
    if (phaseRef.current !== 'idle' || !draft.content.trim()) return;
    const savedDraft = JSON.stringify(draft);
    changePhase('saving');
    try {
      await api.createLog({ content: draft.content.trim(), sourceType: draft.source });
      try { if (localStorage.getItem(DRAFT_KEY) === savedDraft) localStorage.removeItem(DRAFT_KEY); }
      catch { notify('日志已保存，但本机草稿未能清除。', 'error'); }
      if (!mounted.current) return;
      setDraft({ content: '', source: 'manual' }); notify('已记下这一刻'); onSaved();
    } catch (error) { if (mounted.current) notify(errorText(error), 'error'); }
    finally { changePhase('idle'); }
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); input.current?.focus(); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && document.activeElement === input.current) { event.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });
  const active = phase === 'starting' || phase === 'recording' || phase === 'transcribing';
  return <section className={`composer ${active ? 'composer-active' : ''}`} aria-label="新日志">
    <div className="composer-heading"><span className="small-icon"><Icon name="edit" size={17} /></span><span>记录此刻</span><span className="composer-date">{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span></div>
    <textarea ref={input} aria-label="日志内容" placeholder="今天发生了什么？一个想法，一件小事，都可以记在这里。" value={draft.content} maxLength={100000} disabled={phase === 'saving'} onChange={event => setDraft(current => ({ ...current, content: event.target.value }))} />
    {draftError && <p className="notice warning" role="alert">{draftError === 'read' ? '本机草稿读取失败。' : '草稿未能保留在本机。'}当前内容请先保存为日志，避免丢失。</p>}
    <div className="composer-bottom">
      <div className="recording-tools">
        <button className={`voice-control ${phase === 'recording' ? 'recording' : ''}`} onClick={() => void (phase === 'recording' ? finishRecording() : startRecording())} disabled={phase === 'starting' || phase === 'transcribing' || phase === 'saving'} aria-label={phase === 'recording' ? '停止录音并转写' : '开始语音记录'}><Icon name={phase === 'recording' ? 'stop' : 'mic'} size={19} /><span>{phase === 'recording' ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : '语音'}</span></button>
        {active ? <><span className="recording-status" role="status">{phase === 'starting' ? '等待麦克风…' : phase === 'transcribing' ? '正在本地转写…' : '录音中 · 最长 5 分钟'}</span><button className="text-button" onClick={() => void cancelAudio()}>取消</button></> : <span className="draft-hint">{draftError === 'read' ? '草稿读取失败' : draftError === 'write' ? '草稿未能保留' : draft.content ? '草稿自动保留' : 'Ctrl + Enter 保存'}</span>}
      </div>
      <button className="primary-button" onClick={() => void save()} disabled={phase !== 'idle' || !draft.content.trim()}>{phase === 'saving' ? '保存中…' : '记下来'}<Icon name="arrow" size={17} /></button>
    </div>
  </section>;
}
