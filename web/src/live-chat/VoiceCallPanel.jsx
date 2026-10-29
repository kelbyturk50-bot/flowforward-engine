import { useEffect, useRef, useState } from 'react';
import { preloadVoiceSdk, readVoiceStatus, refusalText, startVoiceCall } from './voice-client.js';

// "Call the receptionist": a browser call to an AI receptionist that answers
// in this shop's name, from the approved facts. Nothing is booked, nothing
// dials a phone. The panel is absent when voice is off for this link.
//
// A call must never outlive the panel: unmounting, Cancel, or End always
// reaches call.end(), including a call that was still being created.

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

function endQuietly(call) {
  try {
    const ending = call?.end?.();
    if (ending && typeof ending.catch === 'function') ending.catch(() => {});
  } catch { /* already over */ }
}

export default function VoiceCallPanel({
  token,
  businessName = 'this business',
  readStatus = readVoiceStatus,
  startCall = startVoiceCall,
  preload = preloadVoiceSdk,
}) {
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [message, setMessage] = useState('');
  const [left, setLeft] = useState(0);
  const [muted, setMuted] = useState(false);
  const callRef = useRef(null);
  const mountedRef = useRef(true);
  const cancelledRef = useRef(false);
  const refusedRef = useRef(false);
  const liveRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    readStatus(token).then((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next?.available) preload().catch(() => {});
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      cancelledRef.current = true;
      endQuietly(callRef.current);
      callRef.current = null;
    };
  }, [token, readStatus, preload]);

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
    cancelledRef.current = false;
    liveRef.current = false;
    setPhase('connecting');
    setLeft(status.maxSeconds || 180);
    try {
      const call = await startCall({
        token,
        onRefused: (code, data) => {
          refusedRef.current = true;
          if (!mountedRef.current) return;
          setMessage(refusalText(code, data));
          if (code === 429 && data?.reason === 'link') setStatus({ available: false, reason: 'limit' });
        },
        hooks: {
          onStatus: (next) => {
            if (next !== 'live' || !mountedRef.current) return;
            liveRef.current = true;
            setPhase('live');
          },
          onEnd: () => {
            callRef.current = null;
            if (!mountedRef.current) return;
            const used = liveRef.current;
            setPhase((current) => (current === 'error' ? current : 'ended'));
            if (used) {
              setStatus((current) => (current && current.available
                ? { ...current, callsLeft: Math.max(0, current.callsLeft - 1) }
                : current));
            }
          },
          onError: (err) => {
            if (!mountedRef.current) return;
            // A non-fatal error during a live call leaves the call running:
            // keep End and Mute on screen.
            const session = callRef.current;
            if (session && session.status && session.status !== 'ended' && liveRef.current) {
              setMessage('The connection hiccuped. If you can\'t hear the receptionist, end the call and try again.');
              return;
            }
            if (!refusedRef.current) setMessage(micText(err));
            setPhase('error');
          },
        },
      });
      // Unmounted or cancelled while the call was being created: end it now.
      if (!mountedRef.current || cancelledRef.current) {
        endQuietly(call);
        return;
      }
      callRef.current = call;
    } catch (err) {
      if (!mountedRef.current) return;
      if (!refusedRef.current) setMessage(micText(err));
      setPhase('error');
    }
  }

  function hangUp() {
    cancelledRef.current = true;
    const call = callRef.current;
    callRef.current = null;
    setPhase('ended');
    endQuietly(call);
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
        ) : phase === 'connecting' ? (
          <div className="voice-call-controls">
            <span className="voice-call-live" role="status">Connecting…</span>
            <button type="button" className="live-chat-action voice-call-btn" onClick={hangUp}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="live-chat-send voice-call-btn" disabled={!canCall} onClick={begin}>
            {phase === 'ended' ? 'Call again' : 'Call the receptionist'}
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
