// Verification DOM checks, run as separate page sequences (same author; not independent).
// Each block is pasted on the page named in its comment, at 1440x900 unless stated.

// V1 (AC-1, AC-3, AC-10): /assets/<SoFi id>/view?view=report#report-unresolved-next-evidence (deep link to the last chapter, fresh load)
(async () => {
  const report = document.querySelector('article[data-report]');
  const rail = [...report.querySelectorAll('nav[aria-label="Report chapters"] a')];
  const current = rail.find((a) => a.getAttribute('aria-current') === 'page');
  const longOnes = rail.map((a) => a.textContent.replace(/^\d+\s*/, '')).filter((t) => t.length > 40 || t.includes(':'));
  const railBox = report.querySelector('[data-rail]');
  const railScrolls = railBox && railBox.scrollHeight > railBox.clientHeight + 2;
  const prev = [...report.querySelectorAll('nav[aria-label="Adjacent chapters"] button')][0];
  const before = report.querySelector('h2').textContent;
  prev?.click(); await new Promise((r) => setTimeout(r, 400));
  return {
    'AC-1': { pass: rail.length >= 10 && longOnes.length === 0, longOnes },
    'AC-3': { pass: !railScrolls, railScrolls },
    'AC-10': { pass: !!current && /Unresolved/.test(before) && report.querySelector('h2').textContent !== before && location.hash !== '#report-unresolved-next-evidence', before, after: report.querySelector('h2').textContent, hash: location.hash },
  };
})()

// V2 (AC-10, AC-11): /assets/<SoFi id>/view?view=report&layout=analysis#report-valuation (old link with layout param)
(async () => {
  const report = document.querySelector('article[data-report]');
  const hero = report.querySelector('[class*="heroValue"]');
  const sources = [...report.querySelectorAll('nav a, [data-rail] a')].find((a) => /^Sources/.test(a.textContent.trim()));
  sources?.click(); await new Promise((r) => setTimeout(r, 400));
  const srcItems = report.querySelectorAll('[data-source]').length;
  const questions = [...report.querySelectorAll('[data-rail] a')].find((a) => /^Research questions/.test(a.textContent.trim()));
  questions?.click(); await new Promise((r) => setTimeout(r, 400));
  const dots = [...report.querySelectorAll('[data-question] [data-status]')].length;
  return {
    'AC-11': { pass: !!report && !document.body.innerText.includes('Unable to load'), },
    'AC-7': { pass: !!hero && parseFloat(getComputedStyle(hero).fontSize) <= 40, heroSize: hero && getComputedStyle(hero).fontSize },
    'AC-10': { pass: srcItems > 0 && dots > 0, srcItems, dots },
  };
})()

// V3 (AC-8): /review?run=<SoFi run awaiting review> at 1024x768 (report in the narrow review column)
(async () => {
  const report = document.querySelector('article[data-report]');
  const rail = report.querySelector('[data-rail]');
  const content = report.querySelector('[data-analysis]');
  const railAbove = rail && content && rail.getBoundingClientRect().bottom <= content.getBoundingClientRect().top + 1;
  const overflow = [...report.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > report.getBoundingClientRect().right + 1 && !e.closest('[class*="table"], table, [role=region]')).length;
  return { 'AC-8': { pass: railAbove && overflow === 0 && document.documentElement.scrollWidth <= innerWidth, railAbove, overflow } };
})()

// V4 (AC-5, AC-6): /assets/<SoFi id>/view?view=report#report-founding-and-ownership (a chapter with no exhibits)
(async () => {
  const report = document.querySelector('article[data-report]');
  return {
    'AC-5': { pass: report.querySelectorAll('[data-exhibit]').length === 0 && !/Further details/.test(report.innerText), note: 'empty state: no empty exhibit block' },
    'AC-6': { pass: !!report.querySelector('[data-gaps] li') && !!report.querySelector('[data-takeaway]') },
  };
})()
