/**
 * Moves a published page's rules under `scope`, so the editor can draw the page inside the
 * builder without its rules reaching the builder or the builder's reaching it.
 */
export function scopeCss(css: string, scope: string): string {
  return css
    .split('}')
    .filter(Boolean)
    .map((rule) => {
      const at = rule.indexOf('{');
      const selectors = rule
        .slice(0, at)
        .split(',')
        .map((selector) => {
          const trimmed = selector.trim();
          if (trimmed === ':root' || trimmed === 'html' || trimmed === 'body') return scope;
          return `${scope} ${trimmed}`;
        });
      return `${selectors.join(',')}${rule.slice(at)}}`;
    })
    .join('');
}

export const EDITOR_CSS = `
html.editing,html.editing body{overflow:hidden}
.ed{position:fixed;inset:0;z-index:50;background:var(--bg);color:var(--ink);
  --puck-font-family:var(--display);
  --puck-color-surface:var(--surface);--puck-color-surface-muted:var(--bg);--puck-color-surface-subtle:color-mix(in srgb,var(--surface) 55%,var(--bg));--puck-color-surface-inverse:var(--ink);
  --puck-color-border:var(--line);--puck-color-border-hover:var(--muted);--puck-color-border-muted:var(--line);--puck-color-border-inverse:var(--muted);
  --puck-color-text:var(--ink);--puck-color-text-secondary:var(--muted);--puck-color-text-muted:var(--muted);--puck-color-text-subtle:var(--muted);--puck-color-text-inverse:var(--surface);--puck-color-text-disabled:var(--muted);
  --puck-color-interactive:var(--blue);--puck-color-interactive-hover:var(--blue);--puck-color-interactive-active:var(--blue);
  --puck-color-interactive-subtle:color-mix(in srgb,var(--blue) 16%,var(--surface));--puck-color-interactive-soft:color-mix(in srgb,var(--blue) 9%,var(--surface));--puck-color-interactive-soft-hover:color-mix(in srgb,var(--blue) 13%,var(--surface));
  --puck-color-interactive-neutral-hover:color-mix(in srgb,var(--ink) 8%,var(--surface));
  --puck-color-focus-ring:var(--blue);--puck-color-selection-border:var(--blue);--puck-color-highlight:var(--blue);--puck-color-line-placeholder:var(--blue);
  --puck-color-bg-disabled:var(--line);
  --puck-field-color-bg:var(--field);--puck-field-color-bg-hover:var(--field);--puck-field-color-text:var(--ink);--puck-field-color-text-hover:var(--ink);
  --puck-field-color-border:var(--line);--puck-field-color-border-hover:var(--muted);--puck-field-color-border-focus:var(--blue);
  --puck-field-color-bg-disabled:var(--bg);--puck-field-color-border-disabled:var(--line);--puck-field-color-text-disabled:var(--muted)}
.ed button,.ed input,.ed select,.ed textarea{font-family:inherit}
.ed-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line)}
.ed-group{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ed-title{font-size:15px;font-weight:700;letter-spacing:-.01em;margin-right:4px}
.ed-icon{font:500 18px/1 var(--display);width:32px;height:32px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--ink);cursor:pointer}
.ed-icon:disabled{opacity:.4;cursor:default}
.ed-themes button{font:600 13px var(--display);padding:4px 11px;cursor:pointer}
.ed-themes{flex:none;flex-wrap:nowrap}
.ed-cost{flex:none;display:flex;flex-direction:column;align-items:flex-end;font-size:12.5px;line-height:1.25;color:var(--muted);white-space:nowrap}
.ed-cost b{color:var(--ink);font-size:13.5px;font-weight:650}
.ed-add{font:600 13px var(--display);color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:6px;padding:6px 8px;cursor:pointer;max-width:11rem}
.ed-done{font:650 14px var(--display);color:var(--blue-ink);background:var(--blue);border:0;border-radius:6px;padding:8px 18px;cursor:pointer}
.ed-image{display:grid;gap:8px;font-size:13px;padding:var(--puck-space-3,12px) var(--puck-space-4,16px)}
.ed-label{font-weight:600;font-size:var(--puck-font-size-xxs,13px)}
.ed-thumb{display:block;max-width:100%;max-height:160px;border-radius:6px;border:1px solid var(--line);background:var(--bg)}
.ed-thumb.round{width:72px;height:72px;object-fit:cover;border-radius:50%}
.ed-size{display:grid;gap:4px}
.ed-size select{font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:6px;padding:6px 8px;width:100%}
.ed-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ed-pick{position:relative;display:inline-block;font-weight:600;border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer;background:var(--field)}
.ed-pick input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}
.ed-pick:focus-within{outline:2px solid var(--blue);outline-offset:2px}
.ed-link{background:none;border:0;padding:0;color:var(--blue);font:inherit;font-weight:600;cursor:pointer}
.ed-note{margin:0;color:var(--muted);font-size:12.5px}
.ed-error{margin:0;color:var(--bad)}
.dsp{min-height:100%}
.dsp main{min-height:60vh}
@media (max-width:760px){.ed-split{display:none}.ed-bar{padding:8px 10px;gap:8px 6px}.ed-group{display:contents}.ed-title{display:none}.ed-done{order:1;margin-left:auto}.ed-themes{order:2}.ed-themes button{padding:3px 8px;font-size:12px}.ed-cost{order:3;margin-left:auto}}
`;
