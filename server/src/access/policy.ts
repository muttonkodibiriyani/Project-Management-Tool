/** Who may do what (API doc section 2). Every route and every field check asks this file, never its own copy of the rules. */

import { APP_ROLES, type AppRole } from '../auth/roles.js';

/** What a route needs: any member, an editor (any role but Viewer), or one of the listed roles. */
export type Access = 'any' | 'editor' | readonly AppRole[];

/** The caller inside one workspace: their Entra roles and the keys of the teams they belong to there. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  teams: readonly string[];
}

interface AccessSetting {
  roles?: string[];
  teams?: string[];
}
export interface WorkspaceSettings {
  marginAccess?: AccessSetting;
  contactAccess?: AccessSetting;
}

export const MANAGERS: readonly AppRole[] = ['Workspace.Admin', 'Launch.Manager'];
const DEFAULT_MARGIN_ACCESS = { roles: ['Workspace.Admin', 'Launch.Manager', 'Supply'], teams: ['commercial'] };
const DEFAULT_CONTACT_ACCESS = { roles: APP_ROLES.filter(role => role !== 'Viewer'), teams: [] };

export function isAccess(value: unknown): value is Access {
  if (value === 'any' || value === 'editor') return true;
  return Array.isArray(value) && value.length > 0 && value.every(role => (APP_ROLES as readonly unknown[]).includes(role));
}

const known = (role: string): role is AppRole => (APP_ROLES as readonly string[]).includes(role);
export const hasRole = (actor: Pick<Actor, 'roles'>, roles: readonly AppRole[]) => actor.roles.some(role => (roles as readonly string[]).includes(role));
export const isEditor = (actor: Pick<Actor, 'roles'>) => actor.roles.some(role => role !== 'Viewer' && known(role));
export const isManager = (actor: Pick<Actor, 'roles'>) => hasRole(actor, MANAGERS);
export const isAdmin = (actor: Pick<Actor, 'roles'>) => hasRole(actor, ['Workspace.Admin']);

export function allows(access: Access, actor: Pick<Actor, 'roles'>): boolean {
  if (access === 'any') return actor.roles.some(known);
  if (access === 'editor') return isEditor(actor);
  return hasRole(actor, access);
}

function granted(setting: AccessSetting | undefined, fallback: AccessSetting, actor: Actor): boolean {
  const { roles = [], teams = [] } = setting ?? fallback;
  return actor.roles.some(role => roles.includes(role)) || (isEditor(actor) && actor.teams.some(team => teams.includes(team)));
}

export const seesMargins = (settings: WorkspaceSettings, actor: Actor) => granted(settings.marginAccess, DEFAULT_MARGIN_ACCESS, actor);
export const seesContacts = (settings: WorkspaceSettings, actor: Actor) => granted(settings.contactAccess, DEFAULT_CONTACT_ACCESS, actor);

/** A gate field is edited by its owner team, LM and ADM; never by a Viewer, whatever teams they are in. */
export const editsGate = (actor: Actor, ownerTeam: string | null) =>
  isManager(actor) || (isEditor(actor) && ownerTeam !== null && actor.teams.includes(ownerTeam));

/** Non-gate fields of a launch line: LM and ADM on all; BrandTeam on lines they are assigned or whose brand team is theirs. */
export function lineScope(actor: Actor): 'all' | 'own' | 'none' {
  if (isManager(actor)) return 'all';
  return hasRole(actor, ['BrandTeam']) ? 'own' : 'none';
}

export function editsLine(actor: Actor, line: { assigneeId: string | null; brandTeam: unknown }): boolean {
  const scope = lineScope(actor);
  if (scope !== 'own') return scope === 'all';
  return line.assigneeId === actor.userId || (typeof line.brandTeam === 'string' && actor.teams.includes(line.brandTeam));
}

/** Brand, brand × market (non-gate fields) and vendors. */
export const editsBrands = (actor: Actor) => hasRole(actor, ['BrandTeam', 'Supply', ...MANAGERS]);

/** What GET /me tells the screens, so the SPA never re-derives these rules. */
export function permissions(settings: WorkspaceSettings, actor: Actor, gates: { key: string; ownerTeam: string | null }[]) {
  return {
    admin: isAdmin(actor),
    manageLaunches: isManager(actor),
    import: isManager(actor),
    export: isEditor(actor),
    margins: seesMargins(settings, actor),
    contacts: seesContacts(settings, actor),
    comment: isEditor(actor),
    teams: [...actor.teams],
    editableGates: [...new Set(gates.filter(gate => editsGate(actor, gate.ownerTeam)).map(gate => gate.key))],
    editLines: lineScope(actor),
  };
}
