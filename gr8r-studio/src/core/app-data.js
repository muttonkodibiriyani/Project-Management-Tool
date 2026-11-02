/* ---------- store installation seam (called after auth-session installation) ---------- */

import { request, workspacePath } from './api.js';
import { registerSync, replaceStoreData, S } from './store.js';
import { startSync } from './sync.js';

/**
 * Start authenticated data loading after installAuthSession has registered the 401 handler.
 * Auth owns navigation; this module owns only workspace state, cache and connectivity flags.
 */
export async function installDataSync({ render = () => {}, preferredWorkspace, onConflict = () => {}, storage } = {}) {
  const session = await startSync({
    request,
    workspacePath,
    storage,
    preferredWorkspace,
    onData(data, prefs) {
      const { authorized, ...workspaceData } = data;
      replaceStoreData(workspaceData, prefs);
      S.authorized.launchDirectory = authorized?.launchDirectory || null;
      S.ui.loading = false;
      render();
    },
    onStatus(status) {
      S.ui.offline = Boolean(status.offline);
      S.ui.loading = Boolean(status.syncing);
      render();
    },
    onConflict,
  });
  registerSync(session.queueSnapshot);
  return session;
}
