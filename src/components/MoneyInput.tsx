import { ChangeEvent, KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { currencySymbol, formatAmountDisplay, sanitizeAmountInput } from '../format';

/**
 * Amount field with a currency-symbol prefix and live thousands grouping.
 * Accepts only digits and one decimal point (plus a leading "-" when
 * allowNegative). `value` is the clean numeric string the parent stores
 * (no grouping/symbol) — the same shape parseAmountToCents expects.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  allowNegative = false,
  placeholder = '0.00',
  autoFocus,
  onBlur,
  onEnter,
  className,
  ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (clean: string) => void;
  allowNegative?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
  onEnter?: () => void;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  // Restore the caret after React repaints the reformatted value.
  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const raw = el.value;
    const pos = el.selectionStart ?? raw.length;
    // How many "value chars" (digits/dot/minus) sit left of the caret now.
    const valueCharsBefore = (raw.slice(0, pos).match(/[\d.-]/g) || []).length;

    const clean = sanitizeAmountInput(raw, allowNegative);
    const formatted = formatAmountDisplay(clean);

    // Map that count onto the reformatted (comma-inserted) string.
    let seen = 0;
    let newPos = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
      if (seen >= valueCharsBefore) {
        newPos = i;
        break;
      }
      if (/[\d.-]/.test(formatted[i])) seen++;
    }
    caret.current = newPos;
    onChange(clean);
  };

  return (
    <div className={`money-input ${className ?? ''}`}>
      <span className="money-prefix">{currencySymbol()}</span>
      <input
        ref={ref}
        id={id}
        type="text"
        inputMode="decimal"
        value={formatAmountDisplay(value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onChange={handleChange}
        onBlur={onBlur}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter' && onEnter) onEnter();
        }}
      />
    </div>
  );
}
