// Campaigns navigation. With FF_CAMPAIGNS off, the rail and phone tabs stay
// as they are on main (Inbox from #75 included). With it on, Campaigns sits
// between Pipeline and Proposals on the rail, and the phone tabs are Today,
// Leads, Pipeline, Campaigns, More (Proposals moves under More with Inbox).

export const ICONS = {
  today: 'M4 12h4l3-8 4 16 3-8h2',
  leads: 'M4 6h16M4 12h16M4 18h10',
  proposals: 'M4 6l8 6 8-6M4 6h16v12H4z',
  inbox: 'M3 13h5l2 3h4l2-3h5M5.5 5h13L21 13v6H3v-6z',
  pipeline: 'M4 5v14M10 5v10M16 5v6M22 5v3',
  campaigns: 'M5 4v16M5 5h9l-2 3.5L14 12H5',
  projects: 'M4 7h16v12H4zM9 7V4h6v3',
  more: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
};

const today = { id: 'today', label: 'Today', icon: ICONS.today };
const leads = { id: 'leads', label: 'Leads', icon: ICONS.leads };
const proposals = { id: 'proposals', label: 'Proposals', icon: ICONS.proposals };
const inbox = { id: 'inbox', label: 'Inbox', icon: ICONS.inbox };
const pipeline = { id: 'pipeline', label: 'Pipeline', icon: ICONS.pipeline };
const campaigns = { id: 'campaigns', label: 'Campaigns', icon: ICONS.campaigns };
const projects = { id: 'projects', label: 'Projects', icon: ICONS.projects };
const settings = { id: 'settings', label: 'Settings' };
const more = { id: 'more', label: 'More', icon: ICONS.more };

export function railItems(campaignsOn) {
  if (!campaignsOn) return [today, leads, proposals, inbox, pipeline, projects, settings];
  return [today, leads, pipeline, campaigns, proposals, inbox, projects, settings];
}

export function tabItems(campaignsOn) {
  if (!campaignsOn) return [today, leads, pipeline, proposals, more];
  return [today, leads, pipeline, campaigns, more];
}

export function tabIsOn(id, route, campaignsOn) {
  if (id === 'more') {
    if (route === 'more' || route === 'projects' || route === 'inbox') return true;
    return Boolean(campaignsOn && route === 'proposals');
  }
  return route === id;
}

export function moreItems(campaignsOn) {
  const inboxItem = { id: 'inbox', label: 'Inbox', hint: 'Replies from leads, with drafted responses', icon: ICONS.inbox };
  const projectsItem = { id: 'projects', label: 'Projects', hint: 'Client builds and your own work', icon: ICONS.projects };
  if (!campaignsOn) return [inboxItem, projectsItem];
  return [
    { id: 'proposals', label: 'Proposals', hint: 'Drafts to review', icon: ICONS.proposals },
    inboxItem,
    projectsItem,
  ];
}

const KNOWN = new Set(['today', 'leads', 'proposals', 'inbox', 'pipeline', 'projects', 'settings', 'more']);

export function resolveRoute(hash, { campaigns = false, hasKey = true } = {}) {
  const id = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  if (id === 'campaigns' || id.startsWith('campaigns/')) {
    return campaigns && id === 'campaigns' ? 'campaigns' : 'not-found';
  }
  if (KNOWN.has(id)) return id;
  return hasKey ? 'today' : 'settings';
}

export function moreBadge({ campaignsOn, proposalsN = 0, overdueN = 0, inboxN = 0 }) {
  const proposals = Math.max(0, Number(proposalsN) || 0);
  const overdue = Math.max(0, Number(overdueN) || 0);
  const replies = Math.max(0, Number(inboxN) || 0);
  if (!campaignsOn) {
    return {
      proposals: { n: proposals, label: `${proposals} proposals to review` },
      more: {
        n: overdue + replies,
        label: `${overdue + replies} ${replies ? 'replies and overdue tasks' : 'overdue project tasks'}`,
      },
    };
  }
  const parts = [];
  if (proposals) parts.push(`${proposals} proposals to review`);
  if (replies) parts.push(`${replies} replies waiting`);
  if (overdue) parts.push(`${overdue} overdue project tasks`);
  return {
    proposals: null,
    more: { n: proposals + replies + overdue, label: parts.join(', ') },
  };
}
