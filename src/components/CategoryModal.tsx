import { FormEvent, useState } from 'react';
import type { Category, TxType } from '../../shared/types';
import { api } from '../api';
import { cleanError } from '../format';
import { Modal } from './Modal';

const SWATCHES = [
  '#f87171', '#fb7185', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#34d399', '#2dd4bf',
  '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#f472b6', '#94a3b8', '#e8eaf0',
];

export function CategoryModal({
  initial,
  type,
  onClose,
  onSaved,
}: {
  initial: Category | null;
  type: TxType;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? SWATCHES[6]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a name');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (initial) await api.categories.update(initial.id, { name: name.trim(), color });
      else await api.categories.create({ name: name.trim(), type, color });
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={initial ? 'Edit category' : `New ${type} category`}
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="cat-name">Name</label>
          <input
            id="cat-name"
            type="text"
            value={name}
            placeholder="e.g. Groceries"
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Color</label>
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch ${c === color ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {initial ? 'Save changes' : 'Create category'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
