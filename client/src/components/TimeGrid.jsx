import { useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';

const HOUR_PX = 52;
const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

// Places timed events of one day side by side when they overlap (simple greedy lanes).
function layout(timed) {
  const sorted = [...timed].sort((a, b) => a.start - b.start || b.end - a.end);
  const lanes = []; const out = [];
  for (const e of sorted) {
    let lane = lanes.findIndex((end) => end <= e.start);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = e.end; out.push({ ...e, lane });
  }
  // lane count per overlapping cluster
  return out.map((e) => ({ ...e, lanes: Math.max(...out.filter((o) => o.start < e.end && o.end > e.start).map((o) => o.lane)) + 1 }));
}

// Hour grid for the week and day views. Appointments sit at their time; tasks, deadlines, milestones and all-day items
// are listed above the grid. `chip` renders an item the same way the month view does, so every item looks alike.
export default function TimeGrid({ dates, byDate, today, label, pressure, writable, chip, onAdd, onOpen, longDate }) {
  const scroller = useRef(null);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, ((dates.includes(today) ? nowMin - 60 : 7 * 60) / 60) * HOUR_PX);
  }, [dates.join(), today]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = dates.map((d) => {
    const all = byDate[d] || [];
    const timed = all.filter((i) => i.source === 'event' && !i.all_day && i.start_local?.length >= 16).map((i) => {
      const start = mins(i.start_local.slice(11, 16));
      const sameDay = i.end_local && i.end_local.slice(0, 10) === i.start_local.slice(0, 10);
      const end = sameDay ? Math.max(start + 20, mins(i.end_local.slice(11, 16))) : (i.end_local ? 24 * 60 : start + 60);
      return { item: i, start, end: Math.min(end, 24 * 60) };
    });
    return { d, timed: layout(timed), allDay: all.filter((i) => !timed.some((t) => t.item === i)) };
  });

  return (
    <div className="tg" role="grid" aria-label={label} style={{ '--cols': dates.length }}>
      <div className="tg__head" role="row">
        <div className="tg__corner" />
        {cols.map(({ d }) => (
          <div key={d} role="columnheader" className={`tg__dayhead ${d === today ? 'is-today' : ''}`}>
            <span>{longDate(d, { weekday: 'short' })}</span><b>{Number(d.slice(8))}</b>
            {pressure.has(d) && <small className="tg__heavy">Heavy day</small>}
          </div>
        ))}
      </div>
      <div className="tg__allday" role="row">
        <div className="tg__axis-label">All day</div>
        {cols.map(({ d, allDay }) => (
          <div key={d} role="gridcell" className="tg__allday-cell">
            {allDay.map(chip)}
            {writable && <button type="button" className="cal-add" aria-label={`Add event on ${d}`} onClick={() => onAdd(d)}><Plus size={12} aria-hidden="true" /></button>}
          </div>
        ))}
      </div>
      <div className="tg__scroll" ref={scroller}>
        <div className="tg__body" style={{ height: 24 * HOUR_PX }}>
          <div className="tg__axis">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR_PX }}>{h === 0 ? '' : hh(h)}</span>)}</div>
          {cols.map(({ d, timed }) => (
            <div key={d} role="gridcell" aria-label={`${d} timeline`} className={`tg__col ${d === today ? 'is-today' : ''}`}
              onClick={(e) => {
                if (!writable || e.target !== e.currentTarget) return;
                const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                onAdd(d, Math.min(23, Math.floor(y / HOUR_PX)));
              }}>
              {timed.map(({ item, start, end, lane, lanes }) => (
                <button key={item.id} type="button" className={`tg__event cal-chip--${item.kind}`} onClick={() => onOpen(item)}
                  style={{ top: (start / 60) * HOUR_PX, height: Math.max(22, ((end - start) / 60) * HOUR_PX - 2), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                  title={`${item.start_local.slice(11, 16)} ${item.title}`}>
                  <b>{item.start_local.slice(11, 16)}</b> {item.title}{item.recurring ? ' (repeats)' : ''}
                </button>
              ))}
              {d === today && <div className="tg__now" style={{ top: (nowMin / 60) * HOUR_PX }} aria-hidden="true" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
