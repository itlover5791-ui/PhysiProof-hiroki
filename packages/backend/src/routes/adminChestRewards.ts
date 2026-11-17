import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { D1Database } from '@cloudflare/workers-types';
import { chestRewardIdSchema, chestRewardListSchema, chestRewardRevisionSchema, saveChestRewardSchema } from '@my-app/shared';
import type { SaveChestReward } from '@my-app/shared';
import { firebaseAuth } from '../middleware/auth';

type Env = { Bindings: { DB: D1Database }; Variables: { firebaseUser: { sub: string } } };
type RewardRow = SaveChestReward & {
  id: string; asset_id: string | null; asset_revision: number | null;
  boost_percent: number | null; duration_minutes: number | null;
};
const adminCheck = "EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin')";
const validAsset = `(? IS NULL OR EXISTS (
  SELECT 1 FROM uniform_assets a JOIN uniform_asset_versions v ON a.id=v.asset_id
  WHERE a.id=? AND v.revision=? AND a.kind=? AND a.status='published' AND a.reward_only=1
    AND json_extract(v.metadata_json,'$.status')='published'
))`;
const assetCheckValues = (reward: SaveChestReward) =>
  [reward.asset?.id ?? null, reward.asset?.id ?? null, reward.asset?.revision ?? null, reward.kind];
const updateValues = (reward: SaveChestReward) => [reward.name, reward.kind, reward.tier,
  reward.asset?.id ?? null, reward.asset?.revision ?? null,
  reward.buff?.boost_percent ?? null, reward.buff?.duration_minutes ?? null];
const conflict = '別の画面で設定が変更されたか、選択した素材が公開されていません。最新の一覧を確認してください。';

export const adminChestRewardRoutes = new Hono<Env>()
  .use('*', firebaseAuth)
  .use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    const user = await c.env.DB.prepare('SELECT role FROM users WHERE id=?')
      .bind(c.get('firebaseUser').sub).first<{ role: string }>();
    if (user?.role !== 'admin') return c.json({ error: '管理者権限が必要です。' }, 403);
    await next();
  })
  .get('/', async c => {
    const rows = await c.env.DB.prepare(`SELECT id, name, kind, tier, builtin_code,
      asset_id, asset_revision, boost_percent, duration_minutes, revision
      FROM chest_reward_catalog WHERE archived=0 ORDER BY
        CASE tier WHEN 'small' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, kind, name, id`).all<RewardRow>();
    return c.json(chestRewardListSchema.parse({ items: rows.results.map(row => ({
      id: row.id, name: row.name, kind: row.kind, tier: row.tier, builtin_code: row.builtin_code, revision: row.revision,
      asset: row.asset_id ? { id: row.asset_id, revision: row.asset_revision } : null,
      buff: row.kind === 'buff' ? { boost_percent: row.boost_percent, duration_minutes: row.duration_minutes } : null,
    })) }));
  })
  .post('/', zValidator('json', saveChestRewardSchema), async c => {
    const reward = c.req.valid('json');
    if (reward.revision !== 0 || reward.builtin_code) return c.json({ error: '新規報酬の情報が不正です。' }, 400);
    const id = crypto.randomUUID();
    const insert = await c.env.DB.prepare(`INSERT INTO chest_reward_catalog
      (id, name, kind, tier, asset_id, asset_revision, boost_percent, duration_minutes)
      SELECT ?,?,?,?,?,?,?,? WHERE ${adminCheck} AND ${validAsset}
        AND (SELECT COUNT(*) FROM chest_reward_catalog WHERE archived=0)<200`)
      .bind(id, ...updateValues(reward), c.get('firebaseUser').sub, ...assetCheckValues(reward)).run();
    if (!insert.meta.changes) return c.json({ error: '公開中の宝箱専用素材を選んでください。登録上限は200件です。' }, 409);
    return c.json({ id }, 201);
  })
  .put('/:id', zValidator('json', saveChestRewardSchema), async c => {
    const id = chestRewardIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: '報酬IDが不正です。' }, 400);
    const reward = c.req.valid('json');
    const result = await c.env.DB.prepare(`UPDATE chest_reward_catalog
      SET name=?, kind=?, tier=?, asset_id=?, asset_revision=?, boost_percent=?, duration_minutes=?, revision=revision+1
      WHERE id=? AND revision=? AND archived=0 AND builtin_code IS ?
        AND (builtin_code IS NULL OR kind=?) AND ${adminCheck} AND ${validAsset}`)
      .bind(...updateValues(reward), id.data, reward.revision, reward.builtin_code, reward.kind,
        c.get('firebaseUser').sub, ...assetCheckValues(reward)).run();
    return result.meta.changes ? c.json({ success: true }) : c.json({ error: conflict }, 409);
  })
  .delete('/:id', zValidator('json', chestRewardRevisionSchema), async c => {
    const id = chestRewardIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: '報酬IDが不正です。' }, 400);
    const result = await c.env.DB.prepare(`UPDATE chest_reward_catalog SET archived=1, revision=revision+1
      WHERE id=? AND revision=? AND archived=0 AND ${adminCheck}`)
      .bind(id.data, c.req.valid('json').revision, c.get('firebaseUser').sub).run();
    return result.meta.changes ? c.json({ success: true }) : c.json({ error: conflict }, 409);
  });
