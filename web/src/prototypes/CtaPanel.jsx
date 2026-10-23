// Price anchors are Kelby's Oct 16 decision in docs/PROTOTYPE_PLAY.md.
// Timeline has no approved number, so that row stays hidden.
// The link does not submit a form or send mail.
export default function CtaPanel() {
  return (
    <aside className="prototype-cta" aria-label="How we'd make this real">
      <h2>{"How we'd make this real"}</h2>
      <ol>
        <li>Connect your phone, calendar or books.</li>
        <li>We configure and test it with you.</li>
        <li>Go live, with hosting and maintenance.</li>
      </ol>
      <p>Prototype $0. MVP build $1,500–$3,500. Hosting $150–$400 a month. Consulting $125–$200 an hour.</p>
      <a className="prototype-cta-link" href="#talk-to-kelby">Talk to Kelby</a>
    </aside>
  );
}
