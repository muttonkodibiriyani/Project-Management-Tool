import assert from 'node:assert/strict';
import test from 'node:test';
import { installAuthSession, signIn, signOut } from './auth-session.js';

test('sign-in, 401 and sign-out use only the server-owned auth flow', async () => {
  const events = [];
  let unauthorized;
  let requestMode = 'success';
  installAuthSession({
    assign: url => events.push(['navigate', url]),
    clearOfflineCache: () => events.push(['clear']),
    setUnauthorizedHandler: handler => {
      unauthorized = handler;
    },
    request: async (path, options) => {
      events.push(['request', path, options]);
      if (requestMode === 'unauthorized') {
        unauthorized({ problem: { status: 401 }, returnTo: '/w/qatar?tab=launches#next' });
        throw Object.assign(new Error('Signed out'), { status: 401 });
      }
      return { data: { entraLogoutUrl: 'https://login.microsoftonline.test/logout' }, etag: null, location: null };
    },
  });

  signIn();
  assert.deepEqual(events.shift(), ['navigate', '/auth/login?returnTo=%2F']);

  unauthorized({ problem: { status: 401 }, returnTo: '/w/qatar?tab=tasks#today' });
  assert.deepEqual(events.shift(), ['navigate', '/auth/login?returnTo=%2Fw%2Fqatar%3Ftab%3Dtasks%23today']);

  await signOut();
  assert.deepEqual(events, [['clear'], ['request', '/auth/logout', { method: 'POST' }], ['navigate', 'https://login.microsoftonline.test/logout']]);

  events.length = 0;
  requestMode = 'unauthorized';
  await assert.rejects(signOut(), error => error.status === 401);
  assert.deepEqual(events, [
    ['clear'],
    ['request', '/auth/logout', { method: 'POST' }],
    ['navigate', '/auth/login?returnTo=%2Fw%2Fqatar%3Ftab%3Dlaunches%23next'],
  ]);
});
