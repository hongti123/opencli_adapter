import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const PAGE_URL = 'https://vcnew.jd.com/finance/actualSalesSolidDetails';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_INPUT_WRAPPER = '.ant-picker-range .ant-picker-input';

function requireDate(value, name) {
  const date = String(value || '').trim();
  if (!DATE_RE.test(date)) {
    throw new CommandExecutionError(`${name} must be YYYY-MM-DD, got: ${value || ''}`);
  }
  return date;
}

function readStateScript() {
  return `(() => {
    const q = (sel) => document.querySelector(sel);
    const qa = (sel) => Array.from(document.querySelectorAll(sel));
    const start = q('input#refDate');
    const end = start?.closest('.ant-picker')?.querySelectorAll('input')?.[1];
    const months = qa('.ant-picker-dropdown .ant-picker-month-btn').map((el) => (el.textContent || '').trim());
    const years = qa('.ant-picker-dropdown .ant-picker-year-btn').map((el) => (el.textContent || '').trim());
    const totalText = (qa('li').map((li) => li.textContent || '').find((text) => text.includes('总共') && text.includes('条')) || '').trim();
    return {
      start_date: start?.value || '',
      end_date: end?.value || '',
      picker_open: Boolean(q('.ant-picker-dropdown')),
      left_year: years[0] || '',
      left_month: months[0] || '',
      total_text: totalText,
      url: location.href,
      title: document.title || '',
    };
  })()`;
}

function normalizeNumber(text) {
  return Number(String(text || '').replace(/\D/g, ''));
}

function monthDelta(state, date) {
  const leftYear = normalizeNumber(state.left_year);
  const leftMonth = normalizeNumber(state.left_month);
  const wantedYear = Number(date.slice(0, 4));
  const wantedMonth = Number(date.slice(5, 7));
  if (!leftYear || !leftMonth) throw new CommandExecutionError('Could not read date picker month');
  return (wantedYear - leftYear) * 12 + (wantedMonth - leftMonth);
}

async function readState(page) {
  return await page.evaluate(readStateScript());
}

async function ensureOnPage(page) {
  await page.goto(PAGE_URL);
  await page.wait(3);
  try {
    await page.wait({ selector: 'input#refDate', timeout: 15000 });
  } catch {
    const state = await readState(page).catch(() => ({}));
    throw new CommandExecutionError(
      'JD solid details page did not load the business-date input. Make sure the connected Chrome profile is logged in.',
      `Current URL: ${state.url || 'unknown'}`,
    );
  }
}

async function openPicker(page, nth) {
  await page.click(DATE_INPUT_WRAPPER, { nth });
  try {
    await page.wait({ selector: '.ant-picker-dropdown', timeout: 8000 });
  } catch {
    throw new CommandExecutionError('Date picker dropdown did not open');
  }
}

async function ensureDateVisible(page, date) {
  for (let i = 0; i < 36; i += 1) {
    const selector = `.ant-picker-dropdown td[title="${date}"]:not(.ant-picker-cell-disabled)`;
    const cellCount = await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (Number(cellCount) > 0) return selector;

    const state = await readState(page);
    const delta = monthDelta(state, date);
    const navClass = delta < 0 ? 'ant-picker-header-prev-btn' : 'ant-picker-header-next-btn';
    const marked = await page.evaluate(`(() => {
      const visible = (el) => { if (!el) return false; const style = getComputedStyle(el); return style.visibility !== 'hidden' && style.display !== 'none' && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); };
      document.querySelectorAll('[data-opencli-jd-solid-nav]').forEach((el) => el.removeAttribute('data-opencli-jd-solid-nav'));
      const button = Array.from(document.querySelectorAll('.ant-picker-dropdown .${navClass}')).find(visible);
      if (!button) return { ok: false };
      button.setAttribute('data-opencli-jd-solid-nav', '1');
      return { ok: true };
    })()`);
    if (!marked?.ok) throw new CommandExecutionError(`Picker navigation button not found: ${navClass}`);
    await page.click('[data-opencli-jd-solid-nav]');
    await page.wait(0.3);
  }
  throw new CommandExecutionError(`Date not found in picker: ${date}`);
}

async function chooseDate(page, date, nth) {
  await openPicker(page, nth);
  const selector = await ensureDateVisible(page, date);
  await page.click(selector);
  await page.wait(0.8);
}

async function waitForTableRange(page, startDate, endDate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const rowTexts = rows.map((row) => row.innerText || row.textContent || '').filter(Boolean);
      const dates = rowTexts.flatMap((text) => Array.from(text.matchAll(/20\\d{2}-\\d{2}-\\d{2}/g)).map((match) => match[0]));
      const inRangeDates = dates.filter((date) => date >= '${startDate}' && date <= '${endDate}');
      const totalText = (Array.from(document.querySelectorAll('li')).map((li) => li.textContent || '').find((text) => text.includes('总共') && text.includes('条')) || '').trim();
      return { row_count: rowTexts.length, date_count: dates.length, in_range_count: inRangeDates.length, total_text: totalText };
    })()`);
    if (Number(state?.row_count || 0) > 0 && Number(state?.date_count || 0) > 0 && Number(state?.in_range_count || 0) > 0) return state;
    await page.wait(0.5);
  }
  throw new CommandExecutionError(`Table did not refresh to business date range: ${startDate} to ${endDate}`);
}
async function clickQuery(page) {
  const found = await page.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((candidate) => (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, '') === '查询');
    if (!button) return { ok: false };
    button.setAttribute('data-opencli-jd-solid-query', '1');
    return { ok: true };
  })()`);
  if (!found?.ok) throw new CommandExecutionError('Query button not found');
  await page.click('button[data-opencli-jd-solid-query]');
  await page.wait(2);
}

cli({
  site: 'jd-solid',
  name: 'set-date-query',
  description: 'Open JD self-operated actual-sales settlement details, set the business-date range, run Query, and verify the dates did not reset.',
  access: 'read',
  example: 'opencli jd-solid set-date-query --start-date 2026-06-05 --end-date 2026-06-05 --site-session persistent --keep-tab true --window foreground -f yaml',
  domain: 'vcnew.jd.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'start-date', type: 'string', required: true, help: 'Business start date, YYYY-MM-DD' },
    { name: 'end-date', type: 'string', required: true, help: 'Business end date, YYYY-MM-DD' },
  ],
  columns: ['status', 'start_date', 'end_date', 'total_text', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for jd-solid set-date-query');

    const startDate = requireDate(kwargs['start-date'], 'start-date');
    const endDate = requireDate(kwargs['end-date'], 'end-date');

    await ensureOnPage(page);

    await chooseDate(page, startDate, 0);
    let selected = await readState(page);
    if (selected.start_date !== startDate || selected.end_date !== endDate) {
      await chooseDate(page, endDate, 1);
      selected = await readState(page);
    }

    if (selected.start_date !== startDate || selected.end_date !== endDate) {
      throw new CommandExecutionError(`Date selection failed: expected ${startDate} to ${endDate}, got ${selected.start_date || ''} to ${selected.end_date || ''}`);
    }

    await clickQuery(page);
    await waitForTableRange(page, startDate, endDate);
    const queried = await readState(page);
    if (queried.start_date !== startDate || queried.end_date !== endDate) {
      throw new CommandExecutionError(`Date reset after query: expected ${startDate} to ${endDate}, got ${queried.start_date || ''} to ${queried.end_date || ''}`);
    }

    return [{
      status: 'ok',
      start_date: queried.start_date,
      end_date: queried.end_date,
      total_text: queried.total_text || '',
      url: queried.url || PAGE_URL,
    }];
  },
});




