import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import { signupSchema } from '@my-app/shared';
import { firebaseAuth } from '../middleware/auth';
import { issueSession, tokenHash, verifyPassword } from '../services/authSession';
import { issueUniformAdminSession } from '../services/uniformAdminSession';
import { setCookie } from 'hono/cookie';

export type GoogleBindings = {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_WEB_COOKIE?: string;
};
type Env = { Bindings: GoogleBindings; Variables: { firebaseUser: { sub: string } } };
const issuer = 'https://accounts.google.com';
const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const secret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const expires = () => Date.now() + 10 * 60_000;
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
const callback = z.object({ state: opaque, browserKey: opaque, code: z.string().min(1).max(8192) });
const completion = z.discriminatedUnion('action', [
  signupSchema.pick({ name: true, age: true }).extend({ action: z.literal('register'), ticket: opaque }),
  z.object({
    action: z.literal('link'),
    ticket: opaque,
    loginId: z.string().min(1).max(256),
    password: z.string().min(1).max(4096),
  }),
]);
type RequestRow = { verifier: string; nonce: string; link_user: string | null };
type Pending = { subject: string; link_user: string | null };

async function start(c: Context<Env>, linkUser: string | null) {
  const state = secret(),
    browserKey = secret(),
    verifier = secret(),
    nonce = secret();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const db = c.env.DB;
  await db.batch([
    db.prepare('DELETE FROM google_auth_requests WHERE expires_at<=?').bind(Date.now()),
    db.prepare('DELETE FROM google_auth_pending WHERE expires_at<=?').bind(Date.now()),
    db
      .prepare(
        'INSERT INTO google_auth_requests(state,browser_hash,verifier,nonce,link_user,expires_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(state, await tokenHash(browserKey), verifier, nonce, linkUser, expires()),
  ]);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: c.env.GOOGLE_REDIRECT_URI!,
    response_type: 'code',
    scope: 'openid',
    prompt: 'select_account',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return c.json({ url: url.href, state, browserKey });
}

async function signedIn(c: Context<Env>, userId: string) {
  const db = c.env.DB;
  const profile = await db
    .prepare(
      `
    SELECT u.id AS userId, u.name, u.login_id, u.avatar_id, u.avatar_image, u.role,
           u.territory_map_visibility, u.current_weight, u.target_weight, u.target_calories_burned,
           u.target_calories_consumed, u.gender, u.age, u.height, u.level, u.xp, u.status_points,
           u.stat_str, u.stat_agi, u.stat_def, u.stat_vit, u.team_id, t.name AS team_name
    FROM users u LEFT JOIN teams t ON t.id = u.team_id
    WHERE u.id = ?
  `,
    )
    .bind(userId)
    .first<{ userId: string; role: string; name: string }>();
  if (!profile) return c.json({ error: 'アカウントが見つかりません。' }, 404);
  const token = await issueSession(db, userId);
  const cookie = c.env.GOOGLE_WEB_COOKIE === 'true';
  if (cookie)
    setCookie(c, '__Host-pp_session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 14 * 86400,
    });
  const uniformAdminToken = profile.role === 'admin' ? await issueUniformAdminSession(db, userId) : undefined;
  return c.json({ profile, accessToken: cookie ? null : token, uniformAdminToken });
}

export const googleAuth = new Hono<Env>()
  .use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REDIRECT_URI)
      return c.json({ error: 'この環境ではGoogleログインが設定されていません。' }, 503);
    // All OAuth API calls come from the configured frontend; Google's redirect lands on that frontend.
    if (c.req.header('Origin') !== new URL(c.env.GOOGLE_REDIRECT_URI).origin)
      return c.json({ error: 'ログイン画面からもう一度操作してください。' }, 403);
    await next();
  })
  .post('/start', (c) => start(c, null))
  .post('/link/start', firebaseAuth, (c) => start(c, c.get('firebaseUser').sub))
  .post('/exchange', zValidator('json', callback), async (c) => {
    const { state, browserKey, code } = c.req.valid('json');
    const db = c.env.DB;
    const flow = await db
      .prepare(
        'DELETE FROM google_auth_requests WHERE state=? AND browser_hash=? AND expires_at>? RETURNING verifier,nonce,link_user',
      )
      .bind(state, await tokenHash(browserKey), Date.now())
      .first<RequestRow>();
    if (!flow) return c.json({ error: '認証の有効期限が切れました。最初からやり直してください。' }, 400);
    let subject: string;
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          code,
          code_verifier: flow.verifier,
          grant_type: 'authorization_code',
          redirect_uri: c.env.GOOGLE_REDIRECT_URI!,
          client_id: c.env.GOOGLE_CLIENT_ID!,
          client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        }),
      });
      if (!response.ok) throw new Error();
      const { id_token } = (await response.json()) as { id_token: string };
      const { payload } = await jwtVerify(id_token, keys, {
        algorithms: ['RS256'],
        issuer: [issuer, 'accounts.google.com'],
        audience: c.env.GOOGLE_CLIENT_ID!,
        requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
      });
      if (
        payload.nonce !== flow.nonce ||
        !payload.sub ||
        (payload.azp !== undefined && payload.azp !== c.env.GOOGLE_CLIENT_ID)
      )
        throw new Error();
      subject = payload.sub;
    } catch {
      return c.json({ error: 'Googleでの本人確認を完了できませんでした。再度お試しください。' }, 401);
    }
    const identity = await db
      .prepare('SELECT user_id FROM auth_identities WHERE issuer=? AND subject=?')
      .bind(issuer, subject)
      .first<{ user_id: string }>();
    if (identity) {
      if (flow.link_user && flow.link_user !== identity.user_id)
        return c.json({ error: 'このGoogleアカウントは別のユーザーに連携されています。' }, 409);
      return signedIn(c, identity.user_id);
    }
    const ticket = secret();
    await db
      .prepare('INSERT INTO google_auth_pending(ticket_hash,subject,link_user,expires_at) VALUES(?,?,?,?)')
      .bind(await tokenHash(ticket), subject, flow.link_user, expires())
      .run();
    return c.json({ ticket, linkOnly: !!flow.link_user });
  })
  .post('/finish', zValidator('json', completion), async (c) => {
    const data = c.req.valid('json'),
      db = c.env.DB;
    const key = await tokenHash(data.ticket);
    // A ticket authorizes exactly one registration or password confirmation attempt.
    const pending = await db
      .prepare(
        'DELETE FROM google_auth_pending WHERE ticket_hash=? AND expires_at>? RETURNING subject,link_user',
      )
      .bind(key, Date.now())
      .first<Pending>();
    if (!pending)
      return c.json({ error: '確認の有効期限が切れました。もう一度Googleで続けてください。' }, 400);
    let userId: string;
    try {
      if (data.action === 'register') {
        if (pending.link_user) return c.json({ error: '既存アカウントで確認してください。' }, 400);
        userId = crypto.randomUUID();
        await db.batch([
          db
            .prepare('INSERT INTO users(id,login_id,name,age) VALUES(?,?,?,?)')
            .bind(userId, 'google-' + userId, data.name, data.age),
          db
            .prepare('INSERT INTO auth_identities(issuer,subject,user_id) VALUES(?,?,?)')
            .bind(issuer, pending.subject, userId),
        ]);
      } else {
        const user = await db
          .prepare('SELECT id,password_hash FROM users WHERE login_id=?')
          .bind(data.loginId)
          .first<{ id: string; password_hash: string | null }>();
        if (
          !user?.password_hash ||
          (pending.link_user && pending.link_user !== user.id) ||
          !(await verifyPassword(data.password, user.password_hash))
        )
          return c.json(
            { error: 'ログインIDまたはパスワードを確認し、Google認証からやり直してください。' },
            401,
          );
        userId = user.id;
        const result = await db
          .prepare(
            'INSERT INTO auth_identities(issuer,subject,user_id) SELECT ?,?,id FROM users WHERE id=? AND password_hash=?',
          )
          .bind(issuer, pending.subject, userId, user.password_hash)
          .run();
        if (!result.meta.changes)
          return c.json({ error: '認証情報が変更されました。再度ログインしてください。' }, 409);
      }
    } catch (err) {
      if (String(err).includes('UNIQUE'))
        return c.json({ error: 'すでに連携されています。Googleログインから再度お試しください。' }, 409);
      throw err;
    }
    return signedIn(c, userId);
  });
