import { useEffect, useMemo, useState } from 'react';
import RateCell, { OpenInfo } from '../campaigns/RateCell';
import { listCampaigns } from '../campaigns/client';
import { STATUS_FILTERS } from '../campaigns/fixture';
import {
  campaignInRange,
  campaignMatchesStatus,
  channelLabel,
  dateRanges,
  footnote,
  formatCampaignDates,
  headlineMetrics,
  sortCampaigns,
  statusLabel,
  untouchedMessage,
} from '../campaigns/metrics';
import { useAsync } from '../ui';

const OPENS_KEY = 'ff.campaignMachineOpens';

function readMachineOpens() {
  try { return localStorage.getItem(OPENS_KEY) === '1'; } catch { return false; }
}

function writeMachineOpens(on) {
  try { localStorage.setItem(OPENS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

// `today` is injectable for tests; the date-range chip is relative to it.
// The selected range goes to the API, so every count is for that range.
export default function Campaigns({ load = listCampaigns, today = null }) {
  const ranges = useMemo(() => dateRanges(today || new Date()), [today]);
  const [status, setStatus] = useState('all');
  const [rangeId, setRangeId] = useState('lifetime');
  const [dateOpen, setDateOpen] = useState(false);
  const [includeMachineOpens, setIncludeMachineOpens] = useState(readMachineOpens);
  const range = ranges.find((item) => item.id === rangeId) || ranges[0];
  const list = useAsync(() => load({ range: { from: range.from, to: range.to } }), [load, range.from, range.to]);

  useEffect(() => { writeMachineOpens(includeMachineOpens); }, [includeMachineOpens]);

  const campaigns = useMemo(() => {
    const rows = list.data?.campaigns || [];
    return sortCampaigns(rows.filter((row) => campaignMatchesStatus(row, status) && campaignInRange(row, range)));
  }, [list.data, status, range]);

  const filtered = status !== 'all' || rangeId !== 'lifetime';
  const showFilters = list.loading || list.error || (list.data && (campaigns.length > 0 || filtered));

  function clearFilters() {
    setStatus('all');
    setRangeId('lifetime');
    setDateOpen(false);
  }

  return (
    <div className="page camp-page">
      <header className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p className="muted">Observed results of your own outreach. FlowForward never sends from here.</p>
        </div>
        <button type="button" className="btn camp-new">New campaign</button>
      </header>

      {showFilters && (
        <div className="camp-filters">
          <div className="camp-status" role="radiogroup" aria-label="Status">
            {STATUS_FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                className="camp-chip"
                aria-checked={status === item.id}
                onClick={() => setStatus(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="camp-date">
            <button
              type="button"
              className="camp-chip"
              aria-expanded={dateOpen}
              aria-haspopup="listbox"
              onClick={() => setDateOpen((open) => !open)}
            >
              {range.label}
              <span aria-hidden="true"> ▾</span>
            </button>
            {dateOpen && (
              <div className="camp-date-menu" role="listbox" aria-label="Date range">
                {ranges.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    className="camp-chip"
                    aria-selected={item.id === rangeId}
                    onClick={() => { setRangeId(item.id); setDateOpen(false); }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="machine-switch"
            role="switch"
            aria-checked={includeMachineOpens}
            onClick={() => setIncludeMachineOpens((on) => !on)}
          >
            <span>Include machine opens</span>
            <span className="switch-track" aria-hidden="true" />
          </button>
        </div>
      )}

      {list.loading && (
        <div className="camp-loading" role="status" aria-busy="true" aria-live="polite">
          <p className="muted">Loading campaigns…</p>
          {[0, 1, 2, 3].map((row) => (
            <div className="camp-skel-row" key={row} aria-hidden="true">
              <span className="camp-skel" style={{ width: '70%' }} />
              <span className="camp-skel" />
              <span className="camp-skel" style={{ width: '85%' }} />
              <span className="camp-skel" style={{ width: '60%' }} />
            </div>
          ))}
        </div>
      )}

      {list.error && (
        <div className="error-note camp-error" role="alert">
          <p>
            {list.error.status === 503
              ? "Couldn't load campaigns. The server's API key isn't configured yet."
              : <>Couldn&apos;t load campaigns. Check your connection.</>}
          </p>
          <button type="button" className="btn btn-quiet camp-retry" onClick={list.reload}>Retry</button>
        </div>
      )}

      {!list.loading && !list.error && list.data && campaigns.length === 0 && !filtered && (
        <div className="camp-state">
          <h2>No campaigns yet</h2>
          <p className="muted">Create one to start tracking replies and booked calls from your outreach.</p>
          <button type="button" className="btn camp-new">New campaign</button>
        </div>
      )}

      {!list.loading && !list.error && filtered && campaigns.length === 0 && (
        <div className="camp-state">
          <h2>No campaigns match these filters</h2>
          <button type="button" className="btn camp-retry" onClick={clearFilters}>Clear filters</button>
        </div>
      )}

      {!list.loading && !list.error && campaigns.length > 0 && (
        <>
          <div className="table-wrap camp-table-wrap">
            <table className="camp-table">
              <caption className="sr-only">Campaigns</caption>
              <thead>
                <tr>
                  <th className="camp-name-col">Campaign</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Dates</th>
                  <th>Enrolled</th>
                  <th>Touched</th>
                  <th>Responded</th>
                  <th>Converted to project</th>
                  <th>
                    <span className="camp-open-head">Opened, no response</span>
                    <span className="rate-approx">
                      <span className="approx">Approximate</span>
                      <OpenInfo />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <CampaignRow key={campaign.id} campaign={campaign} includeMachineOpens={includeMachineOpens} />
                ))}
              </tbody>
            </table>
          </div>
          <ul className="camp-cards" aria-label="Campaign cards">
            {campaigns.map((campaign) => (
              <CampaignCard key={campaign.id} campaign={campaign} includeMachineOpens={includeMachineOpens} />
            ))}
          </ul>
          <p className="muted small camp-foot">{footnote({ includeMachineOpens })}</p>
        </>
      )}
    </div>
  );
}

function CampaignIdentity({ campaign }) {
  return (
    <>
      <div className="camp-name">{campaign.name}</div>
      {campaign.name.startsWith('TEST:') && <span className="sample-tag">Sample</span>}
    </>
  );
}

function HeadlineCells({ campaign, metrics, includeMachineOpens }) {
  const quiet = untouchedMessage(metrics);
  if (quiet) return <td colSpan={3} className="muted small">{quiet}</td>;
  const email = campaign.channel === 'email';
  return (
    <>
      <td><RateCell k={metrics.responded} d={metrics.touched} noun="responded" /></td>
      <td><RateCell k={metrics.converted} d={metrics.touched} noun="converted" /></td>
      <td>
        {email
          ? (
            <RateCell
              k={metrics.openedNoReply}
              d={metrics.touched}
              noun="opened, no reply"
              approximate
              machineOpens={metrics.machineOpens}
              machineOpensIncluded={includeMachineOpens}
            />
          )
          : <span className="muted small">Email only</span>}
      </td>
    </>
  );
}

function CampaignRow({ campaign, includeMachineOpens }) {
  const metrics = headlineMetrics(campaign, { includeMachineOpens });
  return (
    <tr>
      <td className="camp-name-col"><CampaignIdentity campaign={campaign} /></td>
      <td>{channelLabel(campaign.channel)}</td>
      <td><span className={`camp-pill camp-pill-${campaign.status}`}>{statusLabel(campaign.status)}</span></td>
      <td className="small">{formatCampaignDates(campaign.startDate, campaign.endDate)}</td>
      <td className="camp-num">{metrics.enrolled}</td>
      <td className="camp-num">{metrics.touched}</td>
      <HeadlineCells campaign={campaign} metrics={metrics} includeMachineOpens={includeMachineOpens} />
    </tr>
  );
}

function CampaignCard({ campaign, includeMachineOpens }) {
  const metrics = headlineMetrics(campaign, { includeMachineOpens });
  const quiet = untouchedMessage(metrics);
  const email = campaign.channel === 'email';
  return (
    <li className="camp-card">
      <div className="camp-card-top">
        <div><CampaignIdentity campaign={campaign} /></div>
        <span className={`camp-pill camp-pill-${campaign.status}`}>{statusLabel(campaign.status)}</span>
      </div>
      <p className="muted small camp-meta">
        {channelLabel(campaign.channel)}
        {' · '}
        {formatCampaignDates(campaign.startDate, campaign.endDate)}
        {' · '}
        {metrics.enrolled} enrolled
        {' · '}
        {metrics.touched} touched
      </p>
      {quiet && <p className="muted small camp-quiet">{quiet}</p>}
      {!quiet && (
        <div className="camp-metrics">
          <div className="camp-tile">
            <div className="camp-tile-k">Responded</div>
            <RateCell k={metrics.responded} d={metrics.touched} noun="responded" />
          </div>
          <div className="camp-tile">
            <div className="camp-tile-k">Converted to project</div>
            <RateCell k={metrics.converted} d={metrics.touched} noun="converted" />
          </div>
          {email && (
            <div className="camp-tile">
              <div className="camp-tile-k">Opened, no response</div>
              <RateCell
                k={metrics.openedNoReply}
                d={metrics.touched}
                noun="opened, no reply"
                approximate
                machineOpens={metrics.machineOpens}
                machineOpensIncluded={includeMachineOpens}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
