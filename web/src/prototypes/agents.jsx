import { SampleTag, SampleValue, liveToast, usePrototypeNotify } from '../components/PrototypeWatermark';

function AgentScreen({ kicker, title, children }) {
  return (
    <main id="prototype-main" className="prototype-agent">
      <p className="demo-kicker">{kicker}</p>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

function ActionButton({ children, action }) {
  const notify = usePrototypeNotify();
  return (
    <button type="button" className="demo-btn" onClick={() => notify?.(liveToast(action))}>
      {children}
    </button>
  );
}

export function SchedulingPrototype() {
  return (
    <AgentScreen kicker="Scheduling" title="Book a visit">
      <p className="muted demo-lead">
        Open slots for a fictional homeowner. Choosing one does not write to a calendar.
      </p>
      <ul className="prototype-slots">
        {['Tue 9:00', 'Tue 13:00', 'Wed 10:30'].map(slot => (
          <li key={slot}>
            <SampleValue>{slot}</SampleValue>
            <span className="muted"> with <SampleValue>Sample Homeowner</SampleValue></span>
          </li>
        ))}
      </ul>
      <p>Phone <SampleValue>(801) 555-0142</SampleValue></p>
      <ActionButton action="book the slot">Book this slot</ActionButton>
    </AgentScreen>
  );
}

export function CallPrototype() {
  return (
    <AgentScreen kicker="Call" title="Missed call">
      <p className="muted demo-lead">
        A sample text-back. Nothing is dialed and no message leaves this page.
      </p>
      <article className="prototype-card">
        <h2>Call record <SampleTag /></h2>
        <p><SampleValue>Sample Homeowner</SampleValue> · <SampleValue>(801) 555-0148</SampleValue></p>
        <p>Could you look at the furnace this week?</p>
      </article>
      <article className="prototype-card">
        <h2>Draft text-back <SampleTag /></h2>
        <p>We can hold Tue at 9:00. This reply stays on the screen.</p>
      </article>
      <ActionButton action="send the text-back">Send text-back</ActionButton>
    </AgentScreen>
  );
}

export function BookkeepingPrototype() {
  return (
    <AgentScreen kicker="Bookkeeping" title="Receipts">
      <p className="muted demo-lead">
        A sample ledger. Sync does not reach a bookkeeping product.
      </p>
      <ul className="demo-estimates">
        <li>
          <div className="demo-est-head">
            <span><SampleValue>Sample Filter Supply</SampleValue></span>
            <span className="demo-money"><SampleValue>$86</SampleValue></span>
          </div>
        </li>
        <li>
          <div className="demo-est-head">
            <span><SampleValue>Sample Fuel Stop</SampleValue></span>
            <span className="demo-money"><SampleValue>$64</SampleValue></span>
          </div>
        </li>
      </ul>
      <ActionButton action="sync the ledger">Sync to books</ActionButton>
    </AgentScreen>
  );
}
