/**
 * Returns an inline `style` object with a CSS `animationDelay` computed from
 * the item index. Caps the delay after `maxSteps` items so long lists do not
 * accumulate excessive delay.
 *
 * Prefer this over ad-hoc `style={{ animationDelay: ... }}` at call sites so
 * the stagger cadence stays consistent across the app.
 */
export function staggeredDelay(index: number, maxSteps: number = 12, stepMs: number = 35): React.CSSProperties {
  const step = Math.min(Math.max(index, 0), maxSteps);
  return { animationDelay: `${step * stepMs}ms` };
}
