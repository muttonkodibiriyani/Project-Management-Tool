import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the sign-in screen offers only the server-owned Microsoft work-account flow', async () => {
  const source = await readFile(new URL('./auth.js', import.meta.url), 'utf8');
  const signInSource = source.slice(0, source.indexOf('/* ---------------- ONBOARDING ---------------- */'));

  assert.match(signInSource, /data-a="signIn"/);
  assert.match(signInSource, /Continue with Microsoft/);
  assert.match(signInSource, /company Microsoft account/);
  assert.match(signInSource, /never receives or stores your password/);
  assert.doesNotMatch(signInSource, /<input|type="password"|Google|Apple|Sign up|Forgot password/i);

  const settingsSource = await readFile(new URL('./settings.js', import.meta.url), 'utf8');
  assert.match(settingsSource, /Microsoft Entra ID manages sign-in security/);
  assert.doesNotMatch(settingsSource, /type="password"|savePassword|setup2fa|verify2fa|disable2fa/);
});
