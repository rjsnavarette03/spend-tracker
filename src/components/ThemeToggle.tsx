import { toggleTheme, useTheme } from '../theme';
import { MoonIcon, SunIcon } from './Icons';

// Shows the icon of the theme you'd switch TO (sun while dark, moon while light).
export function ThemeToggle({ className = 'btn-icon' }: { className?: string }) {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={className}
      onClick={toggleTheme}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
