import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createStudioUniform, type ChestResult, type SaveChestReward } from '@my-app/shared';
import app from './index';
import { issueSession } from './services/authSession';
import { chestTierForTrace } from './services/mapChestGeometry';
import { chestWeekEnd } from './services/mapChests';
import { chestCandidates } from './data/chestCandidates';
import { prefectureBoundaries } from './data/prefectureBoundaries';
import { withinPrefecture } from './services/prefectureSpots';

let DatabaseSync: typeof import('node:sqlite').DatabaseSync | undefined;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { /* Node versions before 22 lack built-in SQLite. */ }
const sqlSuite = DatabaseSync ? describe : describe.skip;

const center = { latitude: 35.68, longitude: 139.75 };
function loop(radius: number) {
  const rows = Array.from({ length: 25 }, (_, index) => {
    const angle = index * Math.PI / 12;
    return { latitude: center.latitude + Math.sin(angle) * radius / 111195,
      longitude: center.longitude + Math.cos(angle) * radius / 90300, captured_at: index * 10000 };
  });
  rows[24] = { ...rows[0], captured_at: 240000 };
  return rows;
}

it('uses Japanese Monday midnight and rejects open, disjoint, repeated and edge-grazing loops', () => {
  const monday = Date.parse('2026-11-15T15:00:00Z');
  expect(chestWeekEnd(monday - 1)).toBe(monday);
  expect(chestWeekEnd(monday)).toBe(monday + 7 * 86400000);
  const small = loop(40);
  expect(chestTierForTrace(small, center)).toBe('small');
  expect(chestTierForTrace(loop(85), center)).toBe('medium');
  expect(chestTierForTrace(loop(130), center)).toBe('large');
  expect(chestTierForTrace(small.slice(0, 17), center)).toBeNull();
  expect(chestTierForTrace(small, { ...center, latitude: center.latitude + .0003 })).toBeNull();
  expect(chestTierForTrace([...small, ...small.slice(1).map(row => ({ ...row, captured_at: row.captured_at + 240000 }))], center)).toBeNull();
  const interrupted = small.map(row => row.captured_at >= 120000 ? { ...row, captured_at: row.captured_at + 45000 } : row);
  expect(chestTierForTrace(interrupted, center)).toBeNull();
});

it('ships real OSM walking-way IDs and coordinates inside all 47 prefectures', () => {
  expect(Object.keys(chestCandidates).sort()).toEqual(prefectureBoundaries.map(region => region.code).sort());
  for (const region of prefectureBoundaries) {
    const candidates = chestCandidates[region.code];
    expect(candidates.length, region.code).toBeGreaterThan(0);
    expect(candidates.every(([lat, lng, osmWayId]) =>
      Number.isSafeInteger(osmWayId) && osmWayId > 0 && withinPrefecture(region, lat, lng)), region.code).toBe(true);
  }
});

sqlSuite('shared chest placement and private rewards on real SQL', () => {
  let sqlite: import('node:sqlite').DatabaseSync, db: D1Database, clock: number;
  const users = [randomUUID(), randomUUID()];
  let tokens: string[];
  const initialClock = Date.now();
  const expires = chestWeekEnd(initialClock + 3600000);
  const sql = (query: string, ...args: any[]) => sqlite.prepare(query).run(...args);
  const one = (query: string, ...args: any[]) => sqlite.prepare(query).get(...args);
  const stmt = (query: string, args: any[] = []): any => ({
    bind: (...values: any[]) => stmt(query, values),
    first: async () => one(query, ...args) ?? null,
    all: async () => ({ results: sqlite.prepare(query).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql(query, ...args).changes) } }),
  });
  function request(path: string, method = 'GET', body?: unknown, user = 0) {
    return app.request('/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...(user >= 0 ? { Authorization: 'Bearer ' + tokens[user] } : {}) } }, { DB: db } as any);
  }
  function addChest(prefecture = 'JP-13', end = expires) {
    const id = randomUUID();
    sql('INSERT OR IGNORE INTO map_chest_weeks(prefecture_code, expires_at, ready) VALUES(?,?,1)', prefecture, end);
    sql('INSERT INTO map_chests VALUES(?,?,?,?,?)', id, prefecture, end, center.latitude, center.longitude);
    return id;
  }
  async function start(chestId: string, user: number) {
    const response = await request('/running/sessions', 'POST', { activity_mode: 'personal', chest_id: chestId }, user);
    expect(response.status).toBe(201);
    return (await response.json() as { session_id: string }).session_id;
  }
  async function finish(id: string, user: number) {
    const response = await request(`/running/sessions/${id}/complete`, 'POST', { distance_m: 650, duration_sec: 240 }, user);
    expect(response.status).toBe(200);
    return (await response.json() as { chest: ChestResult | null }).chest;
  }
  async function sendTrace(session: string, user: number, points = loop(85), startSequence = 0) {
    for (const [index, p] of points.entries()) {
      clock += 10000;
      const response = await request(`/running/sessions/${session}/telemetry`, 'POST', {
        sequence: startSequence + index, recorded_at_ms: clock, source: 'unavailable', steps: null,
        fix: { latitude: p.latitude, longitude: p.longitude, accuracy_m: 6, captured_at_ms: clock, mocked: false },
      }, user);
      expect(response.status).toBe(200);
    }
  }
  beforeEach(async () => {
    sqlite = new DatabaseSync!(':memory:');
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
    }
    let pending: Promise<unknown> = Promise.resolve();
    db = { prepare: stmt, batch: (statements: any[]) => {
      const transaction = pending.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      pending = transaction.catch(() => {});
      return transaction;
    } } as unknown as D1Database;
    for (const id of users) sql('INSERT INTO users(id,login_id,password_hash,name) VALUES(?,?,?,?)', id, id, 'fixture', 'Fixture');
    tokens = await Promise.all(users.map(id => issueSession(db, id)));
    clock = expires - 6000000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  it('previews only the owner’s live closed loop and awards the same tier on completion', async () => {
    const target = addChest();
    const run = await start(target, 0);
    const path = `/map-chests/sessions/${run}/preview`;
    const preview = async (user = 0) => {
      const response = await request(path, 'GET', undefined, user);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return response.json();
    };
    const points = loop(85);
    await sendTrace(run, 0, points.slice(0, 22));
    expect(await preview()).toEqual({ preview: null });
    await sendTrace(run, 0, points.slice(22), 22);
    expect(await preview()).toEqual({ preview: { tier: 'medium', valid_for_ms: 15000 } });
    expect(await preview(1)).toEqual({ preview: null });
    expect((await request(path, 'GET', undefined, -1)).status).toBe(401);
    expect(one('SELECT COUNT(*) n FROM map_chest_claims')?.n).toBe(0);
    expect(await finish(run, 0)).toMatchObject({ tier: 'medium' });
    expect(await preview()).toEqual({ preview: null });
  });

  it('withdraws the preview when the fix gets stale, the runner leaves the loop, or the chest expires', async () => {
    const run = await start(addChest(), 0);
    const path = `/map-chests/sessions/${run}/preview`;
    const preview = async (pathToPreview = path, user = 0) => (await request(pathToPreview, 'GET', undefined, user)).json();
    const points = loop(85);
    await sendTrace(run, 0, points);
    clock += 15000;
    expect(await preview()).toEqual({ preview: null });
    await sendTrace(run, 0, [points[24]], 25);
    expect(await preview()).toMatchObject({ preview: { tier: 'medium' } });
    await sendTrace(run, 0, [{ ...points[24], longitude: points[24].longitude + 0.0004 }], 26);
    expect(await preview()).toEqual({ preview: null });

    clock = expires - 255000;
    const otherRun = await start(addChest(), 1);
    await sendTrace(otherRun, 1, loop(130));
    const expiring = `/map-chests/sessions/${otherRun}/preview`;
    expect(await preview(expiring, 1)).toEqual({ preview: { tier: 'large', valid_for_ms: 5000 } });
    clock += 5000;
    expect(await preview(expiring, 1)).toEqual({ preview: null });
  });

  it('publishes one saved prefecture draw and permits each account to claim it independently', async () => {
    const target = addChest();
    addChest('JP-14');
    const nearby = async (user: number) => {
      const response = await request('/map-chests/nearby', 'POST', center, user);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      return await response.json() as { chests: Array<{ id: string; claimed: boolean }> };
    };
    expect((await nearby(0)).chests).toMatchObject([{ id: target, claimed: false }]);
    const run = await start(target, 0);
    await sendTrace(run, 0);
    const prize = await finish(run, 0);
    expect(prize).toMatchObject({ tier: 'medium', reward_id: expect.stringMatching(/^chest-/) });
    expect(await finish(run, 0)).toEqual(prize);
    expect(one('SELECT COUNT(*) n FROM running_chest_points')?.n).toBe(0);
    expect((await nearby(0)).chests).toMatchObject([{ id: target, claimed: true }]);
    expect((await nearby(1)).chests).toMatchObject([{ id: target, claimed: false }]);
    expect((await request('/running/sessions', 'POST', { activity_mode: 'personal', chest_id: target })).status).toBe(409);

    const design = createStudioUniform();
    if (prize?.reward_id === 'chest-compass') design.emblem = prize.reward_id;
    else design.front_pattern = 'chest-switchback';
    expect((await request('/uniforms/personal', 'PUT', { design, revision: 0 }, 1)).status).toBe(400);
    expect((await request('/uniforms/personal', 'PUT', { design, revision: 0 }, 0)).status).toBe(200);
    const otherRun = await start(target, 1);
    await sendTrace(otherRun, 1);
    expect(await finish(otherRun, 1)).toMatchObject({ tier: 'medium' });
    expect(one('SELECT COUNT(*) n FROM map_chest_claims')?.n).toBe(2);
    expect(one('SELECT COUNT(*) n FROM running_place_passages')?.n).toBe(0);
    expect((await request('/map-chests/rewards', 'GET', undefined, -1)).status).toBe(401);
  });

  it('recovers a failed lease and an empty week without fetching from any map provider', async () => {
    sql('INSERT INTO map_chest_weeks(prefecture_code, expires_at, ready, retry_at) VALUES(?,?,0,?)',
      'JP-13', expires, clock + 120000);
    sql('INSERT INTO map_chest_weeks(prefecture_code, expires_at, ready) VALUES(?,?,1)', 'JP-14', expires);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No map provider connectivity'));
    const [first, second] = await Promise.all([
      request('/map-chests/nearby', 'POST', center),
      request('/map-chests/nearby', 'POST', center, 1),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const draw = await first.json() as { chests: Array<{ latitude: number; longitude: number }> };
    expect(draw.chests.length).toBeGreaterThan(0);
    expect(draw.chests.every(chest => chestCandidates['JP-13'].some(([lat, lng]) =>
      lat === chest.latitude && lng === chest.longitude))).toBe(true);
    expect(await second.json()).toEqual(draw);
    expect(one('SELECT retry_at FROM map_chest_weeks WHERE prefecture_code=? AND expires_at=?', 'JP-13', expires)?.retry_at).toBe(0);

    const kanagawa = await request('/map-chests/nearby', 'POST', { latitude: 35.4437, longitude: 139.6380 });
    expect(kanagawa.status).toBe(200);
    expect(await kanagawa.json()).toMatchObject({ prefecture: '神奈川県', chests: expect.arrayContaining([expect.any(Object)]) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('draws without duplicates, gives a completion badge when the tier is complete, and rejects open or expired challenges', async () => {
    const claimed: Array<ChestResult | null> = [];
    for (let index = 0; index < 3; index++) {
      const id = await start(addChest(), 0);
      await sendTrace(id, 0);
      claimed.push(await finish(id, 0));
    }
    expect(new Set(claimed.slice(0, 2).map(prize => prize?.reward_id)).size).toBe(2);
    expect(claimed[2]).toEqual({ tier: 'medium', reward_id: null });
    const open = await start(addChest(), 0);
    await sendTrace(open, 0, loop(85).slice(0, 15));
    expect(await finish(open, 0)).toBeNull();
    const expired = addChest('JP-13', clock - 1);
    expect((await request('/running/sessions', 'POST', { activity_mode: 'personal', chest_id: expired })).status).toBe(409);
    expect((await request('/running/sessions', 'POST', { activity_mode: 'team', chest_id: expired })).status).toBe(400);
  });

  it('lets admins manage title and buff definitions, excludes buffs from personal draws, and preserves awarded titles', async () => {
    const admin = '/admin/chest-rewards';
    sql("UPDATE users SET role='admin' WHERE id=?", users[1]);
    const title: SaveChestReward = { name: '夜明けの走者', kind: 'title', tier: 'medium', revision: 0, asset: null, builtin_code: null, buff: null };
    expect((await request(admin, 'GET', undefined, -1)).status).toBe(401);
    expect((await request(admin, 'POST', title, 0)).status).toBe(403);
    for (const id of ['chest-compass', 'chest-switchback']) {
      expect((await request(`${admin}/${id}`, 'DELETE', { revision: 1 }, 1)).status).toBe(200);
    }
    const buff = { ...title, name: '小さな追い風', kind: 'buff', buff: { boost_percent: 10, duration_minutes: 15 } };
    expect((await request(admin, 'POST', { ...buff, buff: { duration_minutes: 15, boost_percent: 99 } }, 1)).status).toBe(400);
    const buffSaved = await request(admin, 'POST', buff, 1);
    expect(buffSaved.status).toBe(201);
    const { id: buffId } = await buffSaved.json() as { id: string };
    expect((await request(`${admin}/${buffId}`, 'PUT', { ...buff, revision: 1, buff: { boost_percent: 12, duration_minutes: 10 } }, 1)).status).toBe(200);
    const created = await request(admin, 'POST', title, 1);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await request('/map-chests/title', 'PUT', { reward_id: id })).status).toBe(403);
    const session = await start(addChest(), 0);
    await sendTrace(session, 0);
    expect(await finish(session, 0)).toMatchObject({ tier: 'medium', reward_id: id, reward: { kind: 'title', name: title.name } });
    expect((await request(`${admin}/${id}`, 'PUT', { ...title, name: '新しい称号', revision: 1 }, 1)).status).toBe(200);
    expect((await request(`${admin}/${id}`, 'DELETE', { revision: 1 }, 1)).status).toBe(409);
    expect((await request(`${admin}/${id}`, 'DELETE', { revision: 2 }, 1)).status).toBe(200);
    expect((await request(`${admin}/${buffId}`, 'DELETE', { revision: 2 }, 1)).status).toBe(200);
    expect((await request('/map-chests/title', 'PUT', { reward_id: id })).status).toBe(200);
    expect((await request('/map-chests/title', 'PUT', { reward_id: id }, 1)).status).toBe(403);
    const inventory = await request('/map-chests/rewards');
    expect(await inventory.json()).toMatchObject({ equipped_title: id, items: [{ name: title.name }] });
    const next = await start(addChest(), 0);
    await sendTrace(next, 0);
    expect(await finish(next, 0)).toEqual({ tier: 'medium', reward_id: null });
  });

  it('awards a pinned asset revision and permits only its owner to save it after reward deletion', async () => {
    sql("UPDATE users SET role='admin' WHERE id=?", users[1]);
    sql("UPDATE chest_reward_catalog SET archived=1 WHERE tier='medium'");
    const asset = { id: randomUUID(), revision: 1 };
    sql("INSERT INTO uniform_assets(id,kind,name,category,status,revision,reward_only) VALUES(?,'emblem','Badge','Chest','published',1,1)", asset.id);
    sql('INSERT INTO uniform_asset_versions(asset_id,revision,metadata_json) VALUES(?,?,?)', asset.id, asset.revision, JSON.stringify({
      ...asset, kind: 'emblem', name: 'Badge', category: 'Chest', description: '', status: 'published', sort_order: 0, builtin: false,
      width: 32, height: 32, color_mode: 'original', placement: 'all', scale: 100, model_definition: null,
      image_path: null, thumbnail_path: null, drawing_available: false, reward_only: true,
    }));
    const reward: SaveChestReward = { name: '限定ロゴ', kind: 'emblem', tier: 'medium', revision: 0, asset, builtin_code: null, buff: null };
    expect((await request('/admin/chest-rewards', 'POST', { ...reward, kind: 'pattern' }, 1)).status).toBe(409);
    const created = await request('/admin/chest-rewards', 'POST', reward, 1);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const design = { ...createStudioUniform(), emblem: asset };
    expect((await request('/uniforms/personal', 'PUT', { design, revision: 0 })).status).toBe(400);
    const session = await start(addChest(), 0);
    await sendTrace(session, 0);
    expect(await finish(session, 0)).toMatchObject({ reward: { name: reward.name, asset } });
    expect((await request(`/admin/chest-rewards/${id}`, 'DELETE', { revision: 1 }, 1)).status).toBe(200);
    expect((await request('/uniforms/personal', 'PUT', { design, revision: 0 }, 1)).status).toBe(400);
    expect((await request('/uniforms/personal', 'PUT', { design, revision: 0 })).status).toBe(200);
  });
});
