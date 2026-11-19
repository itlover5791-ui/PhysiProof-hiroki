import { useEffect, useState } from 'react';
import { chestInventorySchema } from '@my-app/shared';
import client from '../lib/hc';

type Inventory = ReturnType<typeof chestInventorySchema.parse>;
const api = client.api['map-chests'];

export default function ChestTitlesSection({ onEquip }: { onEquip: (name: string | null) => void }) {
  const [inventory, setInventory] = useState<Inventory>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.rewards.$get().then(async response => {
      if (!response.ok) throw new Error('宝箱の称号を取得できませんでした。');
      const data = chestInventorySchema.parse(await response.json());
      if (active) {
        setInventory(data);
        onEquip(data.items.find(item => item.id === data.equipped_title)?.name ?? null);
      }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [onEquip]);

  async function equip(id: string | null) {
    setBusy(true);
    setError('');
    try {
      const response = await api.title.$put({ json: { reward_id: id } });
      if (!response.ok) throw new Error('称号を変更できませんでした。');
      setInventory(value => value && { ...value, equipped_title: id });
      onEquip(inventory?.items.find(item => item.id === id)?.name ?? null);
    } catch (error) { setError(error instanceof Error ? error.message : '称号を変更できませんでした。'); }
    finally { setBusy(false); }
  }

  const titles = inventory?.items.filter(item => item.kind === 'title') ?? [];
  if (!titles.length && !error) return null;
  return <section className="pp-courses" aria-label="宝箱の称号">
    <h3>宝箱の称号</h3>
    {error && <p role="alert">{error}</p>}
    {titles.length > 0 && <div className="pp-course-rewards">
      {titles.map(title => <article key={title.id}>
        <strong>{title.name}</strong>
        <button type="button" disabled={busy} onClick={() => void equip(inventory?.equipped_title === title.id ? null : title.id)}>
          {inventory?.equipped_title === title.id ? '装備を外す' : '装備する'}
        </button>
      </article>)}
    </div>}
  </section>;
}
