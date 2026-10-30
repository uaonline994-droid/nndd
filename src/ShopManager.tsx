import { useState, type FormEvent } from "react";
import { Check, Eye, EyeOff, Pencil, Plus, Save, X } from "lucide-react";
import { isTagItem } from "./modules/shop_manager.js";
import { nextDynamicPrice } from "./modules/tags_exchange.js";

export type ShopItem = {
  id: string;
  name: string;
  description?: string;
  type: string;
  priceUah: number;
  priceUsdt: number;
  iconUrl?: string | null;
  enabled: boolean;
  dynamicPrice?: boolean;
  priceStepUah?: number;
  priceStepUsdt?: number;
  salesCount?: number;
  priceHistory?: Record<string, { price: number; currency: string; at: number }>;
};

export type ShopTag = { tag: string; uid: string; itemId: string; orderId: string; status: string; reservedAt?: number; activatedAt?: number };

type ShopManagerProps = {
  items: ShopItem[];
  tags: ShopTag[];
  onSave: (item: Omit<ShopItem, "id">, itemId?: string) => Promise<void>;
};

const emptyItem: Omit<ShopItem, "id"> = {
  name: "", description: "", type: "tag", priceUah: 0, priceUsdt: 0,
  enabled: true, dynamicPrice: false, priceStepUah: 0, priceStepUsdt: 0,
};

export function ShopManager({ items, tags, onSave }: ShopManagerProps) {
  const [form, setForm] = useState(emptyItem);
  const [editingId, setEditingId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  function edit(item?: ShopItem) {
    setEditingId(item?.id);
    setForm(item ? { ...emptyItem, ...item } : { ...emptyItem });
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      await onSave(form, editingId);
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не вдалося зберегти товар.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(item: ShopItem) {
    const { id, ...payload } = item;
    setSaveError("");
    try {
      await onSave({ ...payload, enabled: !item.enabled }, id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не вдалося змінити статус товару.");
    }
  }

  return (
    <div className="shop-manager">
      <div className="shop-toolbar">
        <p>{items.length} товарів · {items.filter((item) => item.enabled).length} активних</p>
        <button className="button primary" onClick={() => edit()}><Plus size={15} /> Додати товар</button>
      </div>
      {saveError && !open && <p className="shop-form-error">{saveError}</p>}
      <div className="shop-table-wrap">
        <table className="shop-table">
          <thead><tr><th>Товар</th><th>Тип</th><th>Ціна</th><th>Продажі</th><th>Статус</th><th aria-label="Дії" /></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.name}</strong><small>{item.description || item.id}</small></td>
                <td>{item.type}{isTagItem(item) && item.dynamicPrice ? " · динамічна" : ""}</td>
                <td>{Number(item.priceUah).toFixed(2)} ₴<small>{Number(item.priceUsdt).toFixed(2)} USDT</small>
                  {isTagItem(item) && item.dynamicPrice && <small>Наступна: {nextDynamicPrice(item, "UAH").toFixed(2)} ₴</small>}
                </td>
                <td>{item.salesCount || 0}</td>
                <td><span className={item.enabled ? "shop-status enabled" : "shop-status"}>{item.enabled ? "Активний" : "Прихований"}</span></td>
                <td className="shop-actions">
                  <button className="icon-button" title="Редагувати товар" onClick={() => edit(item)}><Pencil size={15} /></button>
                  <button className="icon-button" title={item.enabled ? "Приховати товар" : "Показати товар"} onClick={() => void toggle(item)}>
                    {item.enabled ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={6} className="shop-empty">Каталог порожній.</td></tr>}
          </tbody>
        </table>
      </div>
      <section className="sales-panel exchange-panel">
        <header><h2>Міні-біржа тегів</h2><small>{tags.length} зарезервованих або активних</small></header>
        <div className="shop-table-wrap"><table className="shop-table"><thead><tr><th>Тег</th><th>Гравець UID</th><th>Замовлення</th><th>Стан</th><th>Створено</th></tr></thead>
          <tbody>{tags.map((tag) => <tr key={tag.tag}><td><strong>{tag.tag}</strong></td><td>{tag.uid}</td><td>{tag.orderId}</td><td><span className={`shop-status ${tag.status === "active" ? "enabled" : ""}`}>{tag.status}</span></td><td>{new Date(tag.activatedAt || tag.reservedAt || 0).toLocaleString()}</td></tr>)}
            {!tags.length && <tr><td colSpan={5} className="shop-empty">Тегів ще немає.</td></tr>}</tbody>
        </table></div>
      </section>
      {open && (
        <div className="shop-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <form className="shop-modal" onSubmit={(event) => void submit(event)}>
            <header><h2>{editingId ? "Редагувати товар" : "Новий товар"}</h2><button className="icon-button" type="button" title="Закрити" onClick={() => setOpen(false)}><X size={17} /></button></header>
            <label>Назва<input required maxLength={80} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>Опис<textarea maxLength={400} rows={2} value={form.description || ""} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
            <div className="shop-form-grid">
              <label>Тип<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
                <option value="tag">Унікальний тег</option><option value="vip">VIP</option><option value="cape">Плащ</option><option value="subscription">Підписка</option><option value="donation">Підтримка проєкту</option>
              </select></label>
              <label>Іконка URL<input maxLength={500} value={form.iconUrl || ""} onChange={(event) => setForm({ ...form, iconUrl: event.target.value })} /></label>
              <label>Ціна, UAH<input type="number" min="0" step="0.01" required value={form.priceUah} onChange={(event) => setForm({ ...form, priceUah: Number(event.target.value) })} /></label>
              <label>Ціна, USDT<input type="number" min="0" step="0.01" required value={form.priceUsdt} onChange={(event) => setForm({ ...form, priceUsdt: Number(event.target.value) })} /></label>
            </div>
            {form.type === "tag" && <>
              <label className="shop-checkbox"><input type="checkbox" checked={Boolean(form.dynamicPrice)} onChange={(event) => setForm({ ...form, dynamicPrice: event.target.checked })} /> Автоматично підвищувати ціну після продажу</label>
              {form.dynamicPrice && <div className="shop-form-grid">
                <label>Крок, UAH<input type="number" min="0" step="0.01" value={form.priceStepUah || 0} onChange={(event) => setForm({ ...form, priceStepUah: Number(event.target.value) })} /></label>
                <label>Крок, USDT<input type="number" min="0" step="0.01" value={form.priceStepUsdt || 0} onChange={(event) => setForm({ ...form, priceStepUsdt: Number(event.target.value) })} /></label>
              </div>}
            </>}
            <label className="shop-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> Доступний у лаунчері</label>
            {saveError && <p className="shop-form-error">{saveError}</p>}
            <footer><button type="button" className="button secondary" onClick={() => setOpen(false)}>Скасувати</button><button className="button primary" disabled={saving}><Save size={14} /> {saving ? "Збереження" : "Зберегти"}</button></footer>
            {editingId && <span className="shop-editing"><Check size={12} /> Зміни одразу синхронізуються через Firebase</span>}
          </form>
        </div>
      )}
    </div>
  );
}
