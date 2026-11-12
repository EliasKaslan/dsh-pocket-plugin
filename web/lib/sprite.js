/**
 * Inline SVG sprite.
 *
 * Kept in JS instead of the HTML so the LAN page and the remote shell share one
 * definition — the two HTML entry points would otherwise drift. The markup is a
 * static literal, so `innerHTML` here never sees user data.
 */

const SYMBOLS = [
  ['tasks', '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'],
  ['plus', '<path d="M12 5v14M5 12h14"/>'],
  ['settings', '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.38.4.72.74.96.3.2.66.3 1.02.3H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.74Z"/>'],
  ['back', '<path d="M15 5l-7 7 7 7"/>'],
  ['search', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'],
  ['send', '<path d="M12 19V5M5 12l7-7 7 7"/>'],
  ['close', '<path d="M6 6l12 12M18 6L6 18"/>'],
  ['refresh', '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/>'],
  ['wifi', '<path d="M3 9a15 15 0 0 1 18 0M6.5 12.5a10 10 0 0 1 11 0M10 16a5 5 0 0 1 4 0"/><circle cx="12" cy="19.5" r="1"/>'],
  ['chevron', '<path d="M9 5l7 7-7 7"/>'],
  ['check', '<path d="M4 12.5l5 5L20 6.5"/>'],
  ['alert', '<path d="M12 3l9.5 17h-19L12 3Z"/><path d="M12 9v5M12 17.5v.1"/>'],
  ['clock', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'],
  ['folder', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'],
  ['cpu', '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>'],
  ['scan', '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><path d="M7 12h10"/>'],
  ['copy', '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'],
  ['trash', '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'],
  ['moon', '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'],
  ['sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  ['bell', '<path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z"/><path d="M10 21h4"/>'],
  ['info', '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.1"/>'],
  ['external', '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'],
  ['stop', '<rect x="6" y="6" width="12" height="12" rx="2"/>'],
  ['sparkles', '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/>'],
  ['phone', '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 5h4M11 19h2"/>'],
  ['server', '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5v.1M7 16.5v.1"/>'],
  ['shield', '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z"/><path d="M9 12l2 2 4-4"/>'],
  ['more', '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'],
  ['down', '<path d="M5 9l7 7 7-7"/>'],
  ['edit', '<path d="M4 20h4L20 8l-4-4L4 16v4Z"/><path d="M13 7l4 4"/>'],
  ['link', '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>'],
  ['play', '<path d="M7 4l13 8-13 8V4Z"/>'],
  ['terminal', '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M7 9l3.2 3L7 15M12.5 15H17"/>'],
  ['key', '<circle cx="8" cy="13" r="4"/><path d="M11 10l8-8M16 3l3 3M14 5l3 3"/>'],
  ['inbox', '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-7Z"/>'],
];

export function installSprite() {
  if (document.getElementById('pocket-sprite') !== null) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'pocket-sprite';
  svg.setAttribute('class', 'sprite');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = SYMBOLS
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  document.body.prepend(svg);
}

installSprite();
