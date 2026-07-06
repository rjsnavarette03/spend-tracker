import { useState } from 'react';
import type { Category, TxType } from '../../shared/types';
import { api } from '../api';
import { CategoryModal } from '../components/CategoryModal';
import { PencilIcon, PlusIcon, TrashIcon } from '../components/Icons';
import { cleanError } from '../format';

export function Categories({
  categories,
  onDataChanged,
}: {
  categories: Category[];
  onDataChanged: () => void;
}) {
  const [modal, setModal] = useState<{ open: boolean; editing: Category | null; type: TxType }>({
    open: false,
    editing: null,
    type: 'expense',
  });

  const remove = async (c: Category) => {
    const warning =
      c.txCount > 0
        ? `Delete "${c.name}"?\n\n${c.txCount} transaction${c.txCount === 1 ? '' : 's'} will become Uncategorized. Any budgets for it will be removed.`
        : `Delete "${c.name}"?`;
    if (!window.confirm(warning)) return;
    try {
      await api.categories.remove(c.id);
      onDataChanged();
    } catch (err) {
      alert(cleanError(err));
    }
  };

  const section = (type: TxType, title: string) => {
    const items = categories.filter((c) => c.type === type);
    return (
      <div className="panel">
        <div className="section-title">
          <span>
            {title} <span className={`type-tag ${type}`}>{items.length}</span>
          </span>
          <button
            className="btn"
            onClick={() => setModal({ open: true, editing: null, type })}
          >
            <PlusIcon /> Add
          </button>
        </div>
        {items.length === 0 ? (
          <div className="empty-state">No {type} categories yet.</div>
        ) : (
          <table className="table">
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="cat-chip">
                      <span className="color-dot" style={{ background: c.color }} />
                      <span>{c.name}</span>
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>
                    {c.txCount} transaction{c.txCount === 1 ? '' : 's'}
                  </td>
                  <td className="actions">
                    <button
                      className="btn-icon"
                      title="Edit"
                      onClick={() => setModal({ open: true, editing: c, type })}
                    >
                      <PencilIcon />
                    </button>
                    <button className="btn-icon danger" title="Delete" onClick={() => remove(c)}>
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Categories</h1>
          <div className="page-sub">Organize where your money comes from and goes</div>
        </div>
      </div>
      <div className="grid-2-even">
        {section('expense', 'Expense categories')}
        {section('income', 'Income categories')}
      </div>

      {modal.open && (
        <CategoryModal
          initial={modal.editing}
          type={modal.type}
          onClose={() => setModal((m) => ({ ...m, open: false }))}
          onSaved={onDataChanged}
        />
      )}
    </div>
  );
}
