import { useEffect, useRef, useState } from 'react';
import { readVoiceStatus, refusalText, startVoiceCall } from './voice-client.js';

// "Call the receptionist": a browser call to an AI receptionist that answers
// in this shop's name, from the approved facts. Nothing is booked, nothing
// dials a phone. The panel is absent when voice is off for this link.

const TRY_SAYING = Object.freeze([
  'Are you open Saturday?',
  'My furnace stopped working and the house is cold.',
  'Can someone come out Tuesday morning?',
  'How much is a new AC?',
]);

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function micText(err) {
  const text = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
  if (text.includes('notallowed') || text.includes('permission') || text.includes('denied')) {
    return 'Allow the microphone to talk to the receptionist, then press Call again.';
  }
  return 'The call didn\'t connect. Try again in a minute.';
}

export default function VoiceCallPanel({
  token,
  businessName = 'this business',
  readStatus = readVoiceStatus,
  startCall = startVoiceCall,
}) {
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [left, setLeft] = useState(0);
  const [muted, setMuted] = useState(false);
  const callRef = useRef(null);
  const refusedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readStatus(token).then((next) => { if (!cancelled) setStatus(next); });
    return () => {
      cancelled = true;
      const ending = callRef.current?.end?.();
      if (ending && typeof ending.catch === 'function') ending.catch(() => {});
    };
  }, [token, readStatus]);

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const timer = setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  if (!status || (!status.available && status.reason !== 'limit')) return null;

  const callsLeft = status.available ? status.callsLeft : 0;

  async function begin() {
    setMessage('');
    setMuted(false);
    refusedRef.current = false;
    setPhase('connecting');
    setLeft(status.maxSeconds || 180);
    try {
      const call = await startCall({
        token,
        onRefused: (code, data) => {
          refusedRef.current = true;
          setMessage(refusalText(code, data));
          if (code === 429 && data?.reason === 'link') setStatus({ available: false, reason: 'limit' });
        },
        hooks: {
          onStatus: (next) => {
            if (next === 'live') setPhase('live');
          },
          onEnd: () => {
            callRef.current = null;
            setPhase((current) => (current === 'error' ? current : 'ended'));
            setStatus((current) => (current && current.available
              ? { ...current, callsLeft: Math.max(0, current.callsLeft - 1) }
              : current));
          },
          onError: (err) => {
            if (!refusedRef.current) setMessage(micText(err));
            setPhase('error');
          },
        },
      });
      callRef.current = call;
    } catch (err) {
      if (!refusedRef.current) setMessage(micText(err));
      setPhase('error');
    }
  }

  async function hangUp() {
    const call = callRef.current;
    callRef.current = null;
    setPhase('ended');
    try { await call?.end?.(); } catch { /* the call is over either way */ }
  }

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    if (muted) call.unmute?.();
    else call.mute?.();
    setMuted(!muted);
  }

  const canCall = status.available && callsLeft > 0 && phase !== 'connecting' && phase !== 'live';

  return (
    <section className="voice-call" aria-label="Call the receptionist">
      <div className="voice-call-head">
        <div>
          <h2 className="voice-call-title">Prefer to call? Talk to {businessName}&apos;s AI receptionist</h2>
          <p className="voice-call-note">
            Uses your microphone in this browser. No phone number is dialed and nothing is booked.
            Calls end after {clock(status.maxSeconds || 180)}.
          </p>
        </div>
        {phase === 'live' ? (
          <div className="voice-call-controls">
            <span className="voice-call-live" role="status">Live · {clock(left)} left</span>
            <button type="button" className="live-chat-action voice-call-btn" onClick={toggleMute} aria-pressed={muted}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" className="live-chat-send voice-call-btn" onClick={hangUp}>End call</button>
          </div>
        ) : (
          <button type="button" className="live-chat-send voice-call-btn" disabled={!canCall} onClick={begin}>
            {phase === 'connecting' ? 'Connecting…' : phase === 'ended' ? 'Call again' : 'Call the receptionist'}
          </button>
        )}
      </div>
      {phase === 'connecting' ? <p className="voice-call-status" role="status">Allow the microphone if your browser asks.</p> : null}
      {phase === 'live' ? (
        <div className="voice-call-try">
          <p className="voice-call-try-label">Try saying</p>
          <ul>{TRY_SAYING.map((line) => <li key={line}>“{line}”</li>)}</ul>
        </div>
      ) : null}
      {phase === 'ended' && !message ? (
        <p className="voice-call-status" role="status">
          Call ended. On a live line, the owner gets a text with the caller&apos;s name, the problem and how urgent it is.
        </p>
      ) : null}
      {message ? <p className="voice-call-status is-error" role="alert">{message}</p> : null}
      {!status.available && !message ? (
        <p className="voice-call-status" role="status">This link has used its sample calls. The text demo below still works.</p>
      ) : null}
    </section>
  );
}
