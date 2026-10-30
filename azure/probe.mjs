// Run by deploy.sh inside the Container Apps environment (caj-lt-smoke, node --input-type=module -e),
// where the internal ingress and the hub firewall's rules apply:
//   node --input-type=module -e "$(cat probe.mjs)" <app-url> <tenant-id>
// Checks that sign-in is required and goes to the company tenant, that Entra is reachable through the
// firewall, and that the firewall blocks a site outside the allow-list. Exits 1 if any check fails.
const [base, tenant] = process.argv.slice(1);
const get = url => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
let failed = false;
const report = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
const reason = error => (error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error));

try {
  const me = await get(new URL('/api/v1/me', base));
  report(me.status === 401, `/api/v1/me without a session answers ${me.status} (expected 401)`);
} catch (error) {
  report(false, `/api/v1/me could not be reached (${reason(error)})`);
}

try {
  const login = await get(new URL('/auth/login', base));
  const location = login.headers.get('location') ?? '';
  const tenantPrefix = `https://login.microsoftonline.com/${tenant}/`;
  report(login.status === 302 && location.startsWith(tenantPrefix), `/auth/login answers ${login.status} to ${location.split('?')[0] || 'nowhere'} (expected 302 to ${tenantPrefix})`);
} catch (error) {
  report(false, `/auth/login could not be reached (${reason(error)})`);
}

try {
  const entra = await get(`https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`);
  report(entra.ok, `Entra answers through the hub firewall (${entra.status})`);
} catch (error) {
  report(false, `Entra is not reachable through the hub firewall (${reason(error)}); the allow-list needs login.microsoftonline.com`);
}

try {
  const outside = await get('https://fonts.googleapis.com/');
  report(false, `fonts.googleapis.com answered ${outside.status}: the hub firewall lets through a site that is not on the allow-list`);
} catch {
  report(true, 'the hub firewall blocks fonts.googleapis.com, which is not on the allow-list');
}

process.exitCode = failed ? 1 : 0;
