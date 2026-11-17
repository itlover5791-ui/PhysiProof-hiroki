import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CHEST_TIERS, chestRewardListSchema, saveChestRewardSchema } from '@my-app/shared';
import type { ManagedChestReward, SaveChestReward } from '@my-app/shared';
import client from '../lib/hc';
import UniformAssetPicker from './UniformAssetPicker';
import './AdminChestRewards.css';

const labels = { emblem: 'エンブレム・ロゴ', pattern: '柄', title: '称号', buff: 'チーム戦用バフ' };
const blank: SaveChestReward = {
  name: '', kind: 'title', tier: 'small', asset: null, builtin_code: null, buff: null, revision: 0,
};
const api = client.api.admin['chest-rewards'];

export default function AdminChestRewards() {
  const [items, setItems] = useState<ManagedChestReward[]>();
  const [editing, setEditing] = useState<ManagedChestReward | null>();
  const [deleting, setDeleting] = useState<string>();
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const { register, watch, setValue, reset, handleSubmit, formState } = useForm<SaveChestReward>({
    resolver: zodResolver(saveChestRewardSchema), defaultValues: blank,
  });
  const kind = watch('kind');
  const asset = watch('asset');
  const busy = formState.isSubmitting || deletingBusy;

  useEffect(() => {
    let active = true;
    void api.$get().then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error('error' in data && typeof data.error === 'string' ? data.error : '報酬一覧を取得できませんでした。');
      if (active) setItems(chestRewardListSchema.parse(data).items);
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [refresh]);

  function open(item: ManagedChestReward | null) {
    setError('');
    setStatus('');
    setDeleting(undefined);
    setEditing(item);
    if (item) {
      const { id: _id, ...values } = item;
      reset(values);
    } else reset(blank);
  }

  async function save(values: SaveChestReward) {
    setError('');
    setStatus('');
    try {
      const response = editing
        ? await api[':id'].$put({ param: { id: editing.id }, json: values })
        : await api.$post({ json: values });
      const data = await response.json();
      if (!response.ok) throw new Error('error' in data ? data.error : '報酬を保存できませんでした。');
      setEditing(undefined);
      setStatus(editing ? '報酬を更新しました。' : '報酬を追加しました。');
      setRefresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '報酬を保存できませんでした。'); }
  }

  async function remove(item: ManagedChestReward) {
    setDeletingBusy(true);
    setError('');
    setStatus('');
    try {
      const response = await api[':id'].$delete({ param: { id: item.id }, json: { revision: item.revision } });
      const data = await response.json();
      if (!response.ok) throw new Error('error' in data ? data.error : '報酬を削除できませんでした。');
      setStatus('報酬を抽選候補から削除しました。');
      setDeleting(undefined);
      if (editing?.id === item.id) setEditing(undefined);
      setRefresh(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : '報酬を削除できませんでした。'); }
    finally { setDeletingBusy(false); }
  }

  return <section className="admin-card pp-chest-admin">
    <p>個人の宝箱は、囲った面積のランクに合う報酬から抽選します。変更は以降の抽選から適用されます。</p>
    <div className="pp-chest-admin-actions">
      <button className="pp-admin-primary" type="button" disabled={busy || !items} onClick={() => open(null)}>報酬を追加</button>
      <button type="button" disabled={busy} onClick={() => { setError(''); setRefresh(value => value + 1); }}>再読み込み</button>
    </div>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
    {editing !== undefined && <form className="pp-chest-admin-form" onSubmit={handleSubmit(save)}>
      <h3>{editing ? '報酬を編集' : '新しい報酬'}</h3>
      <fieldset disabled={busy}>
        <label>報酬名・称号名<input {...register('name')} maxLength={40} /></label>
        <label>ランク<select {...register('tier')}>{CHEST_TIERS.map(tier =>
          <option key={tier.id} value={tier.id}>{tier.label}</option>)}</select></label>
        <label>種類<select value={kind} disabled={!!editing?.builtin_code} onChange={event => {
          const next = event.target.value as SaveChestReward['kind'];
          setValue('kind', next, { shouldDirty: true });
          setValue('asset', null, { shouldDirty: true });
          setValue('buff', next === 'buff' ? { boost_percent: 10, duration_minutes: 15 } : null, { shouldDirty: true });
        }}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {(kind === 'emblem' || kind === 'pattern') && (editing?.builtin_code
          ? <p>標準報酬の素材を使用します。</p>
          : <div>
            <p>画像は「ユニフォーム管理」で宝箱専用素材として登録・公開してから選択します。</p>
            <UniformAssetPicker key={kind} kind={kind} rewardOnly value={asset ?? undefined}
              onSelect={ref => setValue('asset', ref, { shouldDirty: true, shouldValidate: true })} />
          </div>)}
        {kind === 'buff' && <>
          <p>保持得点を一定時間増やす設定です。チーム戦での付与・使用は今後の対応です。</p>
          <label>保持得点の増加率（1〜20%）<input type="number" min={1} max={20}
            {...register('buff.boost_percent', { valueAsNumber: true })} /></label>
          <label>効果時間（1〜30分）<input type="number" min={1} max={30}
            {...register('buff.duration_minutes', { valueAsNumber: true })} /></label>
        </>}
        {Object.keys(formState.errors).length > 0 && <p role="alert">報酬名、素材、バフの入力を確認してください。</p>}
        <div className="pp-chest-admin-actions">
          <button className="pp-admin-primary" type="submit">{busy ? '処理中…' : '保存'}</button>
          <button type="button" onClick={() => setEditing(undefined)}>閉じる</button>
        </div>
      </fieldset>
    </form>}
    {items && items.length === 0 && <p>登録済みの報酬はありません。</p>}
    {items && items.length > 0 && <ul className="pp-chest-admin-list">
      {items.map(item => <li key={item.id}>
        <div>
          <strong>{item.name}</strong>
          <small>{CHEST_TIERS.find(tier => tier.id === item.tier)?.label} · {labels[item.kind]}
            {item.buff && ` · 保持得点 +${item.buff.boost_percent}%・${item.buff.duration_minutes}分（設定のみ）`}</small>
        </div>
        <div className="pp-chest-admin-actions">
          {deleting === item.id ? <>
            <span>抽選候補から外しますか？</span>
            <button type="button" disabled={busy} onClick={() => void remove(item)}>削除する</button>
            <button type="button" disabled={busy} onClick={() => setDeleting(undefined)}>やめる</button>
          </> : <>
            <button type="button" disabled={busy} onClick={() => open(item)}>編集</button>
            <button type="button" disabled={busy} onClick={() => setDeleting(item.id)}>削除</button>
          </>}
        </div>
      </li>)}
    </ul>}
  </section>;
}
