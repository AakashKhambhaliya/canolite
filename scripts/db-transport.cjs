// Shared by the runtime, maintenance CLI, and pg_dump. node-postgres parses
// connectionString *after* explicit options, so never leave competing TLS or
// host options in the URL. Never log the returned credential-bearing URLs.
const { readFileSync } = require('node:fs');
const { checkServerIdentity } = require('node:tls');
function databaseTransport(raw, env = process.env) {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid PostgreSQL URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost','127.0.0.1','::1'].includes(host);
  const mode = (env.DB_SSL || 'auto').toLowerCase();
  if (!['auto','require','verify-full','true','1','disable','false','0'].includes(mode)) throw new Error('Unknown DB_SSL mode');
  const urlMode = url.searchParams.get('sslmode');
  const caFile = env.DB_SSL_CA_FILE || url.searchParams.get('sslrootcert');
  for (const key of [...url.searchParams.keys()]) {
    if (['sslmode','sslrootcert'].includes(key)) url.searchParams.delete(key);
    else if (/^(ssl|host|service|uselibpqcompat)/i.test(key)) throw new Error('Use DB_SSL / DB_SSL_CA_FILE for database transport options');
  }
  const disabled = ['disable','false','0'].includes(mode) || (mode === 'auto' && local && (!urlMode || urlMode === 'disable'));
  if (urlMode && !['require','verify-full','verify-ca', ...(disabled ? ['disable'] : [])].includes(urlMode)) throw new Error('Unsafe PostgreSQL sslmode; configure DB_SSL explicitly');
  const connectionString = url.toString();
  url.searchParams.set('sslmode', disabled ? 'disable' : 'verify-full');
  if (!disabled && caFile) url.searchParams.set('sslrootcert', caFile);
  return { connectionString, libpqUrl: url.toString(), ssl: disabled ? false : {
    rejectUnauthorized: true, checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
    ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {})
  } };
}
module.exports = { databaseTransport };
