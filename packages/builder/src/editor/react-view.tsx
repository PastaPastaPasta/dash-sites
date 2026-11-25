import { createElement, type ReactNode } from 'react';
import { isElement, isRaw, type Attrs, type Child } from '../page/markup.js';

function reactProps(attrs: Attrs, key: number | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = key === undefined ? {} : { key };
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) props[name === 'class' ? 'className' : name] = value;
  return props;
}

/**
 * Draws a block's markup with React for the editor canvas. The markup comes from the same view
 * function the published page uses; nodes Puck passes for in-place editing go through unchanged.
 */
export function toReact(child: Child | ReactNode, key?: number): ReactNode {
  if (child === null || child === undefined || child === false) return null;
  if (typeof child === 'string') return child;
  if (Array.isArray(child)) return child.map((item, index) => toReact(item as Child, index));
  if (isElement(child)) {
    const props = reactProps(child.attrs, key);
    const [only] = child.children;
    if (child.children.length === 1 && isRaw(only)) return createElement(child.tag, { ...props, dangerouslySetInnerHTML: { __html: only.html } });
    return createElement(child.tag, props, ...child.children.map((item, index) => toReact(item, index)));
  }
  if (isRaw(child)) return createElement('div', { key, dangerouslySetInnerHTML: { __html: child.html } });
  return child as ReactNode;
}
