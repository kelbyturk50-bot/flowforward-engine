import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import Today from './views/Today';
import Leads from './views/Leads';
import Pipeline from './views/Pipeline';
import Projects from './views/Projects';
import Proposals from './views/Proposals';
import ProposalDrawer from './views/ProposalDrawer';
import Settings from './views/Settings';
import LeadDrawer from './views/LeadDrawer';
import ProjectDrawer from './views/ProjectDrawer';
import More from './views/More';
import { Toaster, isOverdue } from './ui';
import { api, currentApiBase, settings } from './api';
import ApiBanner from './ApiBanner';
import { JobsProvider, useJobs } from './jobs';
import { badgeCount } from './format';
import { FF_CAMPAIGNS, flagEnabled } from './flags';
import { moreBadge, railItems, resolveRoute, tabIsOn, tabItems } from './campaigns/nav';

const Campaigns = lazy(() => import('./views/Campaigns'));

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const readRoute = () => resolveRoute(window.location.hash, {
  campaigns: flagEnabled(FF_CAMPAIGNS),
  hasKey: Boolean(settings.apiKey),
});

function BrandMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M2 44 L20 16 L30 30 L42 12 L62 44 Z" className="brand-peaks" />
      <path d="M29 30 C24 36 22 42 30 46 C38 50 50 50 62 52 L62 58 C48 58 34 58 25 52 C17 47 21 37 29 30 Z" className="brand-river" />
    </svg>
  );
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [leadId, setLeadId] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [proposalId, setProposalId] = useState(null);
  const [version, setVersion] = useState(0);
  const [authProblem, setAuthProblem] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    const onAuth = () => { setAuthProblem(true); window.location.hash = '#/settings'; };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('ff:unauthorized', onAuth);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('ff:unauthorized', onAuth); };
  }, []);

  const bump = useCallback(() => setVersion(v => v + 1), []);
  const openLead = useCallback((id) => { setProjectId(null); setProposalId(null); setLeadId(id); }, []);
  const openProject = useCallback((id) => { setLeadId(null); setProposalId(null); setProjectId(id); }, []);
  const openProposal = useCallback((id) => { setLeadId(null); setProjectId(null); setProposalId(id); }, []);
  const shared = { version, bump, openLead, openProject, openProposal };
  const apiConfigured = currentApiBase().configured;
  const campaigns = flagEnabled(FF_CAMPAIGNS);
  const routes = railItems(campaigns);

  return (
    <JobsProvider bump={bump} version={version}>
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <MobileHeader route={route} />
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <BrandMark />
          <span>Flow<span className="brand-forward">Forward</span></span>
        </div>
        {routes.map(r => (
          <a key={r.id} href={`#/${r.id}`} className={`rail-link ${route === r.id ? 'active' : ''}`} aria-current={route === r.id ? 'page' : undefined}>
            {r.id === 'settings' ? <GearIcon /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d={r.icon} /></svg>}
            <span>{r.label}</span>
            {r.id === 'proposals' && <ProposalsBadge />}
          </a>
        ))}
      </nav>
      <MobileTabs route={route} version={version} campaigns={campaigns} />

      <main id="main" className="main">
        <ApiBanner configured={apiConfigured} />
        {route === 'today'    && <Today {...shared} />}
        {route === 'leads'    && <Leads {...shared} />}
        {route === 'proposals' && <Proposals {...shared} />}
        {route === 'pipeline' && <Pipeline {...shared} />}
        {route === 'campaigns' && (
          <Suspense fallback={<p className="muted">Loading campaigns…</p>}>
            <Campaigns />
          </Suspense>
        )}
        {route === 'projects' && <Projects {...shared} />}
        {route === 'more'     && <More />}
        {route === 'not-found' && (
          <div className="not-found-card">
            <h1>Page not found</h1>
            <p className="muted">That page is not here.</p>
            <a className="btn" href="#/today">Back to FlowForward</a>
          </div>
        )}
        {route === 'settings' && <Settings {...shared} authProblem={authProblem} onSaved={() => { setAuthProblem(false); bump(); }} />}
      </main>

      <LeadDrawer id={leadId} onClose={() => setLeadId(null)} {...shared} />
      <ProjectDrawer id={projectId} onClose={() => setProjectId(null)} {...shared} />
      <ProposalDrawer id={proposalId} onClose={() => setProposalId(null)} {...shared} />
      <Toaster />
    </div>
    </JobsProvider>
  );
}

function MobileHeader({ route }) {
  return (
    <header className="mobile-bar">
      <a className="brand brand-mobile" href="#/today">
        <BrandMark />
        <span>Flow<span className="brand-forward">Forward</span></span>
      </a>
      <a href="#/settings" className={`gear-btn ${route === 'settings' ? 'active' : ''}`} aria-label="Settings" aria-current={route === 'settings' ? 'page' : undefined}>
        <GearIcon />
      </a>
    </header>
  );
}

function useFocusCounts(version) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!settings.apiKey) { setData(null); return; }
    let live = true;
    api.focus().then(d => { if (live) setData(d); }).catch(() => {});
    return () => { live = false; };
  }, [version]);
  return data;
}

function MobileTabs({ route, version, campaigns }) {
  const { unreviewed } = useJobs();
  const focus = useFocusCounts(version);
  const todayN = focus?.followups_due?.length || 0;
  const moreN = (focus?.task_queue || []).filter(t => isOverdue(t.due_date)).length;
  const badges = moreBadge({ campaignsOn: campaigns, proposalsN: unreviewed, overdueN: moreN });
  const tabs = tabItems(campaigns);
  return (
    <nav className="tabbar" aria-label="Mobile">
      {tabs.map(t => {
        const on = tabIsOn(t.id, route, campaigns);
        const badge = t.id === 'today'
          ? { n: todayN, label: `${todayN} follow-ups due` }
          : t.id === 'proposals'
            ? badges.proposals
            : t.id === 'more'
              ? badges.more
              : null;
        return (
          <a key={t.id} href={`#/${t.id}`} className={`tabbar-link ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.icon} /></svg>
            <span>{t.label}</span>
            {badge && <TabCount n={badge.n} what={badge.label} />}
          </a>
        );
      })}
    </nav>
  );
}

function TabCount({ n, what }) {
  const text = badgeCount(n);
  if (!text || !what) return null;
  return <span className="tab-badge" aria-label={what}>{text}</span>;
}

function ProposalsBadge() {
  const { jobs, unreviewed } = useJobs();
  const working = jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
  if (!working && !unreviewed) return null;
  return (
    <span className="rail-badges">
      {working > 0 && <span className="rail-working" title={`${working} drafting in the background`} aria-label={`${working} drafting`} />}
      {unreviewed > 0 && <span className="rail-count" aria-label={`${unreviewed} new to review`}>{unreviewed}</span>}
    </span>
  );
}
