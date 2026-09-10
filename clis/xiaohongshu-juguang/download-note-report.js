import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const HOME_URL = 'https://ad.xiaohongshu.com';
const ROUTE_SWITCH_DATE = '2026-07-29';
const OLD_REPORT_URL = 'https://ad.xiaohongshu.com/aurora/ad/datareports-basic/note?vSellerId=69eb32e2f2e4280015bbdcb7';
const NEW_SWITCH_URL = 'https://ad.xiaohongshu.com/aurora/ad/manage/campaign?changeAccount=true&vSellerId=6a587f389dba8100152bd1d1';
const NEW_REPORT_URL = 'https://ad.xiaohongshu.com/aurora/ad/datareports-basic/note?vSellerId=6a587f389dba8100152bd1d1';
const REPORT_URL = NEW_REPORT_URL;
if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '600';
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOWNLOAD_BASENAME_RE = /^绗旇-鎶曟斁鏁版嵁.*\.csv$/i;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function yesterdayLocal() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatLocalDate(date);
}

function requireDate(value) {
  const date = String(value || yesterdayLocal()).trim();
  if (!DATE_RE.test(date)) {
    throw new CommandExecutionError(`date must be YYYY-MM-DD, got: ${value || ''}`);
  }
  return date;
}

function reportRouteForDate(date) {
  if (date <= ROUTE_SWITCH_DATE) {
    return { loginUrl: OLD_REPORT_URL, switchUrl: '', reportUrl: OLD_REPORT_URL };
  }
  return { loginUrl: HOME_URL, switchUrl: NEW_SWITCH_URL, reportUrl: NEW_REPORT_URL };
}

function monthKeyFromDate(date) {
  return date.slice(0, 7);
}

function addMonths(monthKey, delta) {
  const [year, month] = monthKey.split('-').map((part) => Number(part));
  const next = new Date(year, month - 1 + delta, 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
}

function compareMonthKeys(left, right) {
  return left.localeCompare(right);
}

function resolveOutputDir(value) {
  return path.resolve(String(value || '.'));
}

function downloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

function fileSnapshot(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      return { name: entry.name, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
    });
}

function findFreshDownloadedCsv(dir, sinceMs) {
  return fileSnapshot(dir)
    .filter((file) => file.mtimeMs >= sinceMs - 1000)
    .filter((file) => !file.name.endsWith('.crdownload') && !file.name.endsWith('.tmp'))
    .filter((file) => DOWNLOAD_BASENAME_RE.test(file.name) || file.name.toLowerCase().endsWith('.csv'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

async function waitForDownloadedCsv(dir, sinceMs, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let candidate = null;
  while (Date.now() < deadline) {
    const fresh = findFreshDownloadedCsv(dir, sinceMs);
    if (fresh && fresh.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const stable = findFreshDownloadedCsv(dir, sinceMs);
      if (stable && stable.path === fresh.path && stable.size === fresh.size) {
        candidate = stable;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!candidate) {
    throw new CommandExecutionError('Timed out waiting for Xiaohongshu Juguang CSV download');
  }
  return candidate;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  fs.writeFileSync(filePath, `\uFEFF${body}\r\n`, 'utf8');
}

async function readReportState(page) {
  return await page.evaluate(`(() => {
    const q = (sel) => document.querySelector(sel);
    const isDate = (value) => {
      const text = String(value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => isDate(input.value));
    const bodyText = document.body.innerText || '';
    const compactText = bodyText.replace(/\\s+/g, '');
    const countStart = bodyText.indexOf('\u5171');
    const countEnd = countStart >= 0 ? bodyText.indexOf('\u6761', countStart) : -1;
    const hasEmailPassword = Boolean(q('input[name="email"]') && q('input[name="password"]'));
    const hasLoginPrompt = compactText.includes('\u8d26\u53f7\u767b\u5f55') || compactText.includes('\u77ed\u4fe1\u767b\u5f55') || location.href.includes('login');
    return {
      url: location.href,
      title: document.title || '',
      startDate: inputs[0]?.value || '',
      endDate: inputs[1]?.value || '',
      hasLoginForm: hasEmailPassword || hasLoginPrompt,
      hasReport: bodyText.includes('\u7b14\u8bb0\u62a5\u8868') && bodyText.includes('\u6570\u636e\u660e\u7ec6'),
      rowText: countStart >= 0 && countEnd > countStart ? bodyText.slice(countStart, countEnd + 1).trim() : '',
    };
  })()`);
}

async function setInputValue(page, selector, value) {
  const result = await page.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(input, ${JSON.stringify(value)}) : (input.value = ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!result) throw new CommandExecutionError(`Input not found: ${selector}`);
}

async function clickMarked(page, marker, errorMessage) {
  const selector = `[data-opencli-${marker}]`;
  const found = await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  if (!found) throw new CommandExecutionError(errorMessage);
  await page.click(selector);
}

async function markButtonByText(page, marker, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  return await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(list)};
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-${marker}]').forEach((el) => el.removeAttribute('data-opencli-${marker}'));
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
    const target = nodes.find((el) => visible(el) && wanted.includes((el.innerText || el.textContent || '').replace(/\\s+/g, '')));
    if (!target) return false;
    const button = target.closest('button') || target;
    button.setAttribute('data-opencli-${marker}', '1');
    return true;
  })()`);
}

async function activateAccountLoginTab(page) {
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    document.querySelectorAll('[data-opencli-juguang-account-tab]').forEach((el) => el.removeAttribute('data-opencli-juguang-account-tab'));
    const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span'))
      .filter(visible)
      .sort((a, b) => textOf(a).length - textOf(b).length)
      .filter((el) => textOf(el) === '\\u8d26\\u53f7\\u767b\\u5f55');
    if (!candidates.length) return false;
    let target = candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 50 && rect.height >= 24;
    }) || candidates[0];
    if (target.getBoundingClientRect().height < 24 && target.parentElement && textOf(target.parentElement) === '\\u8d26\\u53f7\\u767b\\u5f55') {
      target = target.parentElement;
    }
    target.setAttribute('data-opencli-juguang-account-tab', '1');
    return true;
  })()`);
  if (marked) await page.click('[data-opencli-juguang-account-tab]');
  await page.wait(0.5);
}

async function ensureLoggedIn(page, email, password, entryUrl) {
  await page.goto(entryUrl);
  await page.wait(2);

  let state = await readReportState(page);
  if (state.hasReport) return;
  if (!state.hasLoginForm) return;

  await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const accountText = '\\u8d26\\u53f7\\u767b\\u5f55';
    const textOf = (el) => (el.innerText || el.textContent || '').replaceAll(' ', '').trim();
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
      .filter(visible)
      .sort((a, b) => textOf(a).length - textOf(b).length);
    const target = nodes.find((el) => textOf(el) === accountText) || nodes.find((el) => textOf(el).includes(accountText));
    if (target) {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
    }
  })()`);
  await page.wait(0.5);

  await activateAccountLoginTab(page);

  const fieldsReady = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    return visible(document.querySelector('input[name="email"]')) && visible(document.querySelector('input[name="password"]'));
  })()`);
  if (!fieldsReady) {
    for (let i = 0; i < 20; i += 1) {
      await page.wait(0.5);
      const ready = await page.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        };
        return visible(document.querySelector('input[name="email"]')) && visible(document.querySelector('input[name="password"]'));
      })()`);
      if (ready) break;
      if (i === 19) throw new CommandExecutionError('Email/password login fields did not appear');
    }
  }

  if (!email || !password) {
    throw new CommandExecutionError('Xiaohongshu Juguang login requires --email/--password or XHS_JUGUANG_EMAIL/XHS_JUGUANG_PASSWORD');
  }

  await setInputValue(page, 'input[name="email"]', email);
  await setInputValue(page, 'input[name="password"]', password);
  await page.evaluate(`(() => {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const box = boxes.find((input) => {
      const nearby = (input.closest('div')?.parentElement?.innerText || '') + (input.closest('label')?.innerText || '');
      return nearby.includes('鎴戝凡闃呰') || nearby.includes('鍚屾剰');
    }) || boxes[boxes.length - 1];
    if (box && !box.checked) box.click();
  })()`);

  const clickedLogin = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const form = document.querySelector('#login-form');
    const password = document.querySelector('input[name="password"]');
    const passwordRect = password?.getBoundingClientRect();
    const root = form?.parentElement?.parentElement?.parentElement || document;
    const buttons = Array.from(root.querySelectorAll('button')).filter(visible);
    const loginText = '\\u767b\\u5f55';
    const target = buttons.find((button) => {
      const text = (button.innerText || button.textContent || '').replaceAll(' ', '');
      if (!text.includes(loginText)) return false;
      if (!passwordRect) return true;
      const rect = button.getBoundingClientRect();
      return rect.top > passwordRect.bottom - 8 && Math.abs((rect.left + rect.right) / 2 - (passwordRect.left + passwordRect.right) / 2) < 240;
    }) || buttons.find((button) => (button.innerText || button.textContent || '').replaceAll(' ', '').includes(loginText)) || buttons[0];
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clickedLogin) throw new CommandExecutionError('Login button not found');

  const marked = await markButtonByText(page, 'juguang-submit-login', '鐧诲綍');
  if (marked) await clickMarked(page, 'juguang-submit-login', 'Login button not found');

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.wait(1);
    state = await readReportState(page);
    if (!state.hasLoginForm && !state.url.includes('/login')) return;
    const text = await page.evaluate(`document.body.innerText || ''`);
    if (/婊戝潡|瀹夊叏楠岃瘉|椋庨櫓楠岃瘉/.test(text)) {
      throw new CommandExecutionError('Login requires manual verification; complete it in Chrome and rerun the command');
    }
  }
  throw new CommandExecutionError('Login did not finish within 60 seconds');
}

async function ensureReportPage(page, reportUrl) {
  await page.goto(reportUrl);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await readReportState(page).catch(() => ({}));
    if (state.hasReport) return;
    if (state.hasLoginForm) throw new CommandExecutionError('Login page is still visible after login attempt');
    await page.wait(0.7);
  }
  throw new CommandExecutionError('Report page did not load');
}

async function switchAccountIfNeeded(page, switchUrl) {
  if (!switchUrl) return;
  await page.goto(switchUrl);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await readReportState(page).catch(() => ({}));
    if (state.hasLoginForm) throw new CommandExecutionError('Login page is still visible while switching account');
    if (state.url && !state.url.includes('/login')) return;
    await page.wait(0.7);
  }
  throw new CommandExecutionError('Account switch page did not finish loading');
}

async function openDatePicker(page) {
  await page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => /^20\\d{2}-\\d{2}-\\d{2}$/.test(input.value || ''));
    inputs[0]?.click();
  })()`);
  try {
    await page.wait({ selector: '.d-datepicker-cell, .d-ranges', timeout: 8000 });
  } catch {
    throw new CommandExecutionError('Date picker did not open');
  }
}

async function clickYesterdayShortcut(page) {
  const marked = await markButtonByText(page, 'juguang-yesterday', ['鏄ㄥぉ', '鏄ㄦ棩']);
  if (!marked) return false;
  await clickMarked(page, 'juguang-yesterday', 'Yesterday shortcut not found');
  await page.wait(1.5);
  return true;
}

async function setDateInputsDirect(page, date) {
  const changed = await page.evaluate(`(() => {
    const isDateInput = (input) => {
      const text = String(input.value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter(isDateInput);
    if (inputs.length < 2) return false;
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      input.blur();
    };
    setValue(inputs[0], ${JSON.stringify(date)});
    setValue(inputs[1], ${JSON.stringify(date)});
    document.body.click();
    return true;
  })()`);
  if (!changed) return false;

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await page.wait(0.5);
    const state = await readReportState(page).catch(() => ({}));
    if (state.startDate === date && state.endDate === date) return true;
  }
  return false;
}

async function markVisibleDateCell(page, marker, date, allowVisibleFallback = false) {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  const fallbackSameLocalMonth = date.slice(0, 7) === formatLocalDate(new Date()).slice(0, 7);
  return await page.evaluate(`(() => {
    const wanted = { year: ${year}, month: ${month}, day: ${day} };
    const fallbackSameLocalMonth = ${JSON.stringify(fallbackSameLocalMonth)};
    const allowVisibleFallback = ${JSON.stringify(allowVisibleFallback)};
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-${marker}]').forEach((el) => el.removeAttribute('data-opencli-${marker}'));
    const headings = Array.from(document.querySelectorAll('h6')).filter(visible);
    const panels = [];
    for (let i = 0; i < headings.length - 1; i += 1) {
      const y = Number((headings[i].innerText || '').replace(/\\D/g, ''));
      const m = Number((headings[i + 1].innerText || '').replace(/\\D/g, ''));
      if (!y || !m) continue;
      const yr = headings[i].getBoundingClientRect();
      const mr = headings[i + 1].getBoundingClientRect();
      panels.push({ year: y, month: m, left: Math.min(yr.left, mr.left) - 160, right: Math.max(yr.right, mr.right) + 160 });
    }
    const cells = Array.from(document.querySelectorAll('.d-datepicker-cell.d-clickable')).filter(visible);
    for (const cell of cells) {
      if ((cell.innerText || cell.textContent || '').trim() !== String(wanted.day)) continue;
      if (String(cell.className || '').includes('disabled')) continue;
      const rect = cell.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const panel = panels.find((p) => cx >= p.left && cx <= p.right && p.year === wanted.year && p.month === wanted.month);
      if (!panel) continue;
      cell.setAttribute('data-opencli-${marker}', '1');
      return true;
    }
    const currentInput = Array.from(document.querySelectorAll('input.d-text'))
      .find((input) => /^20\\d{2}-\\d{2}-\\d{2}$/.test(input.value || ''));
    const current = String(currentInput?.value || '');
    const wantedMonthText = String(wanted.year) + '-' + String(wanted.month).padStart(2, '0');
    if (current.slice(0, 7) === wantedMonthText || (!current && fallbackSameLocalMonth) || allowVisibleFallback) {
      const candidates = cells.filter((cell) => {
        const text = (cell.innerText || cell.textContent || '').trim();
        const className = String(cell.className || '');
        return text === String(wanted.day) && !className.includes('disabled');
      });
      const target = candidates.find((cell) => !/prev|next|outside|other/i.test(String(cell.className || ''))) || candidates[0];
      if (target) {
        target.setAttribute('data-opencli-${marker}', '1');
        return true;
      }
    }
    return false;
  })()`);
}

async function inferPickerMonth(page) {
  return await page.evaluate(`(() => {
    const currentInput = Array.from(document.querySelectorAll('input.d-text'))
      .find((input) => /^20\\d{2}-\\d{2}-\\d{2}$/.test(input.value || ''));
    return String(currentInput?.value || '').slice(0, 7);
  })()`);
}

async function clickPickerNav(page, direction) {
  const moved = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const direction = ${direction};
    const spans = Array.from(document.querySelectorAll('span')).filter(visible);
    const icons = spans.filter((span) => span.querySelector('svg'));
    let target = direction < 0 ? icons[0] : icons[3] || icons[icons.length - 1];
    if (!target) {
      const cells = Array.from(document.querySelectorAll('.d-datepicker-cell')).filter(visible);
      if (!cells.length) return false;
      const rects = cells.map((cell) => cell.getBoundingClientRect());
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      const top = Math.min(...rects.map((rect) => rect.top));
      const pointX = direction < 0 ? left + 24 : right - 24;
      const pointY = top - 34;
      target = document.elementFromPoint(pointX, pointY);
      while (target && target !== document.body && !target.querySelector?.('svg') && target.tagName !== 'BUTTON') {
        target = target.parentElement;
      }
    }
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!moved) throw new CommandExecutionError(`Could not navigate date picker ${direction < 0 ? 'backward' : 'forward'}`);
  await page.wait(0.4);
}

async function chooseSingleDate(page, date) {
  await openDatePicker(page);
  const targetMonth = monthKeyFromDate(date);
  let cursorMonth = await inferPickerMonth(page);
  if (!/^\d{4}-\d{2}$/.test(cursorMonth || '')) {
    cursorMonth = formatLocalDate(new Date()).slice(0, 7);
  }
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const allowVisibleFallback = cursorMonth === targetMonth;
    const marked = await markVisibleDateCell(page, 'juguang-date-cell', date, allowVisibleFallback);
    if (marked) {
      await clickMarked(page, 'juguang-date-cell', `Date cell not found: ${date}`);
      await page.wait(0.5);
      const markedAgain = await markVisibleDateCell(page, 'juguang-date-cell', date, true);
      if (!markedAgain) return;
      await clickMarked(page, 'juguang-date-cell', `Date cell not found for end date: ${date}`);
      await page.wait(1.2);
      return;
    }
    const monthCompare = compareMonthKeys(targetMonth, cursorMonth);
    if (monthCompare === 0) break;
    const direction = monthCompare > 0 ? 1 : -1;
    await clickPickerNav(page, direction);
    cursorMonth = addMonths(cursorMonth, direction);
  }
  throw new CommandExecutionError(`Date not found in picker: ${date}`);
}

async function selectDate(page, date) {
  if (await setDateInputsDirect(page, date)) return;

  const yesterday = yesterdayLocal();
  if (date === yesterday) {
    await openDatePicker(page);
    if (await clickYesterdayShortcut(page)) return;
    await page.evaluate(`document.body.click()`);
    await page.wait(0.3);
  }
  await chooseSingleDate(page, date);
}

async function waitForReportDate(page, date) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await readReportState(page);
    if (state.startDate === date && state.endDate === date && state.hasReport) return state;
    await page.wait(0.7);
  }
  const state = await readReportState(page).catch(() => ({}));
  throw new CommandExecutionError(`Report did not switch to ${date}; current range is ${state.startDate || ''} to ${state.endDate || ''}`);
}

async function markDownloadButton(page, date) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-juguang-download]').forEach((el) => el.removeAttribute('data-opencli-juguang-download'));
    const card = Array.from(document.querySelectorAll('.page-card')).filter((el) => (el.innerText || '').includes('鏁版嵁鏄庣粏')).pop();
    const cards = Array.from(document.querySelectorAll('.page-card')).filter(visible);
    const detailCard = cards.find((el) => el.querySelector('.report-table') || (el.innerText || '').includes(${JSON.stringify(date)}));
    const selectedCard = detailCard || card;
    if (!selectedCard) return false;
    const buttons = Array.from(selectedCard.querySelectorAll('button')).filter(visible);
    const headerButtons = buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      const cardRect = selectedCard.getBoundingClientRect();
      return rect.top < cardRect.top + 120 && rect.left > cardRect.left + cardRect.width * 0.55;
    }).sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const target = headerButtons[0] || buttons[0];
    if (!target) return false;
    target.setAttribute('data-opencli-juguang-download', '1');
    return true;
  })()`);
}

async function confirmExportDialog(page) {
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-juguang-export-confirm]').forEach((el) => el.removeAttribute('data-opencli-juguang-export-confirm'));
    const app = document.querySelector('#app');
    const overlays = Array.from(document.body.children).filter((el) => visible(el) && (!app || !el.contains(app)));
    const labels = ['\\u4e0b\\u8f7d', '\\u786e\\u5b9a', '\\u5bfc\\u51fa'];
    for (const root of overlays) {
      const buttons = Array.from(root.querySelectorAll('button, [role="button"], .d-button')).filter(visible);
      const target = buttons.reverse().find((button) => labels.some((label) => (button.innerText || button.textContent || '').includes(label)));
      if (target) {
        target.setAttribute('data-opencli-juguang-export-confirm', '1');
        return true;
      }
    }
    return false;
  })()`);
  if (!marked) return false;
  await page.evaluate(`(() => {
    const button = document.querySelector('[data-opencli-juguang-export-confirm]');
    if (button) button.click();
  })()`);
  await page.wait(0.5);
  return true;
}

async function downloadReport(page, date, outputDir) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.wait(0.5);
  const marked = await markDownloadButton(page, date);
  if (!marked) throw new CommandExecutionError('Data detail download button not found');

  fs.mkdirSync(outputDir, { recursive: true });
  const startedAt = Date.now();
  const clicked = await page.evaluate(`(() => {
    const button = document.querySelector('[data-opencli-juguang-download]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new CommandExecutionError('Data detail download button not found');
  await page.wait(0.5);
  await confirmExportDialog(page);
  const targetPath = path.join(outputDir, `${date}\u805a\u5149.csv`);
  let downloaded = null;
  try {
    downloaded = await waitForDownloadedCsv(downloadsDir(), startedAt, 90000);
  } catch {
    throw new CommandExecutionError('Timed out waiting for Xiaohongshu Juguang CSV download');
  }
  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  fs.copyFileSync(downloaded.path, targetPath);
  try {
    fs.unlinkSync(downloaded.path);
  } catch {
    // Chrome may still hold the file briefly; the copied target is already complete.
  }
  return targetPath;
}

async function logout(page) {
  await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replaceAll(' ', '').trim();
    const topbar = document.querySelector('#topbar-new-box') || document;
    const buttons = Array.from(topbar.querySelectorAll('button')).filter(visible);
    const newAdText = '\u65b0\u5efa\u5e7f\u544a';
    const newAdIndex = buttons.findIndex((button) => textOf(button).includes(newAdText));
    const account = newAdIndex > 0 ? buttons[newAdIndex - 1] : buttons.find((button) => textOf(button) && !textOf(button).includes(newAdText));
    if (account) {
      account.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      account.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      account.click();
    }
  })()`);
  await page.wait(0.8);
  await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const labels = ['\u767b\u51fa', '\u9000\u51fa\u767b\u5f55'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span')).filter(visible);
    const target = nodes.sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length)
      .find((el) => labels.some((label) => (el.innerText || el.textContent || '').replaceAll(' ', '').includes(label)));
    if (target) target.click();
  })()`);
  await page.wait(0.8);
}

cli({
  site: 'xiaohongshu-juguang',
  name: 'download-note-report',
  description: 'Download Xiaohongshu Juguang Data > Standard > Note Report CSV for one date and log out.',
  access: 'read',
  example: 'opencli xiaohongshu-juguang download-note-report --date 2026-08-05 --output . --site-session persistent --keep-tab false --window foreground -f yaml',
  domain: 'ad.xiaohongshu.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'date', type: 'string', default: '', help: 'Report date, YYYY-MM-DD. Defaults to yesterday.' },
    { name: 'email', type: 'string', default: '', help: 'Login email. Defaults to XHS_JUGUANG_EMAIL.' },
    { name: 'password', type: 'string', default: '', help: 'Login password. Defaults to XHS_JUGUANG_PASSWORD.' },
    { name: 'output', type: 'string', default: '.', help: 'Directory for YYYY-MM-DD鑱氬厜.csv.' },
    { name: 'timeout', type: 'int', default: 600, help: 'Max seconds for the overall command (default: 600).' },
  ],
  columns: ['status', 'date', 'file', 'rows', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu-juguang download-note-report');

    const date = requireDate(kwargs.date);
    const route = reportRouteForDate(date);
    const email = String(kwargs.email || process.env.XHS_JUGUANG_EMAIL || '').trim();
    const password = String(kwargs.password || process.env.XHS_JUGUANG_PASSWORD || '');
    const outputDir = resolveOutputDir(kwargs.output);

    try {
      await ensureLoggedIn(page, email, password, route.loginUrl);
      await switchAccountIfNeeded(page, route.switchUrl);
      await ensureReportPage(page, route.reportUrl);
      await selectDate(page, date);
      const state = await waitForReportDate(page, date);
      const file = await downloadReport(page, date, outputDir);

      return [{
        status: 'ok',
        date,
        file,
        rows: state.rowText || '',
        url: state.url || route.reportUrl,
      }];
    } finally {
      await logout(page).catch(() => {});
    }
  },
});
