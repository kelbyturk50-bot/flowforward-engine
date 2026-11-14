import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  actionMessage,
  callHref,
  companyName,
  isTaskListHidden,
  phoneText,
  snoozeLabel,
  snoozeStillHeld,
  taskPathId,
  taskSubline,
  taskTitle,
  tasksFromPayload,
} from '../demo-view-task';
import { ErrorNote, toast } from '../ui';

function visibleOpen(tasks, closed, snoozed, now) {
  const skip = new Set(closed);
  for (const item of snoozed) {
    if (snoozeStillHeld(item.until, now)) skip.add(taskPathId(item.task.id));
  }
  return tasks.filter((task) => {
    const id = taskPathId(task.id);
    return id && !skip.has(id);
  });
}

export default function DemoViewTasks({ version, bump, openLead }) {
  const [tasks, setTasks] = useState([]);
  const [snoozed, setSnoozed] = useState([]);
  const [closed, setClosed] = useState([]);
  const [hidden, setHidden] = useState(false);
  const [listError, setListError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(null);
  const [tick, setTick] = useState(0);
  const pendingRef = useRef(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    let live = true;
    api.demoViewTasks().then((data) => {
      if (!live || seq !== requestSeq.current) return;
      const next = tasksFromPayload(data);
      setTasks(next);
      setHidden(false);
      setListError(null);
      setLoaded(true);
      const now = new Date();
      setSnoozed((prev) => prev.filter((item) => {
        if (snoozeStillHeld(item.until, now)) return true;
        const id = taskPathId(item.task.id);
        return !next.some((task) => taskPathId(task.id) === id);
      }));
    }).catch((error) => {
      if (!live || seq !== requestSeq.current) return;
      if (isTaskListHidden(error)) {
        setHidden(true);
        setTasks([]);
        setSnoozed([]);
        setListError(null);
        setLoaded(true);
        return;
      }
      setHidden(false);
      setListError(error);
      setLoaded(true);
    });
    return () => { live = false; };
  }, [version, tick]);

  async function act(task, kind) {
    const id = taskPathId(task.id);
    if (!id || pendingRef.current) return;
    pendingRef.current = id;
    setPending(id);
    const company = companyName(task);
    try {
      if (kind === 'done') {
        await api.demoViewTaskDone(id);
        setClosed((list) => (list.includes(id) ? list : [...list, id]));
        toast(`Logged “called” for ${company}.`);
        bump();
      } else if (kind === 'dismiss') {
        await api.demoViewTaskDismiss(id);
        setClosed((list) => (list.includes(id) ? list : [...list, id]));
        toast(`Dismissed the call for ${company}.`);
        bump();
      } else {
        const result = await api.demoViewTaskSnooze(id);
        const until = result?.snoozed_until || null;
        setSnoozed((list) => [
          ...list.filter((item) => taskPathId(item.task.id) !== id),
          { task, until },
        ]);
        const when = snoozeLabel(until);
        toast(when.endsWith('.') ? when : `${when}.`);
        bump();
      }
    } catch (error) {
      if (isTaskListHidden(error)) {
        setClosed((list) => (list.includes(id) ? list : [...list, id]));
        bump();
        return;
      }
      if (error?.status === 409) {
        setClosed((list) => (list.includes(id) ? list : [...list, id]));
        bump();
      }
      toast(actionMessage(error));
    } finally {
      if (pendingRef.current === id) pendingRef.current = null;
      setPending((current) => (current === id ? null : current));
    }
  }

  if (!loaded || hidden) return null;
  const now = new Date();
  const open = visibleOpen(tasks, closed, snoozed, now);
  const held = snoozed.filter((item) => snoozeStillHeld(item.until, now));
  if (!listError && open.length === 0 && held.length === 0) return null;

  return (
    <section className="panel view-task-panel" aria-labelledby="view-tasks-heading">
      <h2 id="view-tasks-heading">Call them</h2>
      <p className="panel-note">Nothing is sent from here.</p>
      {listError && (
        <ErrorNote error={{ message: actionMessage(listError) }} onRetry={() => setTick((n) => n + 1)} />
      )}
      {(open.length > 0 || held.length > 0) && (
        <ul className="view-task-list">
          {open.map((task) => {
            const id = taskPathId(task.id);
            const company = companyName(task);
            const phone = phoneText(task.phone);
            const href = callHref(task.phone);
            const leadId = taskPathId(task.prospect_id);
            const busy = pending === id;
            return (
              <li key={id} className="view-task">
                <div className="view-task-copy">
                  <p className="view-task-title">{taskTitle(task)}</p>
                  {taskSubline(task) && <p className="view-task-sub">{taskSubline(task)}</p>}
                  {task.demo_link_expired === true && <p className="view-task-note">demo link expired</p>}
                  {!phone && <p className="view-task-nophone">No phone on file</p>}
                </div>
                <div className="view-task-actions">
                  {phone && href && (
                    <a className="btn view-task-btn" href={href} aria-label={`Call ${company} at ${phone}`}>
                      Call <span className="view-task-phone">{phone}</span>
                    </a>
                  )}
                  {!phone && leadId && (
                    <button type="button" className="btn view-task-btn" aria-label={`Open ${company}`} onClick={() => openLead(Number(leadId))}>
                      Open lead
                    </button>
                  )}
                  <button type="button" className="btn btn-quiet view-task-btn" aria-label={`Done, ${company}`} disabled={busy} onClick={() => act(task, 'done')}>
                    Done
                  </button>
                  <button type="button" className="btn btn-quiet view-task-btn" aria-label={`Snooze ${company} for 1 day`} disabled={busy} onClick={() => act(task, 'snooze')}>
                    Snooze 1 day
                  </button>
                  <button type="button" className="btn btn-quiet view-task-btn" aria-label={`Dismiss ${company}`} disabled={busy} onClick={() => act(task, 'dismiss')}>
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
          {held.map((item) => {
            const id = taskPathId(item.task.id);
            return (
              <li key={`snoozed-${id}`} className="view-task view-task-snoozed">
                <div className="view-task-copy">
                  <p className="view-task-title">{taskTitle(item.task)}</p>
                  <p className="view-task-sub">{snoozeLabel(item.until, now)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
