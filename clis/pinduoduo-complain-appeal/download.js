import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_HOME_URL = 'https://mms.pinduoduo.com/home';
const DEFAULT_APPEAL_URL = 'https://mms.pinduoduo.com/aftersales/customer_complain_appeal';
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Downloads');
const LIST_API_PATH = '/api/colombo/tuju/appealList';
const DETAIL_API_PATH = '/api/colombo/tuju/detail';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL_APPEAL_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const ALL_PENALTY_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 10];

// Strategy note:
// - Source: same-origin POST APIs observed from the visible appeal list/detail UI.
// - Auth: the current Pinduoduo browser session.
// - Contract: internal/unstable. Only user-requested visible business fields are
//   exported; ticketSn/orderSn checks prevent list/detail mismatches.
// - API pagination is materially safer than retaining one DOM page while opening
//   every detail route.

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '900';
}

const APPEAL_STATUS_LABELS = {
  0: '不支持申诉',
  1: '可申诉',
  2: '超时未申诉已处罚',
  3: '已申诉',
  4: '申诉未通过已处罚',
  5: '申诉通过',
  6: '已申诉',
  7: '已撤销',
  8: '取消处罚',
};

const PENALTY_STATUS_LABELS = {
  0: '创建',
  1: '审核中',
  2: '失效',
  3: '赔付申请',
  4: '赔付中',
  5: '赔付成功',
  6: '取消',
  7: '赔付失败',
  8: '等待赔付',
  10: '免罚',
};

const STATUS_FILTERS = {
  all: {
    appealStatusIn: ALL_APPEAL_STATUSES,
    statusIn: ALL_PENALTY_STATUSES,
  },
  appealable: {
    appealStatusIn: [1],
    statusIn: ALL_PENALTY_STATUSES.filter((value) => value !== 10),
  },
  appealed: {
    appealStatusIn: [3, 6],
    statusIn: ALL_PENALTY_STATUSES.filter((value) => value !== 10),
  },
  timeout: {
    appealStatusIn: [2],
    statusIn: ALL_PENALTY_STATUSES.filter((value) => ![2, 7, 10].includes(value)),
  },
  approved: {
    appealStatusIn: [5],
    statusIn: ALL_PENALTY_STATUSES.filter((value) => value !== 10),
  },
  rejected: {
    appealStatusIn: [4],
    statusIn: ALL_PENALTY_STATUSES.filter((value) => ![2, 7, 10].includes(value)),
  },
  unsupported: {
    appealStatusIn: [0],
    statusIn: ALL_PENALTY_STATUSES.filter((value) => ![2, 7, 10].includes(value)),
  },
  'first-impunity': {
    appealStatusIn: [],
    statusIn: [10],
    exemptionType: 2,
  },
  'solved-impunity': {
    appealStatusIn: [],
    statusIn: [10],
    exemptionType: 3,
  },
};

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultDateRange() {
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { startDate: formatLocalDate(start), endDate: formatLocalDate(end) };
}

const DEFAULT_RANGE = defaultDateRange();

function argument(kwargs, kebabName, camelName) {
  return kwargs?.[camelName] ?? kwargs?.[kebabName];
}

function stringArg(value, envName, defaultValue = '') {
  return String(value || process.env[envName] || defaultValue).trim();
}

function positiveInt(value, label, maxValue = null) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  if (maxValue !== null && result > maxValue) {
    throw new ArgumentError(`${label} must be <= ${maxValue}`);
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

function localDayTimestamp(value, endOfDay = false) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ).getTime();
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

function nullableIsoTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nullableYuan(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric / 100 : null;
}

function textOrNull(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
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

async function clickExactText(page, marker, texts, errorMessage) {
  const marked = await markExactText(page, marker, texts);
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
    const headerStore = Array.from(document.querySelectorAll('#mms-header-next span[title]')).find(visible);
    const nextProps = window.__NEXT_DATA__?.props || {};
    const stateStoreName = nextProps.userInfo?.mall?.mall_name
      || nextProps.headerProps?.serverData?.userInfo?.mall?.mall_name
      || nextProps.headerProps?.serverData?.userInfo?.all?.mall?.mall_name
      || '';
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(visible);
    return {
      url: location.href,
      body,
      loggedIn: Boolean(document.querySelector('#mms-header-next'))
        || (body.includes('商家后台') && (body.includes('退出当前账号') || body.includes('后台首页'))),
      storeName: storeText(headerStore) || stateStoreName,
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

async function waitForAppealPage(page, appealUrl, timeoutSeconds) {
  await page.goto(appealUrl);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const body = document.body?.innerText || '';
      const headerStore = Array.from(document.querySelectorAll('#mms-header-next span[title]'))
        .map((el) => (el.getAttribute('title') || el.textContent || '').trim()).find(Boolean) || '';
      const nextProps = window.__NEXT_DATA__?.props || {};
      const stateStoreName = nextProps.userInfo?.mall?.mall_name
        || nextProps.headerProps?.serverData?.userInfo?.mall?.mall_name
        || nextProps.headerProps?.serverData?.userInfo?.all?.mall?.mall_name
        || '';
      return {
        url: location.href,
        body,
        storeName: headerStore || stateStoreName,
        formReady: Boolean(document.querySelector('[data-testid="beast-core-form-item"]')),
        tableReady: Boolean(document.querySelector('[data-testid="beast-core-table"]')),
        headingReady: body.includes('消费者负向体验补偿明细'),
      };
    })()`);
    if (state.formReady && state.tableReady && state.headingReady) return state;
    if (/账号登录|请登录|登录已失效/.test(state.body) || /\/login(?:[/?#]|$)/i.test(state.url)) {
      throw new AuthRequiredError('mms.pinduoduo.com', 'Pinduoduo merchant authentication expired while opening the appeal page');
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('Pinduoduo 消费者负向体验补偿明细 page', timeoutSeconds);
}

async function postApi(page, appealUrl, apiPath, requestBody, label) {
  const url = new URL(apiPath, appealUrl).href;
  let payload;
  try {
    payload = await page.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (/401|403|login|登录|AUTH/i.test(message)) {
      throw new AuthRequiredError('mms.pinduoduo.com', `${label} requires an authenticated Pinduoduo merchant session`);
    }
    throw new CommandExecutionError(`${label} failed: ${message}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new CommandExecutionError(`${label} returned an invalid JSON response`);
  }
  if (payload.success !== true) {
    const message = payload.errorMsg || payload.error_msg || `errorCode=${payload.errorCode ?? 'unknown'}`;
    if (/login|登录|未登录|认证/i.test(String(message))) {
      throw new AuthRequiredError('mms.pinduoduo.com', `${label} failed: ${message}`);
    }
    throw new CommandExecutionError(`${label} failed: ${message}`);
  }
  if (!payload.result || typeof payload.result !== 'object') {
    throw new CommandExecutionError(`${label} returned no result object`);
  }
  return payload.result;
}

function numericTotal(value, fallback) {
  const candidate = typeof value === 'object' && value !== null ? value.total : value;
  const numeric = Number(candidate);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

async function fetchAllListRows(page, appealUrl, query, pageSize) {
  const rows = [];
  const seenTickets = new Set();
  let pageNo = 1;
  let total = null;
  let responseMeta = {};

  while (pageNo <= 1000) {
    const result = await postApi(
      page,
      appealUrl,
      LIST_API_PATH,
      { ...query, pageNo, pageSize },
      `Pinduoduo appeal list page ${pageNo}`,
    );
    const pageRows = Array.isArray(result.merchantPenaltyTickets) ? result.merchantPenaltyTickets : [];
    if (pageNo === 1) {
      const { merchantPenaltyTickets: ignoredRows, ...metadata } = result;
      responseMeta = metadata;
      total = numericTotal(result.total, pageRows.length);
    }
    for (const item of pageRows) {
      const ticketSn = String(item?.ticketSn || '').trim();
      if (!ticketSn) throw new CommandExecutionError(`Pinduoduo appeal list page ${pageNo} contained a row without ticketSn`);
      if (seenTickets.has(ticketSn)) continue;
      seenTickets.add(ticketSn);
      rows.push(item);
    }

    if (pageRows.length === 0 || pageRows.length < pageSize || (total !== null && rows.length >= total)) break;
    pageNo += 1;
  }

  if (pageNo > 1000) throw new CommandExecutionError('Pinduoduo appeal list exceeded the 1000-page safety limit');
  if (total !== null && rows.length < total) {
    throw new CommandExecutionError(`Pinduoduo appeal list expected ${total} rows but collected ${rows.length}`);
  }
  return { rows, total: total ?? rows.length, responseMeta };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function issueTypeFor(ticketType, tabs) {
  const match = (tabs || []).find((tab) => (
    tab?.tabName !== '全部'
    && Array.isArray(tab?.ticketTypeIn)
    && tab.ticketTypeIn.includes(ticketType)
  ));
  return match?.tabName || null;
}

async function fetchDetails(page, appealUrl, listRows, concurrency, appealListTabs) {
  return await mapConcurrent(listRows, concurrency, async (listItem) => {
    const ticketSn = String(listItem.ticketSn);
    const detail = await postApi(
      page,
      appealUrl,
      DETAIL_API_PATH,
      { ticketSn },
      `Pinduoduo appeal detail ${ticketSn}`,
    );
    if (detail.ticketSn && String(detail.ticketSn) !== ticketSn) {
      throw new CommandExecutionError(`Pinduoduo appeal detail ticket mismatch: requested ${ticketSn}, got ${detail.ticketSn}`);
    }
    if (detail.orderSn && listItem.orderSn && String(detail.orderSn) !== String(listItem.orderSn)) {
      throw new CommandExecutionError(
        `Pinduoduo appeal detail order mismatch for ${ticketSn}: list=${listItem.orderSn}, detail=${detail.orderSn}`,
      );
    }

    const orderSn = String(detail.orderSn || listItem.orderSn || '').trim();
    if (!orderSn) throw new CommandExecutionError(`Pinduoduo appeal detail ${ticketSn} did not contain orderSn`);
    const goodsInfo = listItem.mmsGoodsInfoVO && typeof listItem.mmsGoodsInfoVO === 'object'
      ? listItem.mmsGoodsInfoVO
      : {};
    return {
      orderSn,
      goodsTitle: textOrNull(goodsInfo.goodsName, listItem.goodsName, detail.goodsName),
      goodsId: textOrNull(goodsInfo.goodsId, detail.goodsId),
      issueType: issueTypeFor(listItem.ticketType, appealListTabs),
      compensationAmount: nullableYuan(listItem.playMoneyAmount),
      deductionProgress: textOrNull(listItem.statusDesc, PENALTY_STATUS_LABELS[listItem.status]),
      createdTime: nullableIsoTime(listItem.createdAt),
      processingStatus: textOrNull(listItem.appealStatusDesc, APPEAL_STATUS_LABELS[listItem.appealStatus]),
      compensationReason: textOrNull(detail.compensationReason),
      compensationBasis: textOrNull(detail.compensationAccordance),
      relatedOrder: textOrNull(detail.orderSn),
    };
  });
}

function writeExcelArchive(targetPath, rows, overwrite) {
  if (fs.existsSync(targetPath) && !overwrite) {
    throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
  }
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-xlsx.mjs');
  if (!fs.existsSync(scriptPath)) {
    throw new CommandExecutionError(`Excel exporter is missing: ${scriptPath}`);
  }
  const result = spawnSync(process.execPath, [scriptPath, targetPath], {
    input: JSON.stringify({ rows }),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) {
    throw new CommandExecutionError(`Could not start Excel exporter: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new CommandExecutionError(`Could not write Excel file ${targetPath}: ${message}`);
  }
  if (!fs.existsSync(targetPath)) {
    throw new CommandExecutionError(`Excel exporter completed without creating ${targetPath}`);
  }
}

cli({
  site: 'pinduoduo-complain-appeal',
  name: 'download',
  description: 'Export selected Pinduoduo 消费者负向体验补偿 list/detail fields to one Excel worksheet; defaults to the latest 7 calendar days.',
  access: 'read',
  example: 'opencli --profile opc-pro1 pinduoduo-complain-appeal download --store-name "拼多多店铺全称" --account "登录账号" --password "登录密码" --store-short-name "拼多多1店" --site-session persistent --keep-tab true --window foreground -f json',
  domain: 'mms.pinduoduo.com',
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'store-name', type: 'string', default: '', help: 'Expected Pinduoduo store name; verifies the current login. Supports PINDUODUO_STORE_NAME.' },
    { name: 'account', type: 'string', default: '', help: 'Pinduoduo account used only when the profile is not logged in. Supports PINDUODUO_ACCOUNT.' },
    { name: 'password', type: 'string', default: '', help: 'Pinduoduo password used only when the profile is not logged in. Supports PINDUODUO_PASSWORD.' },
    { name: 'store-short-name', type: 'string', default: '', help: 'Store abbreviation used in the Excel filename. Defaults to store-name, then the detected store. Supports PINDUODUO_STORE_SHORT_NAME.' },
    { name: 'home-url', type: 'string', default: DEFAULT_HOME_URL, help: 'Pinduoduo merchant home URL. Supports PINDUODUO_HOME_URL.' },
    { name: 'appeal-url', type: 'string', default: DEFAULT_APPEAL_URL, help: '消费者负向体验补偿明细 URL. Supports PINDUODUO_COMPLAIN_APPEAL_URL.' },
    { name: 'date', type: 'string', default: '', help: 'Convenience date for both start and end (YYYY-MM-DD). Supports PINDUODUO_COMPLAIN_APPEAL_DATE.' },
    { name: 'start-date', type: 'string', default: DEFAULT_RANGE.startDate, help: `Create-time start (YYYY-MM-DD). Defaults to ${DEFAULT_RANGE.startDate}, matching the page's latest-7-days default. Supports PINDUODUO_COMPLAIN_APPEAL_START_DATE.` },
    { name: 'end-date', type: 'string', default: DEFAULT_RANGE.endDate, help: `Create-time end (YYYY-MM-DD). Defaults to ${DEFAULT_RANGE.endDate}. Supports PINDUODUO_COMPLAIN_APPEAL_END_DATE.` },
    { name: 'order-sn', type: 'string', default: '', help: 'Optional complete order number. Supports PINDUODUO_COMPLAIN_APPEAL_ORDER_SN.' },
    { name: 'status', type: 'string', default: 'all', help: `Processing filter: ${Object.keys(STATUS_FILTERS).join(' / ')}.` },
    { name: 'page-size', type: 'int', default: 20, help: 'API page size; defaults to the page UI value 20 (max 100).' },
    { name: 'detail-concurrency', type: 'int', default: 3, help: 'Concurrent read-only detail requests (max 10).' },
    { name: 'output-dir', type: 'string', default: DEFAULT_OUTPUT_DIR, help: 'Directory for the Excel file. Supports PINDUODUO_COMPLAIN_APPEAL_OUTPUT_DIR.' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Replace an existing Excel file with the same store abbreviation and date range.' },
    { name: 'login-timeout', type: 'int', default: 180, help: 'Seconds to wait for login and any manual verification.' },
    { name: 'page-timeout', type: 'int', default: 60, help: 'Seconds to wait for the appeal page.' },
    { name: 'timeout', type: 'int', default: 900, help: 'Max seconds for the overall command (default: 900).' },
  ],
  columns: ['status', 'storeName', 'storeShortName', 'startDate', 'endDate', 'filter', 'rowCount', 'detailCount', 'filename', 'filePath', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for pinduoduo-complain-appeal download');

    const expectedStoreName = stringArg(argument(kwargs, 'store-name', 'storeName'), 'PINDUODUO_STORE_NAME');
    const account = stringArg(argument(kwargs, 'account', 'account'), 'PINDUODUO_ACCOUNT');
    const password = stringArg(argument(kwargs, 'password', 'password'), 'PINDUODUO_PASSWORD');
    const requestedShortName = stringArg(argument(kwargs, 'store-short-name', 'storeShortName'), 'PINDUODUO_STORE_SHORT_NAME');
    const homeUrl = pinduoduoUrl(
      stringArg(argument(kwargs, 'home-url', 'homeUrl'), 'PINDUODUO_HOME_URL', DEFAULT_HOME_URL),
      'home-url',
    );
    const appealUrl = pinduoduoUrl(
      stringArg(argument(kwargs, 'appeal-url', 'appealUrl'), 'PINDUODUO_COMPLAIN_APPEAL_URL', DEFAULT_APPEAL_URL),
      'appeal-url',
    );
    const singleDate = stringArg(argument(kwargs, 'date', 'date'), 'PINDUODUO_COMPLAIN_APPEAL_DATE');
    const startDate = validDate(
      singleDate
        || process.env.PINDUODUO_COMPLAIN_APPEAL_START_DATE
        || argument(kwargs, 'start-date', 'startDate')
        || DEFAULT_RANGE.startDate,
      'start-date',
    );
    const endDate = validDate(
      singleDate
        || process.env.PINDUODUO_COMPLAIN_APPEAL_END_DATE
        || argument(kwargs, 'end-date', 'endDate')
        || DEFAULT_RANGE.endDate,
      'end-date',
    );
    if (startDate > endDate) throw new ArgumentError('start-date must be on or before end-date');
    const orderSn = stringArg(argument(kwargs, 'order-sn', 'orderSn'), 'PINDUODUO_COMPLAIN_APPEAL_ORDER_SN');
    const filterName = String(argument(kwargs, 'status', 'status') || 'all').trim().toLowerCase();
    const statusFilter = STATUS_FILTERS[filterName];
    if (!statusFilter) {
      throw new ArgumentError(`status must be one of: ${Object.keys(STATUS_FILTERS).join(', ')}`);
    }
    const pageSize = positiveInt(argument(kwargs, 'page-size', 'pageSize'), 'page-size', 100);
    const detailConcurrency = positiveInt(argument(kwargs, 'detail-concurrency', 'detailConcurrency'), 'detail-concurrency', 10);
    const outputDir = path.resolve(stringArg(
      argument(kwargs, 'output-dir', 'outputDir'),
      'PINDUODUO_COMPLAIN_APPEAL_OUTPUT_DIR',
      DEFAULT_OUTPUT_DIR,
    ));
    const overwrite = booleanArg(argument(kwargs, 'overwrite', 'overwrite'), false, 'overwrite');
    const loginTimeout = positiveInt(argument(kwargs, 'login-timeout', 'loginTimeout'), 'login-timeout');
    const pageTimeout = positiveInt(argument(kwargs, 'page-timeout', 'pageTimeout'), 'page-timeout');

    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      throw new CommandExecutionError(`Could not create output directory ${outputDir}: ${error?.message || error}`);
    }
    if (!fs.statSync(outputDir).isDirectory()) throw new ArgumentError(`output-dir is not a directory: ${outputDir}`);

    const home = await ensureLoggedIn(page, homeUrl, account, password, loginTimeout);
    assertStore(expectedStoreName, home.storeName);
    const appealPage = await waitForAppealPage(page, appealUrl, pageTimeout);
    const actualStoreName = appealPage.storeName || home.storeName || expectedStoreName;
    assertStore(expectedStoreName, actualStoreName);
    if (!actualStoreName) throw new CommandExecutionError('Could not determine the current Pinduoduo store name');
    const storeShortName = sanitizeFilePart(requestedShortName || expectedStoreName || actualStoreName, 'store-short-name');

    const query = {
      start: localDayTimestamp(startDate),
      end: localDayTimestamp(endDate, true),
      appealStatusIn: [...statusFilter.appealStatusIn],
      statusIn: [...statusFilter.statusIn],
      ...(statusFilter.exemptionType ? { exemptionType: statusFilter.exemptionType } : {}),
      ...(orderSn ? { orderSn } : {}),
    };
    const listResult = await fetchAllListRows(page, appealUrl, query, pageSize);
    const appealListTabs = Array.isArray(listResult.responseMeta.appealListTabs)
      ? listResult.responseMeta.appealListTabs
      : [];
    const records = await fetchDetails(
      page,
      appealUrl,
      listResult.rows,
      detailConcurrency,
      appealListTabs,
    );

    const filename = `订单申诉明细-${storeShortName}-${startDate}_${endDate}.xlsx`;
    const targetPath = path.join(outputDir, filename);
    writeExcelArchive(targetPath, records, overwrite);

    return [{
      status: records.length ? 'downloaded' : 'no_data',
      storeName: actualStoreName,
      storeShortName,
      startDate,
      endDate,
      filter: filterName,
      rowCount: listResult.rows.length,
      detailCount: records.length,
      filename,
      filePath: targetPath,
      url: appealUrl,
    }];
  },
});
