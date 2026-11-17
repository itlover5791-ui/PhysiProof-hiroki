import { z } from 'zod';
import { uniformAssetRefSchema } from './uniform-studio.schema';

export const CHEST_TIERS = [
  { id: 'small', label: '小', area: 500 },
  { id: 'medium', label: '中', area: 10000 },
  { id: 'large', label: '大', area: 40000 },
] as const;

export const CHEST_INNER_MARGIN_M = 12;
export const CHEST_MAX_TRACE_POINTS = 900;

export const CHEST_REWARDS = [
  { id: 'chest-sprout', name: 'トレイルスプラウト', tier: 'small', kind: 'emblem' },
  { id: 'chest-ripple', name: 'リップルライン', tier: 'small', kind: 'pattern' },
  { id: 'chest-compass', name: 'ノースコンパス', tier: 'medium', kind: 'emblem' },
  { id: 'chest-switchback', name: 'スイッチバック', tier: 'medium', kind: 'pattern' },
  { id: 'chest-crown', name: 'サミットクラウン', tier: 'large', kind: 'emblem' },
  { id: 'chest-aurora', name: 'オーロラリボン', tier: 'large', kind: 'pattern' },
] as const;

export const chestTierSchema = z.enum(['small', 'medium', 'large']);
const builtinRewardSchema = z.enum(['chest-sprout', 'chest-ripple', 'chest-compass', 'chest-switchback', 'chest-crown', 'chest-aurora']);
export const chestRewardIdSchema = z.union([builtinRewardSchema, z.string().uuid()]);
export const chestRewardKindSchema = z.enum(['emblem', 'pattern', 'title', 'buff']);
export const chestBuffSchema = z.object({
  boost_percent: z.number().int().min(1).max(20),
  duration_minutes: z.number().int().min(1).max(30),
}).strict();
const rewardFields = z.object({
  name: z.string().trim().min(1).max(40),
  kind: chestRewardKindSchema,
  tier: chestTierSchema,
  asset: uniformAssetRefSchema.nullable(),
  builtin_code: builtinRewardSchema.nullable(),
  buff: chestBuffSchema.nullable(),
});

function validReward(value: z.infer<typeof rewardFields>) {
  if (value.kind === 'title') return !value.asset && !value.builtin_code && !value.buff;
  if (value.kind === 'buff') return !value.asset && !value.builtin_code && !!value.buff;
  if (value.builtin_code) return !value.asset && !value.buff
    && CHEST_REWARDS.some(reward => reward.id === value.builtin_code && reward.kind === value.kind);
  return !!value.asset && !value.buff;
}

const rewardFieldsError = '報酬の種類に合った素材またはバフの設定を入力してください。';
export const saveChestRewardSchema = rewardFields.extend({
  revision: z.number().int().nonnegative(),
}).strict().refine(validReward, rewardFieldsError);
export const managedChestRewardSchema = rewardFields.extend({
  id: chestRewardIdSchema,
  revision: z.number().int().positive(),
}).strict().refine(validReward, rewardFieldsError);
export const chestRewardListSchema = z.object({ items: z.array(managedChestRewardSchema) });
export const chestRewardRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export const equipChestTitleSchema = z.object({ reward_id: chestRewardIdSchema.nullable() }).strict();
export type SaveChestReward = z.infer<typeof saveChestRewardSchema>;
export type ManagedChestReward = z.infer<typeof managedChestRewardSchema>;
export const chestLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();
export const mapChestSchema = chestLocationSchema.extend({
  id: z.string().uuid(),
  claimed: z.boolean(),
});
export const mapChestsSchema = z.object({
  prefecture: z.string(),
  expires_at: z.number().int(),
  chests: z.array(mapChestSchema).max(12),
});
export const chestInventorySchema = z.object({
  rewards: z.array(chestRewardIdSchema),
  completion_badges: z.number().int().nonnegative(),
  items: z.array(managedChestRewardSchema).default([]),
  equipped_title: chestRewardIdSchema.nullable().default(null),
});
export const chestResultSchema = z.object({
  tier: chestTierSchema,
  reward_id: chestRewardIdSchema.nullable(),
  reward: managedChestRewardSchema.nullable().optional(),
});
export type ChestTier = z.infer<typeof chestTierSchema>;
export type MapChest = z.infer<typeof mapChestSchema>;
export type ChestResult = z.infer<typeof chestResultSchema>;
export type ChestRewardId = z.infer<typeof chestRewardIdSchema>;
