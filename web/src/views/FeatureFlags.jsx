import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import {
  closedPanelFlags,
  panelFlagsFromRecords,
} from '../flags-contract.js';
import {
  getFeatureFlagState,
  previewFlagsOverride,
  replaceRemoteFlag,
  subscribeFeatureFlags,
} from '../flags';
import { refreshRemoteFlags } from '../remote-flags';
import { timeAgo } from '../ui';

function safeTimeAgo(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  return timeAgo(value);
}

function lastChangedText(flag) {
  const who = flag.updated_by || '';
  const when = flag.updated_at ? safeTimeAgo(flag.updated_at) : '';
  if (!who && !when) return 'Not changed yet';
  if (who && when) return `${who} · ${when}`;
  return who || when;
}

// `version` changes when Settings saves (for example a new API key), so the
// list reloads without a manual Retry.
export default function FeatureFlagsPanel({ version = 0 }) {
  const snap = useSyncExternalStore(subscribeFeatureFlags, getFeatureFlagState, getFeatureFlagState);
  const [reloadToken, setReloadToken] = useState(0);
  const [phase, setPhase] = useState({});
  const preview = previewFlagsOverride();

  useEffect(() => {
    refreshRemoteFlags().catch(() => {});
  }, [reloadToken, version]);

  useEffect(() => {
    setPhase({});
  }, [reloadToken, version]);

  const ready = snap.status === 'ready';
  const loading = snap.status === 'loading' || snap.status === 'idle';
  const flags = ready ? panelFlagsFromRecords(snap.records) : closedPanelFlags();
  const saving = Object.values(phase).some((row) => row?.kind === 'saving');

  const ask = (flag) => {
    if (!ready || flag.env_forced_off || !flag.writable || saving) return;
    setPhase({ [flag.name]: { kind: 'confirm', next: !flag.enabled } });
  };

  const cancel = (name) => {
    setPhase((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const commit = async (flag, next) => {
    setPhase({ [flag.name]: { kind: 'saving', next } });
    try {
      const saved = await api.setFlag(flag.name, next);
      replaceRemoteFlag(saved);
      setPhase({ [flag.name]: { kind: 'saved' } });
    } catch (error) {
      setPhase({
        [flag.name]: {
          kind: 'error',
          next,
          message: error?.message || 'Could not save this flag.',
        },
      });
    }
  };

  return (
    <section className="panel flag-panel" aria-busy={loading ? 'true' : 'false'}>
      <h2>Feature flags</h2>
      <p className="muted">These switches save to the server and take effect right away. If the server environment forces a flag off, its switch is locked off. Flags marked read-only are set only by the server environment. Live sending is not listed here.</p>
      {preview && (
        <p className="flag-preview">This browser has a preview override. The switches show the saved values.</p>
      )}
      {loading && <p className="flag-status" role="status">Loading feature flags…</p>}
      {snap.status === 'error' && (
        <div className="error-note flag-alert" role="alert">
          <p>Feature flags could not be loaded. Every flag is off.</p>
          <button type="button" className="btn btn-quiet" onClick={() => setReloadToken((token) => token + 1)}>Retry</button>
        </div>
      )}
      <ul className="flag-list">
        {flags.map((flag) => {
          const row = phase[flag.name] || {};
          const readOnly = ready && !flag.writable;
          const locked = !ready || flag.env_forced_off || readOnly || saving || row.kind === 'saving';
          return (
            <li className="flag-row" key={flag.name} aria-label={flag.name}>
              <div className="flag-copy">
                <span className="flag-name" id={`flag-${flag.name}`}>{flag.name}</span>
                <span className="flag-label">{flag.label}</span>
                <span className="flag-meta">Last changed: {lastChangedText(flag)}</span>
                {flag.env_forced_off && <p className="flag-env">Forced off by the environment.</p>}
                {readOnly && !flag.env_forced_off && (
                  <p className="flag-env">{flag.source === 'env' ? 'Read-only. Set by the server environment.' : 'Read-only. The server does not list this flag.'}</p>
                )}
              </div>
              <div className="flag-actions">
                <button
                  type="button"
                  role="switch"
                  className={`flag-switch${flag.enabled ? ' is-on' : ''}`}
                  aria-checked={flag.enabled ? 'true' : 'false'}
                  aria-label={flag.name}
                  aria-busy={row.kind === 'saving' ? 'true' : 'false'}
                  disabled={locked}
                  onClick={() => ask(flag)}
                >
                  {row.kind === 'saving' ? 'Saving…' : flag.enabled ? 'On' : 'Off'}
                </button>
                {row.kind === 'confirm' && (
                  <div className="flag-confirm" role="group" aria-label={`Confirm ${flag.name}`}>
                    <p>Turn {flag.name} {row.next ? 'on' : 'off'}?</p>
                    <button type="button" className="btn" onClick={() => commit(flag, row.next)}>Confirm</button>
                    <button type="button" className="btn btn-quiet" onClick={() => cancel(flag.name)}>Cancel</button>
                  </div>
                )}
                {row.kind === 'error' && (
                  <div className="flag-row-error" role="alert">
                    <p>Couldn&apos;t save {flag.name}. It stays {flag.enabled ? 'on' : 'off'}.</p>
                    <button type="button" className="btn btn-quiet" onClick={() => commit(flag, row.next)}>Retry</button>
                  </div>
                )}
                {row.kind === 'saved' && <p className="ok-note" role="status">Saved.</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
