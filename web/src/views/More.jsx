import { badgeCount } from '../format';
import { FF_CAMPAIGNS, flagEnabled } from '../flags';
import { useJobs } from '../jobs';
import { moreItems } from '../campaigns/nav';

/** Low-frequency views. Settings lives on the header gear, not here. */
export default function More() {
  const campaigns = flagEnabled(FF_CAMPAIGNS);
  const { unreviewed, inboxWaiting } = useJobs();
  const items = moreItems(campaigns);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>More</h1>
          <p className="muted">Views you open between the daily ones.</p>
        </div>
      </header>
      <ul className="more-menu">
        {items.map((item) => {
          const count = item.id === 'proposals' ? unreviewed : 0;
          const text = badgeCount(count);
          return (
            <li key={item.id}>
              <a className="more-link" href={`#/${item.id}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>
                <span>
                  {/* Inbox keeps main's inline count so the flag-off page matches main. */}
                  <span className="lead-name">{item.label}{item.id === 'inbox' && inboxWaiting ? <span className="tab-count more-count">{inboxWaiting}</span> : null}</span>
                  <span className="muted">{item.hint}</span>
                </span>
                {text && <span className="rail-count" aria-label={`${count} proposals to review`}>{text}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
