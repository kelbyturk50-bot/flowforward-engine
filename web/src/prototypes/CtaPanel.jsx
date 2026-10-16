// Price and timeline stay blank until Kelby fills them in.
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
      <p>Timeline: [Kelby to fill in]</p>
      <p>Price: [Kelby to fill in]</p>
      <a className="prototype-cta-link" href="#talk-to-kelby">Talk to Kelby</a>
    </aside>
  );
}
