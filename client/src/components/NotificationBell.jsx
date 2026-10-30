import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../api/client.js';

export default function NotificationBell() {
  const [data, setData] = useState({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const navigate = useNavigate();

  const load = useCallback((refresh = false) => (refresh ? api.refreshNotifications() : api.notifications()).then(setData).catch(() => {}), []);
  useEffect(() => {
    load(true);
    const t = setInterval(() => load(true), 60_000);
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => (e.type === 'keydown' ? e.key === 'Escape' : !wrap.current?.contains(e.target)) && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  const go = async (n) => {
    setOpen(false);
    if (!n.read_at) api.readNotification(n.id).then(setData).catch(() => {});
    if (n.link) navigate(n.link);
  };

  return (
    <div className="bell" ref={wrap}>
      <button type="button" className="btn btn-icon btn-ghost" aria-label={`Notifications, ${data.unread} unread`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Bell size={18} />{data.unread > 0 && <span className="bell__badge" aria-hidden="true">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell__menu" role="region" aria-label="Notifications">
          <div className="bell__head"><strong>Notifications</strong>
            {data.unread > 0 && <button type="button" className="btn btn-ghost" onClick={() => api.readAllNotifications().then(setData)}>Mark all read</button>}</div>
          {data.items.length === 0 && <p className="muted" style={{ padding: 12 }}>Nothing yet. Reminders, due tasks and budget alerts appear here.</p>}
          <ul>
            {data.items.map((n) => (
              <li key={n.id}><button type="button" className={n.read_at ? '' : 'is-unread'} onClick={() => go(n)}>
                <span>{n.title}</span><small>{n.body} · {new Date(n.created_at).toLocaleString()}</small></button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
