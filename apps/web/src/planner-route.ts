import type { PlannerDestination } from './planner-shell/routes';

const today = { id: 'today', href: '#/today', kind: 'overview' } as const;
const inbox = { id: 'inbox', href: '#/inbox', kind: 'page' } as const;
export const destinations = [
  today,
  inbox,
  { id: 'upcoming', href: '#/upcoming', kind: 'overview' },
  { id: 'projects', href: '#/projects', kind: 'page' },
  { id: 'calendar', href: '#/calendar', kind: 'page' },
  { id: 'waiting', href: '#/waiting', kind: 'overview' },
  { id: 'capture', href: '#/capture', kind: 'page' },
  { id: 'activity', href: '#/activity', kind: 'page' },
] as const satisfies readonly (PlannerDestination & { kind: 'page' | 'overview' })[];

type Destination = typeof destinations[number];
export type Route = { view: Destination; publicId?: string };

export function taskHref(publicId: string) {
  return `#/tasks/${encodeURIComponent(publicId)}`;
}

export function readRoute(hash: string, taskView?: Destination['id']): Route {
  const destination = destinations.find(item => item.href === hash);
  if (destination) return { view: destination };

  const match = /^#\/tasks\/([^/]+)$/.exec(hash);
  if (match) {
    try {
      return { view: destinations.find(item => item.id === taskView) ?? inbox, publicId: decodeURIComponent(match[1]) };
    } catch {
      // Invalid percent encoding falls back to Today.
    }
  }
  return { view: today };
}

export function routeHref(route: Route) {
  return route.publicId === undefined ? route.view.href : taskHref(route.publicId);
}
