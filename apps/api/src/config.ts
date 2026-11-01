export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  /** The one HTTPS address the app is opened at. Empty in local development. */
  publicUrl: string;
  port: number;
  host: string;
  webDist: string | null;
  tz: string;
  /** Login attempts allowed per IP per 15 minutes. */
  loginLimit: number;
  /** Addresses whose X-Forwarded-For is believed (TRUST_PROXY, comma-separated). Off by default. */
  trustProxy: string[] | false;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL || '';
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32 && env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be at least 32 characters (use openssl rand -hex 32).');
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (publicUrl) new URL(publicUrl); // throws on a typo
  return {
    databaseUrl,
    sessionSecret: sessionSecret || 'dev-only-secret-dev-only-secret-dev-only',
    publicUrl,
    port: Number(env.PORT) || 8080,
    host: env.HOST || '0.0.0.0',
    webDist: env.WEB_DIST || null,
    tz: env.TZ || 'America/Chicago',
    loginLimit: Number(env.LOGIN_LIMIT) || 10,
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY.split(',').map(x => x.trim()).filter(Boolean) : false
  };
}
