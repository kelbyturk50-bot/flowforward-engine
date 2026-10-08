import { useCallback, useEffect, useState } from 'react';
import Today from './views/Today';
import Leads from './views/Leads';
import Pipeline from './views/Pipeline';
import Projects from './views/Projects';
import Settings from './views/Settings';
import LeadDrawer from './views/LeadDrawer';
import ProjectDrawer from './views/ProjectDrawer';
import { Toaster } from './ui';
import { settings } from './api';

const ROUTES = [
  { id: 'today',    label: 'Today',    icon: 'M4 12h4l3-8 4 16 3-8h2' },
  { id: 'leads',    label: 'Leads',    icon: 'M4 6h16M4 12h16M4 18h10' },
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
  const openLead = useCallback((id) => { setProjectId(null); setLeadId(id); }, []);
  const openProject = useCallback((id) => { setLeadId(null); setProjectId(id); }, []);
  const shared = { version, bump, openLead, openProject };

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 50 L24 24 L36 38 L44 28 L58 50 Z" fill="currentColor"/><path d="M40 33 L44 28 L49 35 Z" className="brand-peak"/></svg>
          <span>FlowForward</span>
        </div>
        {ROUTES.map(r => (
          <a key={r.id} href={`#/${r.id}`} className={`rail-link ${route === r.id ? 'active' : ''}`} aria-current={route === r.id ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={r.icon} /></svg>
            <span>{r.label}</span>
          </a>
        ))}
      </nav>

      <main id="main" className="main">
        {route === 'today'    && <Today {...shared} />}
        {route === 'leads'    && <Leads {...shared} />}
        {route === 'pipeline' && <Pipeline {...shared} />}
        {route === 'projects' && <Projects {...shared} />}
        {route === 'settings' && <Settings {...shared} authProblem={authProblem} onSaved={() => { setAuthProblem(false); bump(); }} />}
      </main>

      <LeadDrawer id={leadId} onClose={() => setLeadId(null)} {...shared} />
      <ProjectDrawer id={projectId} onClose={() => setProjectId(null)} {...shared} />
      <Toaster />
    </div>
  );
}
