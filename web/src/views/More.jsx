import { useJobs } from '../jobs';

/** Low-frequency views. Settings lives on the header gear, not here. */
export default function More() {
  const { inboxWaiting } = useJobs();
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>More</h1>
          <p className="muted">Views you open between the daily ones.</p>
        </div>
      </header>
      <ul className="more-menu">
        <li>
          <a className="more-link" href="#/inbox">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l2 3h4l2-3h5M5.5 5h13L21 13v6H3v-6z" /></svg>
            <span>
              <span className="lead-name">Inbox{inboxWaiting ? <span className="tab-count more-count">{inboxWaiting}</span> : null}</span>
              <span className="muted">Replies from leads, with drafted responses</span>
            </span>
          </a>
        </li>
        <li>
          <a className="more-link" href="#/projects">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v12H4zM9 7V4h6v3" /></svg>
            <span>
              <span className="lead-name">Projects</span>
              <span className="muted">Client builds and your own work</span>
            </span>
          </a>
        </li>
      </ul>
    </div>
  );
}
