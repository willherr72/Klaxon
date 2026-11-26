export const routeLabels = {
  today: 'Today',
  inbox: 'Inbox',
  upcoming: 'Upcoming',
  calendar: 'Calendar',
  projects: 'Projects',
  waiting: 'Waiting',
  capture: 'Capture',
  activity: 'Activity',
  settings: 'Settings',
} as const;

export type PlannerRoute = keyof typeof routeLabels;

export interface PlannerDestination {
  id: PlannerRoute;
  href: string;
}
