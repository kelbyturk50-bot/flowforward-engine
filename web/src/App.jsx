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
import { Toaster } from './ui';
import { settings } from './api';
import { JobsProvider, useJobs } from './jobs';

const ROUTES = [
  { id: 'today',    label: 'Today',    icon: 'M4 12h4l3-8 4 16 3-8h2' },
  { id: 'leads',    label: 'Leads',    icon: 'M4 6h16M4 12h16M4 18h10' },
  { id: 'proposals', label: 'Proposals', icon: 'M4 6l8 6 8-6M4 6h16v12H4z' },
  { id: 'pipeline', label: 'Pipeline', icon: 'M4 5v14M10 5v10M16 5v6M22 5v3' },
  { id: 'projects', label: 'Projects', icon: 'M4 7h16v12H4zM9 7V4h6v3' },
  { id: 'settings', label: 'Settings', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3' },
];

const readRoute = () => {
  const r = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.some(x => x.id === r) ? r : (settings.apiKey ? 'today' : 'settings');
};

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
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M2 44 L20 16 L30 30 L42 12 L62 44 Z" className="brand-peaks"/><path d="M29 30 C24 36 22 42 30 46 C38 50 50 50 62 52 L62 58 C48 58 34 58 25 52 C17 47 21 37 29 30 Z" className="brand-river"/></svg>
          <span>Flow<span className="brand-forward">Forward</span></span>
        </div>
        {ROUTES.map(r => (
          <a key={r.id} href={`#/${r.id}`} className={`rail-link ${route === r.id ? 'active' : ''}`} aria-current={route === r.id ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={r.icon} /></svg>
            <span>{r.label}</span>
            {r.id === 'proposals' && <ProposalsBadge />}
          </a>
        ))}
      </nav>

      <main id="main" className="main">
        {route === 'today'    && <Today {...shared} />}
        {route === 'leads'    && <Leads {...shared} />}
        {route === 'proposals' && <Proposals {...shared} />}
        {route === 'pipeline' && <Pipeline {...shared} />}
        {route === 'projects' && <Projects {...shared} />}
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
