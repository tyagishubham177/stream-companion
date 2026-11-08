// Lucide icons (ISC), https://github.com/lucide-icons/lucide. Paths from check,
// bookmark and circle-minus. ISC: Copyright (c) Lucide Contributors. Permission
// to use, copy, modify, and distribute for any purpose with or without fee is
// granted provided this notice appears in all copies. THE SOFTWARE IS PROVIDED
// "AS IS" WITHOUT WARRANTY; AUTHORS ARE NOT LIABLE FOR DAMAGES FROM ITS USE.
const paths = {
  watched: '<path d="M20 6 9 17l-5-5"/>',
  want: '<path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/>',
  pass: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
};
export function markIcon(name: keyof typeof paths): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  svg.innerHTML = paths[name]; // Bundled static Lucide paths, never provider/user input.
  return svg;
}
