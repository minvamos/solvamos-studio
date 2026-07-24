import type { AppTab } from '../AppShell';

const TAB_PATHS: Record<AppTab, string> = {
  studio: '/studio',
  list: '/agents',
  lab: '/lab',
  settlements: '/settlements',
  account: '/account',
};

export type AppRoute = {
  tab: AppTab | null;
  agentId: string | null;
};

export function parseAppRoute(location: Location = window.location): AppRoute {
  const tab =
    (Object.entries(TAB_PATHS).find(([, path]) => path === location.pathname)?.[0] as
      | AppTab
      | undefined) || null;
  return {
    tab,
    agentId: new URLSearchParams(location.search).get('agent'),
  };
}

export function writeAppRoute(
  tab: AppTab,
  options?: { replace?: boolean; agentId?: string | null }
) {
  const query = new URLSearchParams();
  if (options?.agentId) query.set('agent', options.agentId);
  const suffix = query.size ? `?${query.toString()}` : '';
  const url = `${TAB_PATHS[tab]}${suffix}`;
  const state = { solvamos: true, view: 'studio', tab, agentId: options?.agentId || null };
  if (!options?.replace && `${window.location.pathname}${window.location.search}` === url) {
    window.history.replaceState(state, '', url);
    return;
  }
  if (options?.replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}

export function writeLandingRoute(options?: { replace?: boolean }) {
  const state = { solvamos: true, view: 'landing' };
  if (options?.replace) window.history.replaceState(state, '', '/');
  else window.history.pushState(state, '', '/');
}

