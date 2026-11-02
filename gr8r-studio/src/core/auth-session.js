const loginUrl = returnTo => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

let apiRequest;
let clearCache;
let navigate = url => location.assign(url);

/** Installs the API boundary once, before the first session/bootstrap request. */
export function installAuthSession({ request, clearOfflineCache, setUnauthorizedHandler, assign = navigate }) {
  if (apiRequest) throw new Error('The authentication session is already installed.');
  apiRequest = request;
  clearCache = clearOfflineCache;
  navigate = assign;
  setUnauthorizedHandler(({ returnTo }) => navigate(loginUrl(returnTo)));
}

/** Starts the server-owned OIDC flow. The public sign-in screen returns to the app root. */
export function signIn() {
  navigate(loginUrl('/'));
}

/** Clears offline data before asking the server to revoke the HttpOnly session. */
export async function signOut() {
  if (!apiRequest || !clearCache) throw new Error('The authentication session has not been installed.');
  await clearCache();
  const { data } = await apiRequest('/auth/logout', { method: 'POST' });
  if (!data || typeof data.logoutUrl !== 'string' || !data.logoutUrl.trim()) throw new Error('The sign-out response did not include a logout URL.');
  navigate(data.logoutUrl);
}
