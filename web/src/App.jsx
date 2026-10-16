import { useCallback, useEffect, useState } from 'react';
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
import { api, settings } from './api';
import { JobsProvider, useJobs } from './jobs';
import { badgeCount } from './format';

const ICONS = {
  today: 'M4 12h4l3-8 4 16 3-8h2',
  leads: 'M4 6h16M4 12h16M4 18h10',
  proposals: 'M4 6l8 6 8-6M4 6h16v12H4z',
  pipeline: 'M4 5v14M10 5v10M16 5v6M22 5v3',
  projects: 'M4 7h16v12H4zM9 7V4h6v3',
  more: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
};

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const ROUTES = [
  { id: 'today',    label: 'Today',    icon: ICONS.today },
  { id: 'leads',    label: 'Leads',    icon: ICONS.leads },
  { id: 'proposals', label: 'Proposals', icon: ICONS.proposals },
  { id: 'pipeline', label: 'Pipeline', icon: ICONS.pipeline },
  { id: 'projects', label: 'Projects', icon: ICONS.projects },
  { id: 'settings', label: 'Settings' },
];

const TABS = [
  { id: 'today', label: 'Today', icon: ICONS.today },
  { id: 'leads', label: 'Leads', icon: ICONS.leads },
  { id: 'pipeline', label: 'Pipeline', icon: ICONS.pipeline },
  { id: 'proposals', label: 'Proposals', icon: ICONS.proposals },
  { id: 'more', label: 'More', icon: ICONS.more },
];

const KNOWN = new Set([...ROUTES.map(r => r.id), 'more']);

const readRoute = () => {
  const r = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  if (KNOWN.has(r)) return r;
  return settings.apiKey ? 'today' : 'settings';
};

const tabOn = (id, route) => id === 'more' ? route === 'more' || route === 'projects' : route === id;

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
        {ROUTES.map(r => (
          <a key={r.id} href={`#/${r.id}`} className={`rail-link ${route === r.id ? 'active' : ''}`} aria-current={route === r.id ? 'page' : undefined}>
            {r.id === 'settings' ? <GearIcon /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d={r.icon} /></svg>}
            <span>{r.label}</span>
            {r.id === 'proposals' && <ProposalsBadge />}
          </a>
        ))}
      </nav>
      <MobileTabs route={route} version={version} />

      <main id="main" className="main">
        {route === 'today'    && <Today {...shared} />}
        {route === 'leads'    && <Leads {...shared} />}
        {route === 'proposals' && <Proposals {...shared} />}
        {route === 'pipeline' && <Pipeline {...shared} />}
        {route === 'projects' && <Projects {...shared} />}
        {route === 'more'     && <More />}
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

function MobileTabs({ route, version }) {
  const { unreviewed } = useJobs();
  const focus = useFocusCounts(version);
  const todayN = focus?.followups_due?.length || 0;
  const moreN = (focus?.task_queue || []).filter(t => isOverdue(t.due_date)).length;
  const counts = { today: todayN, proposals: unreviewed, more: moreN };
  const labels = { today: 'follow-ups due', proposals: 'proposals to review', more: 'overdue project tasks' };
  return (
    <nav className="tabbar" aria-label="Mobile">
      {TABS.map(t => {
        const on = tabOn(t.id, route);
        return (
          <a key={t.id} href={`#/${t.id}`} className={`tabbar-link ${on ? 'active' : ''}`} aria-current={on ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={t.icon} /></svg>
            <span>{t.label}</span>
            {counts[t.id] != null && <TabCount n={counts[t.id]} what={labels[t.id]} />}
          </a>
        );
      })}
    </nav>
  );
}

function TabCount({ n, what }) {
  const text = badgeCount(n);
  if (!text) return null;
  return <span className="tab-badge" aria-label={`${n} ${what}`}>{text}</span>;
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
