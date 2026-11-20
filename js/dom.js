const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (id) => document.getElementById(id);

// Tiny element builder: h('div', { class: 'x', onclick: fn }, child1, 'text', …)
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

// References a <symbol id="i-NAME"> from the sprite in index.html.
export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function iconButton(iconName, label, onclick, size = 18) {
  return h(
    'button',
    { type: 'button', class: 'btn btn-ghost icon-btn', 'aria-label': label, onclick },
    icon(iconName, size),
  );
}

export function emptyState(message, iconName = 'check-circle') {
  return h('p', { class: 'card empty' }, icon(iconName), message);
}
