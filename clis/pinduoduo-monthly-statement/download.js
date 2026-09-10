import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_HOME_URL = 'https://mms.pinduoduo.com/home';
const DEFAULT_BILLS_URL = 'https://cashier.pinduoduo.com/main/bills?tab=4001&__app_code=113';
const DEFAULT_HISTORY_URL = 'https://cashier.pinduoduo.com/main/bills/export-history?tab=4001&__app_code=113';
const DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '900';
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function previousMonthRange() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), 0, 12, 0, 0, 0);
  const start = new Date(end.getFullYear(), end.getMonth(), 1, 12, 0, 0, 0);
  return { startDate: formatLocalDate(start), endDate: formatLocalDate(end) };
}

const DEFAULT_RANGE = previousMonthRange();

function argument(kwargs, kebabName, camelName) {
  return kwargs?.[camelName] ?? kwargs?.[kebabName];
}

function stringArg(value, envName, defaultValue = '') {
  return String(value || process.env[envName] || defaultValue).trim();
}

function positiveInt(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  return result;
}

function booleanArg(value, defaultValue, label) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new ArgumentError(`${label} must be true or false`);
}

function validDate(value, label) {
  const result = String(value || '').trim();
  if (!DATE_RE.test(result)) throw new ArgumentError(`${label} must use YYYY-MM-DD`);
  const [year, month, day] = result.split('-').map(Number);
  const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (formatLocalDate(parsed) !== result) throw new ArgumentError(`${label} is not a valid calendar date`);
  return result;
}

function pinduoduoUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new ArgumentError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ArgumentError(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.hostname !== 'pinduoduo.com' && !parsed.hostname.endsWith('.pinduoduo.com')) {
    throw new ArgumentError(`${label} must point to pinduoduo.com`);
  }
  return parsed.href;
}

function sanitizeFilePart(value, label) {
  const result = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!result) throw new ArgumentError(`${label} cannot be empty or only contain invalid filename characters`);
  return result;
}

async function nativeClickSelector(page, selector, errorMessage) {
  const point = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new CommandExecutionError(errorMessage);
  try {
    if (typeof page.nativeClick === 'function') await page.nativeClick(point.x, point.y);
    else await page.click(selector);
  } catch (error) {
    throw new CommandExecutionError(`${errorMessage}: ${error?.message || error}`);
  }
}

async function markExactText(page, marker, texts, selectors = 'button, [role="button"], a, div, span') {
  const wanted = Array.isArray(texts) ? texts : [texts];
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    const wanted = ${JSON.stringify(wanted)};
    const attr = ${JSON.stringify(`data-opencli-${marker}`)};
    document.querySelectorAll('[' + attr + ']').forEach((el) => el.removeAttribute(attr));
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selectors)}))
      .filter(visible)
      .sort((a, b) => textOf(a).length - textOf(b).length);
    let target = nodes.find((el) => wanted.includes(textOf(el)));
    if (!target) return false;
    target = target.closest('button, [role="button"], a') || target;
    target.setAttribute(attr, '1');
    return true;
  })()`);
}

async function clickExactText(page, marker, texts, errorMessage, selectors) {
  const marked = await markExactText(page, marker, texts, selectors);
  if (!marked) throw new CommandExecutionError(errorMessage);
  await nativeClickSelector(page, `[data-opencli-${marker}="1"]`, errorMessage);
}

async function homeSnapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const body = document.body?.innerText || '';
    const storeText = (el) => (el?.getAttribute('title') || el?.textContent || '').trim();
    const merchantHeaderStore = Array.from(document.querySelectorAll('#mms-header-next span[title]')).find(visible);
    const fallbackStore = Array.from(document.querySelectorAll('header span[title], span[title]'))
      .filter(visible)
      .find((el) => !/TEMU入驻|课程|规则|帮助/.test(storeText(el)));
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(visible);
    return {
      url: location.href,
      title: document.title || '',
      body,
      loggedIn: Boolean(document.querySelector('#mms-header-next'))
        || (body.includes('商家后台') && (body.includes('退出当前账号') || body.includes('后台首页'))),
      storeName: storeText(merchantHeaderStore) || storeText(fallbackStore),
      accountLoginVisible: Array.from(document.querySelectorAll('button, [role="button"], div, span'))
        .some((el) => visible(el) && (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '账号登录'),
      loginFormVisible: visibleInputs.some((el) => el.type === 'password'),
      verificationVisible: /验证码|安全验证|请完成验证|拖动滑块|滑块验证/.test(body),
    };
  })()`);
}

async function fillLoginForm(page, account, password) {
  const result = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
    if (!passwordInput) return { ok: false, reason: 'password input not found' };
    let root = passwordInput.closest('form');
    if (!root) {
      root = passwordInput.parentElement;
      for (let depth = 0; root?.parentElement && depth < 5; depth += 1) {
        if (root.querySelectorAll('input').length >= 2 && root.querySelectorAll('button, [role="button"]').length > 0) break;
        root = root.parentElement;
      }
    }
    const inputs = Array.from((root || document).querySelectorAll('input')).filter(visible);
    const accountInput = inputs.find((el) => el !== passwordInput && /账号|手机号|手机号码|用户名|邮箱/.test(el.placeholder || ''))
      || inputs.find((el) => el !== passwordInput && ['text', 'tel', 'email', ''].includes(el.type || ''));
    if (!accountInput) return { ok: false, reason: 'account input not found' };
    const set = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(input, value) : (input.value = value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    set(accountInput, ${JSON.stringify(account)});
    set(passwordInput, ${JSON.stringify(password)});
    document.querySelectorAll('[data-opencli-pdd-login-submit]').forEach((el) => el.removeAttribute('data-opencli-pdd-login-submit'));
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    const button = Array.from((root || document).querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find((el) => textOf(el) === '登录');
    if (!button) return { ok: false, reason: 'login button not found' };
    button.setAttribute('data-opencli-pdd-login-submit', '1');
    return {
      ok: accountInput.value === ${JSON.stringify(account)} && passwordInput.value === ${JSON.stringify(password)},
      reason: 'input verification failed',
    };
  })()`);
  if (!result.ok) throw new CommandExecutionError(`Could not fill Pinduoduo account login form: ${result.reason}`);
  await nativeClickSelector(page, '[data-opencli-pdd-login-submit="1"]', 'Pinduoduo Login button was not clickable');
}

async function ensureLoggedIn(page, homeUrl, account, password, loginTimeoutSeconds) {
  await page.goto(homeUrl);
  const initialDeadline = Date.now() + 30000;
  let state = await homeSnapshot(page);
  while (Date.now() < initialDeadline && !state.loggedIn && !state.accountLoginVisible && !state.loginFormVisible) {
    await page.wait(0.5);
    state = await homeSnapshot(page);
  }
  if (state.loggedIn) return state;

  if (!account || !password) {
    throw new AuthRequiredError(
      'mms.pinduoduo.com',
      'Pinduoduo is not logged in; pass --account and --password (or PINDUODUO_ACCOUNT / PINDUODUO_PASSWORD), or log in manually with the same OpenCLI profile',
    );
  }

  if (state.accountLoginVisible) {
    await clickExactText(page, 'pdd-account-login', '账号登录', 'Pinduoduo account-login entry was not clickable');
    await page.wait(0.5);
  }

  const formDeadline = Date.now() + 15000;
  state = await homeSnapshot(page);
  while (Date.now() < formDeadline && !state.loginFormVisible) {
    await page.wait(0.5);
    state = await homeSnapshot(page);
  }
  if (!state.loginFormVisible) throw new CommandExecutionError('Pinduoduo account/password login form did not appear');

  await fillLoginForm(page, account, password);
  const loginDeadline = Date.now() + loginTimeoutSeconds * 1000;
  while (Date.now() < loginDeadline) {
    await page.wait(1);
    state = await homeSnapshot(page);
    if (state.loggedIn) return state;
    if (state.verificationVisible) {
      process.stderr.write('Pinduoduo login requires a visible verification step; complete it in the browser window.\n');
    }
  }
  if (state.verificationVisible) throw new TimeoutError('Pinduoduo manual verification and login', loginTimeoutSeconds);
  throw new AuthRequiredError('mms.pinduoduo.com', 'Pinduoduo account login did not reach the authenticated merchant home page');
}

function assertStore(expectedStoreName, actualStoreName) {
  if (!expectedStoreName || !actualStoreName) return;
  if (actualStoreName === expectedStoreName || actualStoreName.includes(expectedStoreName) || expectedStoreName.includes(actualStoreName)) return;
  throw new CommandExecutionError(
    `Logged-in Pinduoduo store mismatch: expected "${expectedStoreName}", current store is "${actualStoreName}"`,
  );
}

async function waitForBillsPage(page, billsUrl, timeoutSeconds) {
  await page.goto(billsUrl);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => ({
      url: location.href,
      title: document.title || '',
      body: document.body?.innerText || '',
      detailTab: Boolean(document.querySelector('#balance-detail')),
      dateInput: Boolean(document.querySelector('[data-testid="beast-core-rangePicker-htmlInput"]')),
      exportButton: Boolean(document.querySelector('#exportBalance-btn')),
      storeName: Array.from(document.querySelectorAll('span[title]'))
        .map((el) => (el.getAttribute('title') || el.textContent || '').trim()).find(Boolean) || '',
    }))()`);
    if (state.detailTab && state.dateInput && state.exportButton) return state;
    if (/登录|账号登录/.test(state.body) || /\/login(?:[/?#]|$)/i.test(state.url)) {
      throw new AuthRequiredError('cashier.pinduoduo.com', 'Pinduoduo Cashier redirected to login');
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Pinduoduo 货款明细 page', timeoutSeconds);
}

async function pickerState(page) {
  return await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]');
    if (!root) return null;
    const headers = Array.from(root.querySelectorAll('[data-testid="beast-core-monthRangePicker-year-header"]'));
    const monthOf = (header) => Number(
      Array.from(header?.querySelectorAll('span') || [])
        .map((el) => (el.textContent || '').trim())
        .find((text) => /^\\d{1,2}月$/.test(text))
        ?.match(/\\d{1,2}/)?.[0] || 0,
    );
    const yearOf = (header) => Number((header?.querySelector('[data-testid="beast-core-select-htmlInput"]')?.value || '').match(/\\d{4}/)?.[0] || 0);
    return {
      left: { year: yearOf(headers[0]), month: monthOf(headers[0]) },
      right: { year: yearOf(headers[1]), month: monthOf(headers[1]) },
    };
  })()`);
}

async function openDatePicker(page) {
  await page.pressKey('Escape').catch(() => {});
  await page.wait(0.2);
  await nativeClickSelector(
    page,
    '[data-testid="beast-core-rangePicker-htmlInput"]',
    'Pinduoduo date range input was not clickable',
  );
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await pickerState(page);
    if (state?.left?.year && state?.left?.month) return state;
    await page.wait(0.2);
  }
  throw new CommandExecutionError('Pinduoduo date range picker did not open');
}

async function navigatePickerToMonth(page, startDate) {
  const [targetYear, targetMonth] = startDate.split('-').map(Number);
  const targetIndex = targetYear * 12 + targetMonth - 1;
  let state = await pickerState(page);
  if (!state?.left?.year || !state?.left?.month) throw new CommandExecutionError('Date picker month header was unreadable');
  let currentIndex = state.left.year * 12 + state.left.month - 1;
  const distance = targetIndex - currentIndex;
  if (Math.abs(distance) > 120) throw new ArgumentError('start-date is more than 120 months from the currently displayed month');

  for (let step = 0; step < Math.abs(distance); step += 1) {
    const selector = distance < 0
      ? '[data-testid="beast-core-rangePicker-dropdown-contentRoot"] [data-testid="beast-core-icon-left"]'
      : '[data-testid="beast-core-rangePicker-dropdown-contentRoot"] [data-testid="beast-core-icon-right"]';
    const previous = currentIndex;
    await nativeClickSelector(page, selector, `Could not navigate the date picker toward ${startDate.slice(0, 7)}`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await page.wait(0.15);
      state = await pickerState(page);
      currentIndex = state?.left?.year * 12 + state?.left?.month - 1;
      if (Number.isInteger(currentIndex) && currentIndex !== previous) break;
    }
    if (currentIndex === previous) throw new CommandExecutionError('Date picker navigation did not change the displayed month');
  }
  if (currentIndex !== targetIndex) {
    throw new CommandExecutionError(`Date picker showed ${state?.left?.year || '?'}-${state?.left?.month || '?'} instead of ${startDate.slice(0, 7)}`);
  }
}

async function selectPickerDay(page, date, marker) {
  const day = Number(date.slice(-2));
  const marked = await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]');
    const table = root?.querySelectorAll('[data-testid="beast-core-rangePicker-table"]')?.[0];
    if (!table) return false;
    const attr = ${JSON.stringify(`data-opencli-${marker}`)};
    document.querySelectorAll('[' + attr + ']').forEach((el) => el.removeAttribute(attr));
    const target = Array.from(table.querySelectorAll('[role="date-cell"]')).find((cell) => {
      const className = String(cell.className || '');
      const value = cell.querySelector('[title]')?.getAttribute('title') || (cell.textContent || '').trim();
      return Number(value) === ${day} && !/outOfMonth|disabled/i.test(className);
    });
    if (!target) return false;
    target.setAttribute(attr, '1');
    return true;
  })()`);
  if (!marked) throw new CommandExecutionError(`Selectable date ${date} was not found in the Pinduoduo date picker`);
  await nativeClickSelector(page, `[data-opencli-${marker}="1"]`, `Date ${date} was not clickable`);
  await page.wait(0.2);
}

async function setDateRange(page, startDate, endDate) {
  if (startDate.slice(0, 7) !== endDate.slice(0, 7)) {
    throw new ArgumentError('start-date and end-date must be in the same calendar month for a monthly statement');
  }
  const expected = `${startDate} 00:00:00 ~ ${endDate} 23:59:59`;
  const result = await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const input = document.querySelector('[data-testid="beast-core-rangePicker-htmlInput"]');
    if (!input) return { ok: false, reason: 'date range input not found', actual: '' };
    input.click();

    let root = null;
    const openDeadline = Date.now() + 10000;
    while (Date.now() < openDeadline) {
      root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]');
      if (root) break;
      await sleep(100);
    }
    if (!root) return { ok: false, reason: 'date picker did not open', actual: input.value || '' };

    const readLeftMonth = () => {
      const header = root.querySelector('[data-testid="beast-core-monthRangePicker-year-header"]');
      const year = Number((header?.querySelector('[data-testid="beast-core-select-htmlInput"]')?.value || '').match(/\\d{4}/)?.[0] || 0);
      const monthText = Array.from(header?.querySelectorAll('span') || [])
        .map((el) => (el.textContent || '').trim())
        .find((text) => /^\\d{1,2}月$/.test(text)) || '';
      const month = Number(monthText.match(/\\d{1,2}/)?.[0] || 0);
      return { year, month, index: year * 12 + month - 1 };
    };

    const targetYear = ${Number(startDate.slice(0, 4))};
    const targetMonth = ${Number(startDate.slice(5, 7))};
    const targetIndex = targetYear * 12 + targetMonth - 1;
    let shown = readLeftMonth();
    if (!shown.year || !shown.month) return { ok: false, reason: 'date picker month header was unreadable', actual: input.value || '' };
    const distance = targetIndex - shown.index;
    if (Math.abs(distance) > 120) return { ok: false, reason: 'target month is more than 120 months away', actual: input.value || '' };

    for (let step = 0; step < Math.abs(distance); step += 1) {
      const selector = distance < 0 ? '[data-testid="beast-core-icon-left"]' : '[data-testid="beast-core-icon-right"]';
      const control = root.querySelector(selector);
      if (!control) return { ok: false, reason: 'date picker navigation control not found', actual: input.value || '' };
      const previous = shown.index;
      control.click();
      const navigationDeadline = Date.now() + 5000;
      while (Date.now() < navigationDeadline) {
        await sleep(100);
        root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]') || root;
        shown = readLeftMonth();
        if (shown.index !== previous) break;
      }
      if (shown.index === previous) return { ok: false, reason: 'date picker navigation did not change month', actual: input.value || '' };
    }
    if (shown.index !== targetIndex) return { ok: false, reason: 'date picker reached the wrong month', actual: input.value || '' };

    const clickDay = async (day) => {
      root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]') || root;
      const table = root.querySelectorAll('[data-testid="beast-core-rangePicker-table"]')?.[0];
      const cell = Array.from(table?.querySelectorAll('[role="date-cell"]') || []).find((candidate) => {
        const className = String(candidate.className || '');
        const value = candidate.querySelector('[title]')?.getAttribute('title') || (candidate.textContent || '').trim();
        return Number(value) === day && !/outOfMonth|disabled/i.test(className);
      });
      if (!cell) return false;
      cell.click();
      await sleep(300);
      return true;
    };

    if (!await clickDay(${Number(startDate.slice(-2))})) return { ok: false, reason: 'start day not found', actual: input.value || '' };
    if (!await clickDay(${Number(endDate.slice(-2))})) return { ok: false, reason: 'end day not found', actual: input.value || '' };

    root = document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]') || root;
    const confirm = Array.from(root.querySelectorAll('button')).find((button) =>
      (button.innerText || button.textContent || '').replace(/\\s+/g, '').trim() === '确认'
    );
    if (!confirm) return { ok: false, reason: 'date range Confirm button not found', actual: input.value || '' };
    confirm.click();

    const expected = ${JSON.stringify(expected)};
    const valueDeadline = Date.now() + 10000;
    while (Date.now() < valueDeadline) {
      if (input.value === expected && !document.querySelector('[data-testid="beast-core-rangePicker-dropdown-contentRoot"]')) {
        return { ok: true, actual: input.value };
      }
      await sleep(100);
    }
    return { ok: false, reason: 'confirmed value or picker-close state did not stabilize', actual: input.value || '' };
  })()`);
  if (!result.ok) {
    throw new CommandExecutionError(`Could not set Pinduoduo date range: ${result.reason}; actual="${result.actual || ''}"`);
  }
  return expected;
}

async function querySnapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const body = document.body?.innerText || '';
    const table = Array.from(document.querySelectorAll('[data-testid="beast-core-table"]')).find(visible);
    const tableText = (table?.innerText || table?.textContent || '').replace(/\\s+/g, ' ').trim();
    const paginationText = Array.from(document.querySelectorAll('[data-testid="beast-core-pagination"]'))
      .filter(visible).map((el) => el.innerText || el.textContent || '').join(' ');
    const rowCountMatch = paginationText.match(/共有\\s*(\\d+)\\s*条/);
    const loading = Array.from(document.querySelectorAll('[data-testid="beast-core-spin"]')).some(visible);
    const noData = /暂无数据|暂无账单|无符合条件/.test(tableText || body);
    return {
      url: location.href,
      body,
      rowCount: rowCountMatch ? Number(rowCountMatch[1]) : (noData ? 0 : null),
      noData,
      loading,
      fingerprint: JSON.stringify({ rowCount: rowCountMatch?.[1] || '', noData, tableText: tableText.slice(0, 800) }),
    };
  })()`);
}

async function runQuery(page, queryTimeoutSeconds) {
  const before = await querySnapshot(page);
  await clickExactText(page, 'pdd-query', '查询', 'Pinduoduo Query button was not found', 'button');
  await page.wait(2);
  const deadline = Date.now() + queryTimeoutSeconds * 1000;
  let previousFingerprint = '';
  let stableSamples = 0;
  let latest = before;
  while (Date.now() < deadline) {
    latest = await querySnapshot(page);
    if (/登录|账号登录/.test(latest.body) || /\/login(?:[/?#]|$)/i.test(latest.url)) {
      throw new AuthRequiredError('cashier.pinduoduo.com', 'Pinduoduo Cashier authentication expired during query');
    }
    if (!latest.loading && latest.fingerprint === previousFingerprint) stableSamples += 1;
    else stableSamples = 0;
    previousFingerprint = latest.fingerprint;
    if (!latest.loading && stableSamples >= 1) return latest;
    await page.wait(0.5);
  }
  throw new TimeoutError('Pinduoduo statement query result', queryTimeoutSeconds);
}

async function submitExport(page) {
  await nativeClickSelector(page, '#exportBalance-btn', 'Pinduoduo Export button was not clickable');
  await page.wait(0.5);
  const dialogState = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="modal"], [data-testid*="dialog"]')).filter(visible);
    const dialog = dialogs.find((el) => /导出/.test(el.innerText || el.textContent || ''));
    if (!dialog) return { appeared: false, confirmReady: false };
    document.querySelectorAll('[data-opencli-pdd-export-confirm]').forEach((el) => el.removeAttribute('data-opencli-pdd-export-confirm'));
    const button = Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(visible)
      .find((el) => ['确认', '确定'].includes((el.innerText || el.textContent || '').replace(/\\s+/g, '').trim()));
    if (button) button.setAttribute('data-opencli-pdd-export-confirm', '1');
    return { appeared: true, confirmReady: Boolean(button) };
  })()`);
  if (dialogState.appeared && !dialogState.confirmReady) {
    throw new CommandExecutionError('Pinduoduo export confirmation dialog appeared without a Confirm button');
  }
  if (dialogState.confirmReady) {
    await nativeClickSelector(page, '[data-opencli-pdd-export-confirm="1"]', 'Export confirmation button was not clickable');
  }
  await page.wait(1);
}

async function waitForHistoryDownload(page, historyUrl, startDate, endDate, timeoutSeconds) {
  await page.goto(historyUrl);
  const startText = `${startDate} 00:00:00`;
  const endText = `${endDate} 23:59:59`;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let matchingSeen = false;
  let samples = 0;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const startText = ${JSON.stringify(startText)};
      const endText = ${JSON.stringify(endText)};
      document.querySelectorAll('[data-opencli-pdd-download-target]').forEach((el) => el.removeAttribute('data-opencli-pdd-download-target'));
      let matchingSeen = false;
      let matchingText = '';
      const buttons = Array.from(document.querySelectorAll('button[id^="downloadBalance-btn-"]')).filter(visible);
      for (const button of buttons) {
        let root = button.parentElement;
        for (let depth = 0; root && depth < 9; depth += 1, root = root.parentElement) {
          const text = (root.innerText || root.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text.includes('账单申请时间') && text.includes(startText) && text.includes(endText)) {
            matchingSeen = true;
            matchingText = text.slice(0, 500);
            button.setAttribute('data-opencli-pdd-download-target', '1');
            return { ready: true, matchingSeen, matchingText, url: location.href, body: document.body?.innerText || '' };
          }
        }
      }
      const nodes = Array.from(document.querySelectorAll('div')).filter(visible);
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text.length < 1000 && text.includes('账单申请时间') && text.includes(startText) && text.includes(endText)) {
          matchingSeen = true;
          matchingText = text.slice(0, 500);
          break;
        }
      }
      return { ready: false, matchingSeen, matchingText, url: location.href, body: document.body?.innerText || '' };
    })()`);
    if (state.ready) return state;
    matchingSeen ||= state.matchingSeen;
    if (/登录|账号登录/.test(state.body) || /\/login(?:[/?#]|$)/i.test(state.url)) {
      throw new AuthRequiredError('cashier.pinduoduo.com', 'Pinduoduo Cashier authentication expired while waiting for export history');
    }
    samples += 1;
    if (samples % 5 === 0) await page.goto(historyUrl);
    await page.wait(1);
  }
  throw new TimeoutError(
    matchingSeen ? 'Pinduoduo 下载账单 button for the requested date range' : 'Pinduoduo export-history row for the requested date range',
    timeoutSeconds,
  );
}

async function triggerHistoryDownload(page) {
  try {
    await page.snapshot();
    const target = await page.evaluate(`(() => {
      const button = document.querySelector('[data-opencli-pdd-download-target="1"]');
      if (!button) return { ok: false, reason: 'marked download button not found' };
      const ref = button.getAttribute('data-opencli-ref');
      if (!ref) return { ok: false, reason: 'download button did not receive an OpenCLI ref' };
      return { ok: true, ref };
    })()`);
    if (!target.ok) throw new Error(target.reason);
    const clicked = await page.click(target.ref);
    if (clicked?.click_method !== 'cdp') {
      throw new Error(`expected a CDP click but OpenCLI used ${clicked?.click_method || 'an unknown method'}`);
    }
    return { ok: true, method: 'ref-cdp-click', ref: target.ref };
  } catch (error) {
    throw new CommandExecutionError(`Could not click Pinduoduo 下载账单 button: ${error?.message || error}`);
  }
}

function zipSnapshot(directory) {
  const result = new Map();
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = fs.statSync(fullPath);
    result.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return result;
}

function newestChangedZip(directory, before) {
  if (!fs.existsSync(directory)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = fs.statSync(fullPath);
    const previous = before.get(fullPath);
    if (!previous || stat.mtimeMs > previous.mtimeMs || stat.size !== previous.size) {
      candidates.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function waitForNewZip(page, directory, before, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previousCandidate = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const candidate = newestChangedZip(directory, before);
    if (candidate && candidate.size > 0) {
      if (previousCandidate?.fullPath === candidate.fullPath && previousCandidate.size === candidate.size) stableSamples += 1;
      else stableSamples = 0;
      previousCandidate = candidate;
      if (stableSamples >= 1 && !fs.existsSync(`${candidate.fullPath}.crdownload`)) return candidate.fullPath;
    }
    await page.wait(0.5);
  }
  throw new TimeoutError(`new .zip file in ${directory}`, timeoutSeconds);
}

function moveDownloadedFile(sourcePath, targetPath, overwrite) {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) return;
  if (fs.existsSync(targetPath)) {
    if (!overwrite) throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
    fs.unlinkSync(targetPath);
  }
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(sourcePath, targetPath);
    fs.unlinkSync(sourcePath);
  }
}

cli({
  site: 'pinduoduo-monthly-statement',
  name: 'download',
  description: 'Download a Pinduoduo 货款明细 monthly statement ZIP for a store; defaults to the full previous calendar month.',
  access: 'read',
  example: 'opencli --profile opc-pro1 pinduoduo-monthly-statement download --store-name "拼多多店铺全称" --account "登录账号" --password "登录密码" --store-short-name "拼多多1店" --site-session persistent --keep-tab true --window foreground -f yaml',
  domain: 'pinduoduo.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'store-name', type: 'string', default: '', help: 'Expected Pinduoduo store name; verifies the current login. Supports PINDUODUO_STORE_NAME.' },
    { name: 'account', type: 'string', default: '', help: 'Pinduoduo account used only when the profile is not logged in. Supports PINDUODUO_ACCOUNT.' },
    { name: 'password', type: 'string', default: '', help: 'Pinduoduo password used only when the profile is not logged in. Supports PINDUODUO_PASSWORD.' },
    { name: 'store-short-name', type: 'string', default: '', help: 'Store abbreviation used in the ZIP filename. Defaults to store-name, then the detected current store. Supports PINDUODUO_STORE_SHORT_NAME.' },
    { name: 'home-url', type: 'string', default: DEFAULT_HOME_URL, help: 'Pinduoduo merchant home URL. Supports PINDUODUO_HOME_URL.' },
    { name: 'bills-url', type: 'string', default: DEFAULT_BILLS_URL, help: 'Pinduoduo 货款明细 URL. Supports PINDUODUO_BILLS_URL.' },
    { name: 'history-url', type: 'string', default: DEFAULT_HISTORY_URL, help: 'Pinduoduo bill export-history URL. Supports PINDUODUO_BILL_HISTORY_URL.' },
    { name: 'start-date', type: 'string', default: DEFAULT_RANGE.startDate, help: `Statement start date (YYYY-MM-DD). Defaults to previous month start (${DEFAULT_RANGE.startDate}). Supports PINDUODUO_BILL_START_DATE.` },
    { name: 'end-date', type: 'string', default: DEFAULT_RANGE.endDate, help: `Statement end date (YYYY-MM-DD). Defaults to previous month end (${DEFAULT_RANGE.endDate}). Supports PINDUODUO_BILL_END_DATE.` },
    { name: 'downloads-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Chrome download directory to watch. Supports PINDUODUO_DOWNLOADS_DIR.' },
    { name: 'output-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Directory for the renamed monthly statement ZIP. Supports PINDUODUO_BILL_OUTPUT_DIR.' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Replace an existing monthly statement ZIP with the same store abbreviation and date range.' },
    { name: 'reuse-existing', type: 'boolean', default: false, help: 'Reuse a still-active matching export-history task instead of creating a new export; useful for retries.' },
    { name: 'login-timeout', type: 'int', default: 180, help: 'Seconds to wait for login and any manual verification.' },
    { name: 'page-timeout', type: 'int', default: 60, help: 'Seconds to wait for the Pinduoduo bills page.' },
    { name: 'query-timeout', type: 'int', default: 60, help: 'Seconds to wait for the selected date-range query.' },
    { name: 'export-timeout', type: 'int', default: 180, help: 'Seconds to wait for the matching export-history row and 下载账单 button.' },
    { name: 'download-timeout', type: 'int', default: 180, help: 'Seconds to wait for the downloaded ZIP.' },
    { name: 'timeout', type: 'int', default: 900, help: 'Max seconds for the overall command (default: 900).' },
  ],
  columns: ['status', 'storeName', 'storeShortName', 'startDate', 'endDate', 'rowCount', 'downloaded', 'filename', 'filePath', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for pinduoduo-monthly-statement download');

    const expectedStoreName = stringArg(argument(kwargs, 'store-name', 'storeName'), 'PINDUODUO_STORE_NAME');
    const account = stringArg(argument(kwargs, 'account', 'account'), 'PINDUODUO_ACCOUNT');
    const password = stringArg(argument(kwargs, 'password', 'password'), 'PINDUODUO_PASSWORD');
    const requestedShortName = stringArg(argument(kwargs, 'store-short-name', 'storeShortName'), 'PINDUODUO_STORE_SHORT_NAME');
    const homeUrl = pinduoduoUrl(stringArg(argument(kwargs, 'home-url', 'homeUrl'), 'PINDUODUO_HOME_URL', DEFAULT_HOME_URL), 'home-url');
    const billsUrl = pinduoduoUrl(stringArg(argument(kwargs, 'bills-url', 'billsUrl'), 'PINDUODUO_BILLS_URL', DEFAULT_BILLS_URL), 'bills-url');
    const historyUrl = pinduoduoUrl(stringArg(argument(kwargs, 'history-url', 'historyUrl'), 'PINDUODUO_BILL_HISTORY_URL', DEFAULT_HISTORY_URL), 'history-url');
    const startDate = validDate(
      stringArg(argument(kwargs, 'start-date', 'startDate'), 'PINDUODUO_BILL_START_DATE', DEFAULT_RANGE.startDate),
      'start-date',
    );
    const endDate = validDate(
      stringArg(argument(kwargs, 'end-date', 'endDate'), 'PINDUODUO_BILL_END_DATE', DEFAULT_RANGE.endDate),
      'end-date',
    );
    if (startDate > endDate) throw new ArgumentError('start-date must be on or before end-date');
    const downloadsDir = path.resolve(stringArg(
      argument(kwargs, 'downloads-dir', 'downloadsDir'),
      'PINDUODUO_DOWNLOADS_DIR',
      DEFAULT_DOWNLOADS_DIR,
    ));
    const outputDir = path.resolve(stringArg(
      argument(kwargs, 'output-dir', 'outputDir'),
      'PINDUODUO_BILL_OUTPUT_DIR',
      DEFAULT_DOWNLOADS_DIR,
    ));
    const overwrite = booleanArg(argument(kwargs, 'overwrite', 'overwrite'), false, 'overwrite');
    const reuseExisting = booleanArg(argument(kwargs, 'reuse-existing', 'reuseExisting'), false, 'reuse-existing');
    const loginTimeout = positiveInt(argument(kwargs, 'login-timeout', 'loginTimeout'), 'login-timeout');
    const pageTimeout = positiveInt(argument(kwargs, 'page-timeout', 'pageTimeout'), 'page-timeout');
    const queryTimeout = positiveInt(argument(kwargs, 'query-timeout', 'queryTimeout'), 'query-timeout');
    const exportTimeout = positiveInt(argument(kwargs, 'export-timeout', 'exportTimeout'), 'export-timeout');
    const downloadTimeout = positiveInt(argument(kwargs, 'download-timeout', 'downloadTimeout'), 'download-timeout');

    if (!fs.existsSync(downloadsDir) || !fs.statSync(downloadsDir).isDirectory()) {
      throw new ArgumentError(`downloads-dir is not a directory: ${downloadsDir}`);
    }
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      throw new CommandExecutionError(`Could not create output directory ${outputDir}: ${error?.message || error}`);
    }
    if (!fs.statSync(outputDir).isDirectory()) throw new ArgumentError(`output-dir is not a directory: ${outputDir}`);

    const home = await ensureLoggedIn(page, homeUrl, account, password, loginTimeout);
    assertStore(expectedStoreName, home.storeName);
    const bills = await waitForBillsPage(page, billsUrl, pageTimeout);
    const actualStoreName = bills.storeName || home.storeName || expectedStoreName;
    assertStore(expectedStoreName, actualStoreName);
    if (!actualStoreName) throw new CommandExecutionError('Could not determine the current Pinduoduo store name');

    const storeShortName = sanitizeFilePart(requestedShortName || expectedStoreName || actualStoreName, 'store-short-name');
    const filename = `月结账单-${storeShortName}-${startDate}_${endDate}.zip`;
    const targetPath = path.join(outputDir, filename);
    if (fs.existsSync(targetPath) && !overwrite) {
      throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
    }

    let rowCount = null;
    if (!reuseExisting) {
      await setDateRange(page, startDate, endDate);
      const query = await runQuery(page, queryTimeout);
      rowCount = query.rowCount;
      await submitExport(page);
    }
    await waitForHistoryDownload(page, historyUrl, startDate, endDate, exportTimeout);
    const before = zipSnapshot(downloadsDir);
    await triggerHistoryDownload(page);
    const downloadedPath = await waitForNewZip(page, downloadsDir, before, downloadTimeout);
    try {
      moveDownloadedFile(downloadedPath, targetPath, overwrite);
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error;
      throw new CommandExecutionError(`Could not rename downloaded ZIP: ${error?.message || error}`);
    }

    return [{
      status: 'downloaded',
      storeName: actualStoreName,
      storeShortName,
      startDate,
      endDate,
      rowCount,
      downloaded: true,
      filename,
      filePath: targetPath,
      url: historyUrl,
    }];
  },
});
