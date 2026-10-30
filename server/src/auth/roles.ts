/**
 * The Entra app roles, from the API contract section 2. They arrive in the ID token's `roles` claim
 * at every sign-in and are stored as `app_user.app_roles`; what each allows is the API's access
 * policy. Teams with `team.app_role` set get their Entra members from these.
 */
export const APP_ROLES = ['Workspace.Admin', 'Launch.Manager', 'BrandTeam', 'Supply', 'VM', 'Comms', 'Viewer'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Keeps the claim's known roles, once each, in a fixed order; anything else in the claim is ignored. */
export function knownRoles(claim: unknown): AppRole[] {
  const values = Array.isArray(claim) ? claim : [];
  return APP_ROLES.filter(role => values.includes(role));
}
