/** Low-frequency views. Settings lives on the header gear, not here. */
export default function More() {
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
