import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import type { Account, AccountType } from '../../shared/types';
import { api } from '../api';
import { centsToInput, cleanError, parseSignedAmountToCents } from '../format';
import { fileToAccountImage } from '../image';
import { Modal } from './Modal';
import { MoneyInput } from './MoneyInput';

const SWATCHES = [
  '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#f472b6', '#fb7185', '#f87171',
  '#f97316', '#f59e0b', '#eab308', '#84cc16', '#34d399', '#2dd4bf', '#94a3b8', '#e8eaf0',
];

const TYPE_LABELS: Record<AccountType, string> = {
  debit: 'Debit',
  credit: 'Credit',
  loan: 'Loan / Borrowed',
};

export function AccountEditModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<AccountType>(initial?.type ?? 'debit');
  const [color, setColor] = useState(initial?.color ?? SWATCHES[0]);
  // An account shows either a color or a custom image. `mode` drives which one
  // is saved; `image` holds the data URI when in image mode.
  const [mode, setMode] = useState<'color' | 'image'>(initial?.image ? 'image' : 'color');
  const [image, setImage] = useState<string | null>(initial?.image ?? null);
  const [imgBusy, setImgBusy] = useState(false);
  // Field holds a positive magnitude; the backend signs it by account type.
  const [opening, setOpening] = useState(
    initial ? centsToInput(Math.abs(initial.openingBalanceCents)) : ''
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-picked after a remove
    if (!file) return;
    setError('');
    setImgBusy(true);
    try {
      setImage(await fileToAccountImage(file));
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setImgBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Enter a name');
      return;
    }
    const openingCents = parseSignedAmountToCents(opening);
    if (openingCents === null) {
      setError('Enter a valid amount, e.g. 1500');
      return;
    }
    if (mode === 'image' && !image) {
      setError('Upload an image, or switch to Color');
      return;
    }
    const imageToSave = mode === 'image' ? image : null;
    setSaving(true);
    try {
      if (initial) {
        await api.accounts.update(initial.id, {
          name: name.trim(),
          color,
          image: imageToSave,
          openingBalanceCents: openingCents,
        });
      } else {
        await api.accounts.create({
          name: name.trim(),
          type,
          color,
          image: imageToSave,
          openingBalanceCents: openingCents,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit account' : 'New account'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="acc-name">Name</label>
          <input
            id="acc-name"
            type="text"
            value={name}
            placeholder="e.g. BPI Savings, Visa card, Loan from Mom"
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Type{initial ? ' (fixed after creation)' : ''}</label>
          <div className="segmented">
            {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
              <button
                key={t}
                type="button"
                className={type === t ? 'active-account' : ''}
                disabled={initial !== null}
                onClick={() => setType(t)}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="acc-opening">Amount</label>
          <MoneyInput id="acc-opening" value={opening} onChange={setOpening} />
          <div className="field-hint">
            {type === 'debit'
              ? "The account's current balance."
              : type === 'credit'
                ? 'How much you currently owe on this card — recorded as a negative balance automatically.'
                : 'How much you currently owe / borrowed — recorded as a negative balance automatically.'}
          </div>
        </div>

        <div className="field">
          <label>Appearance</label>
          <div className="segmented">
            <button
              type="button"
              className={mode === 'color' ? 'active-account' : ''}
              onClick={() => setMode('color')}
            >
              Color
            </button>
            <button
              type="button"
              className={mode === 'image' ? 'active-account' : ''}
              onClick={() => setMode('image')}
            >
              Image
            </button>
          </div>

          {mode === 'color' ? (
            <div className="swatches" style={{ marginTop: 10 }}>
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
          ) : (
            <div className="image-picker">
              <div className="image-preview" style={{ background: color }}>
                {image ? (
                  <img src={image} alt="Account" />
                ) : (
                  <span className="image-preview-empty">No image</span>
                )}
              </div>
              <div className="image-picker-actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={onPickFile}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={imgBusy}
                >
                  {imgBusy ? 'Processing…' : image ? 'Change image' : 'Upload image'}
                </button>
                {image && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setImage(null);
                      setMode('color');
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              <div className="field-hint">
                Square images look best. Large photos are resized automatically.
              </div>
            </div>
          )}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || imgBusy}>
            {initial ? 'Save changes' : 'Create account'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
