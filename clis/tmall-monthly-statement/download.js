import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_PAGE_URL = 'https://myseller.taobao.com/home.htm/whale-accountant/pay/capital/home?active=fund_month';
const DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '300';
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

function validateFullMonth(startDate, endDate) {
  if (startDate.slice(0, 7) !== endDate.slice(0, 7)) {
    throw new ArgumentError('start-date and end-date must be in the same calendar month');
  }
  const [year, month] = startDate.split('-').map(Number);
  const expectedStart = `${startDate.slice(0, 7)}-01`;
  const expectedEnd = formatLocalDate(new Date(year, month, 0, 12, 0, 0, 0));
  if (startDate !== expectedStart || endDate !== expectedEnd) {
    throw new ArgumentError(`monthly statement dates must cover the full month: ${expectedStart} to ${expectedEnd}`);
  }
}

function taobaoUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new ArgumentError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ArgumentError(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.hostname !== 'taobao.com' && !parsed.hostname.endsWith('.taobao.com')) {
    throw new ArgumentError(`${label} must point to taobao.com`);
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
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const visible = (el) => {
      const style = el ? getComputedStyle(el) : null;
      return Boolean(el && style?.display !== 'none' && style?.visibility !== 'hidden'
        && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    };
    const el = elements.find(visible);
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

async function pageSnapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const compact = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const body = document.body?.innerText || '';
    const storeCandidates = Array.from(document.querySelectorAll('[class*="shopName--"], [class*="shop-name"], [class*="shopName"]'))
      .filter(visible)
      .map((el) => Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim()
        || (el.innerText || el.textContent || '').split(/\\r?\\n/)[0].trim())
      .filter(Boolean);
    const passwordInput = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
    return {
      url: location.href,
      title: document.title || '',
      body,
      storeNameCandidate: storeCandidates[0] || '',
      pageReady: Boolean(document.querySelector('#billCycle input[placeholder="起始日期"]'))
        && Array.from(document.querySelectorAll('[role="tab"]')).some((el) => visible(el) && compact(el.textContent) === '月汇总'),
      loggedIn: Boolean(storeCandidates[0]) || body.includes('退出当前账号'),
      passwordLoginVisible: Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
        .some((el) => visible(el) && ['密码登录', '账号密码登录'].includes(compact(el.textContent))),
      loginFormVisible: Boolean(passwordInput),
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
      for (let depth = 0; root?.parentElement && depth < 7; depth += 1) {
        if (root.querySelectorAll('input').length >= 2 && root.querySelectorAll('button, [role="button"]').length > 0) break;
        root = root.parentElement;
      }
    }
    const inputs = Array.from((root || document).querySelectorAll('input')).filter(visible);
    const accountInput = inputs.find((el) => el !== passwordInput && /账号|账户|手机号|手机号码|用户名|会员名|邮箱/.test(el.placeholder || ''))
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
    document.querySelectorAll('[data-opencli-tmall-login-submit]').forEach((el) => el.removeAttribute('data-opencli-tmall-login-submit'));
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    const button = Array.from((root || document).querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find((el) => ['登录', '立即登录'].includes(textOf(el)));
    if (!button) return { ok: false, reason: 'login button not found' };
    button.setAttribute('data-opencli-tmall-login-submit', '1');
    return {
      ok: accountInput.value === ${JSON.stringify(account)} && passwordInput.value === ${JSON.stringify(password)},
      reason: 'input verification failed',
    };
  })()`);
  if (!result.ok) throw new CommandExecutionError(`Could not fill Taobao account login form: ${result.reason}`);
  await nativeClickSelector(page, '[data-opencli-tmall-login-submit="1"]', 'Taobao Login button was not clickable');
}

async function ensureLoggedIn(page, pageUrl, account, password, loginTimeoutSeconds) {
  await page.goto(pageUrl);
  const initialDeadline = Date.now() + 30000;
  let state = await pageSnapshot(page);
  while (Date.now() < initialDeadline && !state.pageReady && !state.passwordLoginVisible && !state.loginFormVisible) {
    await page.wait(0.5);
    state = await pageSnapshot(page);
  }
  if (state.pageReady && state.loggedIn) return state;

  if (!account || !password) {
    throw new AuthRequiredError(
      'taobao.com',
      'Tmall Seller is not logged in; pass --account and --password (or TMALL_ACCOUNT / TMALL_PASSWORD), or log in manually with the same OpenCLI profile',
    );
  }

  if (state.passwordLoginVisible) {
    await clickExactText(page, 'tmall-password-login', ['密码登录', '账号密码登录'], 'Taobao password-login entry was not clickable');
    await page.wait(0.5);
  }

  const formDeadline = Date.now() + 15000;
  state = await pageSnapshot(page);
  while (Date.now() < formDeadline && !state.loginFormVisible) {
    await page.wait(0.5);
    state = await pageSnapshot(page);
  }
  if (!state.loginFormVisible) throw new CommandExecutionError('Taobao account/password login form did not appear');

  await fillLoginForm(page, account, password);
  const loginDeadline = Date.now() + loginTimeoutSeconds * 1000;
  let verificationReported = false;
  while (Date.now() < loginDeadline) {
    await page.wait(1);
    state = await pageSnapshot(page);
    if (state.pageReady && state.loggedIn) return state;
    if (state.verificationVisible && !verificationReported) {
      process.stderr.write('Taobao login requires a visible verification step; complete it in the browser window.\n');
      verificationReported = true;
    }
  }
  if (state.verificationVisible) throw new TimeoutError('Taobao manual verification and login', loginTimeoutSeconds);
  throw new AuthRequiredError('taobao.com', 'Taobao account login did not reach the authenticated Tmall Seller monthly-summary page');
}

function assertStore(expectedStoreName, actualStoreName) {
  if (!expectedStoreName || !actualStoreName) return;
  if (actualStoreName === expectedStoreName || actualStoreName.includes(expectedStoreName) || expectedStoreName.includes(actualStoreName)) return;
  throw new CommandExecutionError(
    `Logged-in Tmall store mismatch: expected "${expectedStoreName}", current store is "${actualStoreName}"`,
  );
}

async function waitForMonthlyPage(page, pageUrl, timeoutSeconds) {
  if (!String(await page.evaluate('location.href')).includes('/whale-accountant/pay/capital/home')) {
    await page.goto(pageUrl);
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await pageSnapshot(page);
    if (state.pageReady) return state;
    if (/login\.taobao\.com|\/login(?:[/?#]|$)/i.test(state.url) || /密码登录|账号密码登录/.test(state.body)) {
      throw new AuthRequiredError('taobao.com', 'Tmall Seller redirected to login');
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Tmall Seller 月汇总 page', timeoutSeconds);
}

async function pickerYears(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const panels = Array.from(document.querySelectorAll('.next-range-picker2-panel .next-calendar2-panel')).filter(visible);
    const yearOf = (panel) => Number((panel?.querySelector('.next-calendar2-header-text-field')?.textContent || '').match(/\\d{4}/)?.[0] || 0);
    return {
      open: Boolean(document.querySelector('.next-range-picker2-panel')),
      years: panels.map(yearOf).filter(Boolean),
    };
  })()`);
}

async function openMonthPicker(page) {
  await page.pressKey('Escape').catch(() => {});
  await page.wait(0.2);
  await nativeClickSelector(page, '#billCycle [role="button"]', 'Tmall 入账日期 field was not clickable');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await pickerYears(page);
    if (state.open && state.years.length) return state;
    await page.wait(0.2);
  }
  throw new CommandExecutionError('Tmall month-range picker did not open');
}

async function navigatePickerToYear(page, targetYear) {
  let state = await pickerYears(page);
  for (let step = 0; step < 20 && !state.years.includes(targetYear); step += 1) {
    if (!state.years.length) throw new CommandExecutionError('Tmall month picker year headers were unreadable');
    const selector = targetYear < Math.min(...state.years)
      ? '.next-range-picker2-panel .next-range-picker-left .next-calendar2-header-left-btn'
      : '.next-range-picker2-panel .next-range-picker-right .next-calendar2-header-right-btn';
    const previous = state.years.join(',');
    await nativeClickSelector(page, selector, `Could not navigate the Tmall month picker toward ${targetYear}`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await page.wait(0.15);
      state = await pickerYears(page);
      if (state.years.join(',') !== previous) break;
    }
    if (state.years.join(',') === previous) throw new CommandExecutionError('Tmall month picker navigation did not change the displayed year');
  }
  if (!state.years.includes(targetYear)) throw new ArgumentError(`month is more than 20 years from the displayed Tmall picker range`);
}

async function setMonthRange(page, startDate) {
  const month = startDate.slice(0, 7);
  const targetYear = Number(startDate.slice(0, 4));
  await openMonthPicker(page);
  await navigatePickerToYear(page, targetYear);
  const selector = `.next-range-picker2-panel td[title="${month}"]`;
  await nativeClickSelector(page, selector, `Tmall month ${month} was not selectable as the range start`);
  await page.wait(0.2);
  await nativeClickSelector(page, selector, `Tmall month ${month} was not selectable as the range end`);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const values = await page.evaluate(`(() => ({
      startValue: document.querySelector('#billCycle input[placeholder="起始日期"]')?.value || '',
      endValue: document.querySelector('#billCycle input[placeholder="结束日期"]')?.value || '',
      expanded: document.querySelector('#billCycle [role="button"]')?.getAttribute('aria-expanded') || '',
    }))()`);
    if (values.startValue === month && values.endValue === month && values.expanded === 'false') return;
    await page.wait(0.2);
  }
  throw new CommandExecutionError(`Tmall month picker did not retain ${month} as both range endpoints`);
}

async function querySnapshot(page, targetMonthKey) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const body = document.body?.innerText || '';
    const rows = Array.from(document.querySelectorAll('[role="tabpanel"] tbody tr[role="row"], [role="tabpanel"] tbody tr')).filter(visible);
    const targetMonthKey = ${JSON.stringify(targetMonthKey)};
    let targetRow = null;
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => (cell.innerText || cell.textContent || '').replace(/\\s+/g, '').trim());
      if (cells[0] === targetMonthKey) {
        const button = Array.from(row.querySelectorAll('button, [role="button"]')).find((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '下载明细');
        targetRow = {
          detailCountValue: Number(String(cells[1] || '').replace(/,/g, '')),
          downloadReady: Boolean(button),
          rowText: cells.join('|'),
        };
        break;
      }
    }
    const loading = Array.from(document.querySelectorAll('.next-loading, [class*="loading"], [class*="Loading"]')).some(visible);
    const noData = /暂无数据|暂无账单|无符合条件/.test(body);
    return {
      urlValue: location.href,
      bodyValue: body,
      loadingValue: loading,
      noDataValue: noData,
      targetRowValue: targetRow,
      fingerprintValue: JSON.stringify({ loading, noData, targetRow }),
    };
  })()`);
}

async function runQuery(page, targetMonthKey, timeoutSeconds) {
  await nativeClickSelector(page, '#billCycle + * button[type="submit"], [role="tabpanel"] form button[type="submit"]', 'Tmall Search button was not clickable');
  await page.wait(1);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previousFingerprint = '';
  let stableSamples = 0;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await querySnapshot(page, targetMonthKey);
    if (/login\.taobao\.com|\/login(?:[/?#]|$)/i.test(latest.urlValue) || /密码登录|账号密码登录/.test(latest.bodyValue)) {
      throw new AuthRequiredError('taobao.com', 'Tmall Seller authentication expired during the monthly-statement query');
    }
    if (!latest.loadingValue && latest.fingerprintValue === previousFingerprint) stableSamples += 1;
    else stableSamples = 0;
    previousFingerprint = latest.fingerprintValue;
    if (!latest.loadingValue && latest.targetRowValue?.downloadReady && stableSamples >= 1) return latest.targetRowValue;
    if (!latest.loadingValue && latest.noDataValue && stableSamples >= 1) {
      throw new EmptyResultError('tmall-monthly-statement download', `No monthly statement was available for ${targetMonthKey}`);
    }
    await page.wait(0.5);
  }
  throw new TimeoutError(`Tmall monthly-statement row for ${targetMonthKey}`, timeoutSeconds);
}

async function markTargetDownload(page, targetMonthKey) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-tmall-download-target]').forEach((el) => el.removeAttribute('data-opencli-tmall-download-target'));
    const rows = Array.from(document.querySelectorAll('[role="tabpanel"] tbody tr[role="row"], [role="tabpanel"] tbody tr')).filter(visible);
    const row = rows.find((candidate) => {
      const first = candidate.querySelector('td');
      return (first?.innerText || first?.textContent || '').replace(/\\s+/g, '').trim() === ${JSON.stringify(targetMonthKey)};
    });
    const button = Array.from(row?.querySelectorAll('button, [role="button"]') || [])
      .find((el) => visible(el) && (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '下载明细');
    if (!button) return false;
    button.setAttribute('data-opencli-tmall-download-target', '1');
    return true;
  })()`);
}

function xlsxSnapshot(directory) {
  const result = new Map();
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xlsx')) continue;
    const fullPath = path.join(directory, entry.name);
    const stat = fs.statSync(fullPath);
    result.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return result;
}

function newestChangedXlsx(directory, before) {
  if (!fs.existsSync(directory)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xlsx')) continue;
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

async function waitForNewXlsx(page, directory, before, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previousCandidate = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const candidate = newestChangedXlsx(directory, before);
    if (candidate && candidate.size > 0) {
      if (previousCandidate?.fullPath === candidate.fullPath && previousCandidate.size === candidate.size) stableSamples += 1;
      else stableSamples = 0;
      previousCandidate = candidate;
      if (stableSamples >= 1 && !fs.existsSync(`${candidate.fullPath}.crdownload`)) return candidate.fullPath;
    }
    await page.wait(0.5);
  }
  throw new TimeoutError(`new .xlsx file in ${directory}`, timeoutSeconds);
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
  site: 'tmall-monthly-statement',
  name: 'download',
  description: 'Download a Tmall Seller 月汇总 detail workbook for one store; defaults to the full previous calendar month.',
  access: 'read',
  example: 'opencli --profile opc-pro1 tmall-monthly-statement download --store-name "天猫店铺全称" --account "登录账号" --password "登录密码" --store-short-name "天猫猫旗" --site-session persistent --keep-tab true --window foreground -f yaml',
  domain: 'taobao.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'store-name', type: 'string', default: '', help: 'Expected Tmall store name; verifies the current login. Supports TMALL_STORE_NAME.' },
    { name: 'account', type: 'string', default: '', help: 'Taobao/Tmall account used only when the profile is not logged in. Supports TMALL_ACCOUNT.' },
    { name: 'password', type: 'string', default: '', help: 'Taobao/Tmall password used only when the profile is not logged in. Supports TMALL_PASSWORD.' },
    { name: 'store-short-name', type: 'string', default: '', help: 'Store abbreviation used in the XLSX filename. Defaults to store-name, then the detected current store. Supports TMALL_STORE_SHORT_NAME.' },
    { name: 'page-url', type: 'string', default: DEFAULT_PAGE_URL, help: 'Tmall Seller 资金管理/月汇总 URL. Supports TMALL_MONTHLY_STATEMENT_URL.' },
    { name: 'start-date', type: 'string', default: DEFAULT_RANGE.startDate, help: `Statement start date (YYYY-MM-DD). Defaults to previous month start (${DEFAULT_RANGE.startDate}). Supports TMALL_BILL_START_DATE.` },
    { name: 'end-date', type: 'string', default: DEFAULT_RANGE.endDate, help: `Statement end date (YYYY-MM-DD). Defaults to previous month end (${DEFAULT_RANGE.endDate}). Supports TMALL_BILL_END_DATE.` },
    { name: 'downloads-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Chrome download directory to watch. Supports TMALL_DOWNLOADS_DIR.' },
    { name: 'output-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Directory for the renamed monthly statement workbook. Supports TMALL_BILL_OUTPUT_DIR.' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Replace an existing monthly statement workbook with the same store abbreviation and date range.' },
    { name: 'login-timeout', type: 'int', default: 180, help: 'Seconds to wait for login and any manual verification.' },
    { name: 'page-timeout', type: 'int', default: 60, help: 'Seconds to wait for the Tmall monthly-summary page.' },
    { name: 'query-timeout', type: 'int', default: 60, help: 'Seconds to wait for the selected month query.' },
    { name: 'download-timeout', type: 'int', default: 120, help: 'Seconds to wait for the downloaded workbook.' },
    { name: 'timeout', type: 'int', default: 300, help: 'Max seconds for the overall command (default: 300).' },
  ],
  columns: ['status', 'storeName', 'storeShortName', 'startDate', 'endDate', 'detailCount', 'downloaded', 'filename', 'filePath', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for tmall-monthly-statement download');

    const expectedStoreName = stringArg(argument(kwargs, 'store-name', 'storeName'), 'TMALL_STORE_NAME');
    const account = stringArg(argument(kwargs, 'account', 'account'), 'TMALL_ACCOUNT');
    const password = stringArg(argument(kwargs, 'password', 'password'), 'TMALL_PASSWORD');
    const requestedShortName = stringArg(argument(kwargs, 'store-short-name', 'storeShortName'), 'TMALL_STORE_SHORT_NAME');
    const pageUrl = taobaoUrl(stringArg(argument(kwargs, 'page-url', 'pageUrl'), 'TMALL_MONTHLY_STATEMENT_URL', DEFAULT_PAGE_URL), 'page-url');
    const startDate = validDate(
      stringArg(argument(kwargs, 'start-date', 'startDate'), 'TMALL_BILL_START_DATE', DEFAULT_RANGE.startDate),
      'start-date',
    );
    const endDate = validDate(
      stringArg(argument(kwargs, 'end-date', 'endDate'), 'TMALL_BILL_END_DATE', DEFAULT_RANGE.endDate),
      'end-date',
    );
    if (startDate > endDate) throw new ArgumentError('start-date must be on or before end-date');
    validateFullMonth(startDate, endDate);
    const downloadsDir = path.resolve(stringArg(
      argument(kwargs, 'downloads-dir', 'downloadsDir'),
      'TMALL_DOWNLOADS_DIR',
      DEFAULT_DOWNLOADS_DIR,
    ));
    const outputDir = path.resolve(stringArg(
      argument(kwargs, 'output-dir', 'outputDir'),
      'TMALL_BILL_OUTPUT_DIR',
      DEFAULT_DOWNLOADS_DIR,
    ));
    const overwrite = booleanArg(argument(kwargs, 'overwrite', 'overwrite'), false, 'overwrite');
    const loginTimeout = positiveInt(argument(kwargs, 'login-timeout', 'loginTimeout'), 'login-timeout');
    const pageTimeout = positiveInt(argument(kwargs, 'page-timeout', 'pageTimeout'), 'page-timeout');
    const queryTimeout = positiveInt(argument(kwargs, 'query-timeout', 'queryTimeout'), 'query-timeout');
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

    const loginState = await ensureLoggedIn(page, pageUrl, account, password, loginTimeout);
    assertStore(expectedStoreName, loginState.storeNameCandidate);
    const monthlyPage = await waitForMonthlyPage(page, pageUrl, pageTimeout);
    const actualStoreName = monthlyPage.storeNameCandidate || loginState.storeNameCandidate || expectedStoreName;
    assertStore(expectedStoreName, actualStoreName);
    if (!actualStoreName) throw new CommandExecutionError('Could not determine the current Tmall store name');

    const storeShortName = sanitizeFilePart(requestedShortName || expectedStoreName || actualStoreName, 'store-short-name');
    const filename = `月结账单-${storeShortName}-${startDate}_${endDate}.xlsx`;
    const targetPath = path.join(outputDir, filename);
    if (fs.existsSync(targetPath) && !overwrite) {
      throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
    }

    await setMonthRange(page, startDate);
    const targetMonthKey = startDate.slice(0, 7).replace('-', '');
    const queryResult = await runQuery(page, targetMonthKey, queryTimeout);
    const before = xlsxSnapshot(downloadsDir);
    if (!await markTargetDownload(page, targetMonthKey)) {
      throw new CommandExecutionError(`Download Details button was not found for Tmall statement month ${targetMonthKey}`);
    }
    await nativeClickSelector(page, '[data-opencli-tmall-download-target="1"]', `Download Details button was not clickable for ${targetMonthKey}`);
    const downloadedPath = await waitForNewXlsx(page, downloadsDir, before, downloadTimeout);
    try {
      moveDownloadedFile(downloadedPath, targetPath, overwrite);
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error;
      throw new CommandExecutionError(`Could not rename downloaded workbook: ${error?.message || error}`);
    }

    return [{
      status: 'downloaded',
      storeName: actualStoreName,
      storeShortName,
      startDate,
      endDate,
      detailCount: Number.isFinite(queryResult.detailCountValue) ? queryResult.detailCountValue : null,
      downloaded: true,
      filename,
      filePath: targetPath,
      url: pageUrl,
    }];
  },
});
