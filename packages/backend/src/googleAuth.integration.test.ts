import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { googleAuth } from './routes/googleAuth';
import type { D1Database } from '@cloudflare/workers-types';

let Database: typeof import('node:sqlite').DatabaseSync | undefined;
try {
  Database = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
} catch {
  /* Node 22+ */
}
const signing = generateKeyPair('RS256');
vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  createRemoteJWKSet: () => async () => (await signing).publicKey,
}));

it.skipIf(!Database)(
  'registers, signs in, and links to the password owner once using signed ID tokens',
  async () => {
    const sql = new Database!(':memory:');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
    }
    const prepare = (query: string, args: string[] = []): any => ({
      bind: (...values: string[]) => prepare(query, values),
      first: async () => sql.prepare(query).get(...args) ?? null,
      run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
    });
    const db = {
      prepare,
      batch: async (statements: any[]) => {
        sql.exec('BEGIN');
        try {
          const result = [];
          for (const statement of statements) result.push(await statement.run());
          sql.exec('COMMIT');
          return result;
        } catch (e) {
          sql.exec('ROLLBACK');
          throw e;
        }
      },
    } as unknown as D1Database;
    const origin = 'https://hiroki.example';
    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'fixture',
      GOOGLE_REDIRECT_URI: origin + '/auth/google/callback',
    };
    const request = (path: string, body: unknown, token?: string) =>
      googleAuth.request(
        'https://api.example/' + path,
        {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
          body: JSON.stringify(body),
        },
        env,
      );
    let token = '';
    vi.stubGlobal('fetch', async () => Response.json({ id_token: token }));
    async function exchange(subject: string, wrongNonce = false, session?: string) {
      const start = await request(session ? 'link/start' : 'start', {}, session);
      const { state, browserKey, url } = (await start.json()) as any;
      token = await new SignJWT({ nonce: wrongNonce ? 'incorrect' : new URL(url).searchParams.get('nonce') })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(subject)
        .setIssuer('https://accounts.google.com')
        .setAudience('test-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign((await signing).privateKey);
      const args = { state, browserKey, code: 'fixture' };
      const result = await request('exchange', args);
      expect((await request('exchange', args)).status).toBe(400);
      return result;
    }
    try {
      expect((await exchange('invalid', true)).status).toBe(401);
      const { ticket } = (await (await exchange('new-user')).json()) as any;
      const signup = { ticket, action: 'register', name: 'Runner', age: 25 };
      const registration = await request('finish', signup);
      expect(registration.status).toBe(200);
      const registered = (await registration.json()) as any;
      expect((await request('finish', signup)).status).toBe(400);
      const login = (await (await exchange('new-user')).json()) as any;
      expect(login.profile.userId).toBe(registered.profile.userId);
      expect(login.accessToken).not.toBe(registered.accessToken);

      sql
        .prepare('INSERT INTO users(id,login_id,password_hash,name) VALUES(?,?,?,?)')
        .run('old-id', 'old-user', 'fixture-password', 'Original');
      const finishLink = async (sub: string, password: string) => {
        const pending = (await (await exchange(sub)).json()) as any;
        return request('finish', { action: 'link', ticket: pending.ticket, loginId: 'old-user', password });
      };
      expect((await finishLink('link-me', 'incorrect')).status).toBe(401);
      const linked = await finishLink('link-me', 'fixture-password');
      expect(((await linked.json()) as any).profile.userId).toBe('old-id');
      expect(((await (await exchange('link-me')).json()) as any).profile.userId).toBe('old-id');
      expect((await exchange('link-me', false, registered.accessToken)).status).toBe(409);
      expect((await finishLink('another', 'fixture-password')).status).toBe(409);
    } finally {
      vi.unstubAllGlobals();
      sql.close();
    }
  },
);
