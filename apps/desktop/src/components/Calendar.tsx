import { useState } from 'react';
import { localDateKey } from '@life-logger/shared';
import { Icon } from './Icon';
export function Calendar({ selected, onSelect }: { selected: string; onSelect: (date: string) => void }) {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const first = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = localDateKey(new Date());
  return <section className="calendar-card">
    <div className="calendar-heading"><h3>{month.getFullYear()} 年 {month.getMonth() + 1} 月</h3><div className="inline-actions">
      <button className="icon-button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Icon name="left" size={16} /></button>
      <button className="icon-button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Icon name="right" size={16} /></button>
    </div></div>
    <div className="calendar-grid">{'一二三四五六日'.split('').map(day => <span className="weekday" key={day}>{day}</span>)}
      {Array.from({ length: first }, (_, i) => <span key={`blank-${i}`} />)}
      {Array.from({ length: days }, (_, i) => { const key = localDateKey(new Date(month.getFullYear(), month.getMonth(), i + 1)); return <button key={key} className={`${selected === key ? 'selected' : ''} ${today === key ? 'today' : ''}`} aria-label={key} aria-pressed={selected === key} onClick={() => onSelect(selected === key ? '' : key)}>{i + 1}</button>; })}
    </div>
    <div className="calendar-footer"><button onClick={() => { setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); onSelect(today); }}>回到今天</button><button onClick={() => onSelect('')}>全部日期</button></div>
    <label className="date-jump">跳转日期<input aria-label="跳转日期" type="date" value={selected} onChange={event => onSelect(event.target.value)} /></label>
  </section>;
}
