// Acceptance DOM checks (AC-3 to AC-7, AC-9). Paste into the browser console (or the Browser pane's
// javascript tool) on /assets/<SoFi id>/view?view=report#report-business-segments at 1440x900, after
// the report has loaded. Returns { "AC-x": { pass, detail } }.
(async () => {
  const out = {};
  const ok = (id, pass, detail) => { out[id] = { pass: !!pass, detail }; };
  const report = document.querySelector('article[data-report]') || document.querySelector('article');
  const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';

  // AC-3 one chrome: no report-level layout bar; nothing inside the report scrolls vertically on its own.
  const layoutBar = [...document.querySelectorAll('[role=group]')].some((g) => /Reading view|Analysis view/.test(g.textContent));
  const scrollers = [...report.querySelectorAll('*')].filter((e) => {
    const cs = getComputedStyle(e);
    return /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2 && e.tagName !== 'TEXTAREA';
  }).map((e) => e.tagName + '.' + String(e.className).slice(0, 40));
  ok('AC-3', !layoutBar && scrollers.length === 0, { layoutBar, scrollers });

  // AC-4 chapter header (Chapter n of N + short title) and takeaway before the analysis paragraphs.
  const h2 = report.querySelector('h2');
  const eyebrow = report.querySelector('[data-chapter-eyebrow]');
  const takeaway = report.querySelector('[data-takeaway]');
  const analysis = report.querySelector('[data-analysis]');
  const order = takeaway && analysis ? !!(takeaway.compareDocumentPosition(analysis) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  ok('AC-4', !!eyebrow && /Chapter \d+ of \d+/.test(eyebrow.textContent) && vis(h2) && h2.textContent.length <= 40 && order,
    { eyebrow: eyebrow?.textContent, h2: h2?.textContent, order });

  // AC-5 exhibits visible without clicks, not wrapped in <details>.
  const exhibits = [...report.querySelectorAll('[data-exhibit]')];
  const tables = exhibits.flatMap((e) => [...e.querySelectorAll('table')]).filter(vis);
  const wrapped = exhibits.filter((e) => e.closest('details'));
  ok('AC-5', exhibits.length > 0 && tables.length > 0 && wrapped.length === 0, { exhibits: exhibits.length, visibleTables: tables.length, wrapped: wrapped.length });

  // AC-6 counterarguments and evidence gaps visible without clicks.
  const counter = report.querySelector('[data-counterarguments]');
  const gaps = report.querySelector('[data-gaps]');
  ok('AC-6', vis(counter) && vis(gaps) && !gaps.closest('details') && gaps.querySelectorAll('li').length > 0,
    { counter: !!counter, gapItems: gaps?.querySelectorAll('li').length });

  // AC-7 tiles, no snake_case in headings and labels.
  const tiles = [...report.querySelectorAll('[data-tile]')];
  const badTile = tiles.find((t) => { const cs = getComputedStyle(t); return cs.borderTopWidth !== '1px' || cs.borderTopColor !== 'rgb(229, 231, 235)' || cs.borderRadius !== '8px' || cs.backgroundColor !== 'rgb(255, 255, 255)'; });
  const snake = [...report.querySelectorAll('h2,h3,th,dt,summary,[data-tile-title]')].map((e) => e.textContent).filter((t) => /\b[a-z]+_[a-z_]+\b/i.test(t));
  ok('AC-7', tiles.length >= 3 && !badTile && snake.length === 0, { tiles: tiles.length, badTile: badTile && String(badTile.className), snake });

  // AC-9 the asset tabs row has no vertical scrollbar.
  const tabs = document.querySelector('nav[aria-label="Asset views"]');
  ok('AC-9', tabs && tabs.scrollHeight <= tabs.clientHeight, { scrollHeight: tabs?.scrollHeight, clientHeight: tabs?.clientHeight });

  return out;
})()
