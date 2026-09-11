/**
 * pinduoduo-trade-overview / download
 *
 * Source: generated from live exploration of mms.pinduoduo.com on 2026-09-10.
 * Author: agent session share-79590e5950374203 (account: 箭ARROW官方旗舰店_红提2 / opencli profile opc-pro1)
 *
 * 目标：拼多多商家后台 → 交易数据 → 交易概况，取指定日期（默认昨天）的
 *       「成交金额」与「退款金额」，输出 Excel。
 *
 * 重要实现依据（均已实测验证）：
 * 1. 页面卡片数值由 /sydney/api/mallTrade/getMallTradeInfo 返回，但开启 spiderFont 后
 *    数字被字体混淆（私用区码点），无法直接读出；
 * 2. 同一页面的日维度数据接口 /sydney/api/mallTrade/queryMallTradeList 返回**明文数字**，
 *    其 dayList 中 payOrdrAmt = 成交金额、sucRfOrdrAmt1d = 退款金额；
 *    实测 2026-08-11~2026-09-09 区间 dayList 合计 716,794 与页面卡片「成交金额」完全一致，
 *    因此以该接口为权威取数来源；
 * 3. 该接口除 body 的 {queryType, queryDate, startDate, endDate} 外，还必须带
 *    查询字符串参数 dateShortDisplay=<结束日期>，否则服务端返回非法请求/参数为空。
 */
import fs from 'node:fs';
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
const DEFAULT_OVERVIEW_URL = 'https://mms.pinduoduo.com/sycm/stores_data/operation';
const TRADE_LIST_API = '/sydney/api/mallTrade/queryMallTradeList';
// 页面「自定义」区间使用的 queryType（前端源码：custom 分支会附带 startDate/endDate）。
const CUSTOM_QUERY_TYPE = 2;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '600';
}

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

function validDate(value, label) {
  const result = String(value || '').trim();
  if (!DATE_RE.test(result)) throw new ArgumentError(`${label} must use YYYY-MM-DD`);
  const [year, month, day] = result.split('-').map(Number);
  const parsed = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (formatLocalDate(parsed) !== result) throw new ArgumentError(`${label} is not a valid calendar date`);
  return result;
}

function shiftDate(value, deltaDays) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  date.setDate(date.getDate() + deltaDays);
  return formatLocalDate(date);
}

function positiveInt(value, label, fallback, maxValue) {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new ArgumentError(`${label} must be a positive integer`);
  if (maxValue !== undefined && result > maxValue) throw new ArgumentError(`${label} must be <= ${maxValue}`);
  return result;
}

function resolveOutputDir(value) {
  return path.resolve(String(value || '.'));
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function localStamp() {
  const now = new Date();
  return `${formatLocalDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/* ------------------------------------------------------------------ *
 * 页面状态与登录（复用 pinduoduo-monthly-statement 的已验证选择器逻辑）
 * ------------------------------------------------------------------ */

async function pageSnapshot(page) {
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
    const fallbackStore = Array.from(document.querySelectorAll('header span[title], span[title]'))
      .filter(visible)
      .find((el) => !/TEMU入驻|课程|规则|帮助/.test(storeText(el)));
    const nextProps = window.__NEXT_DATA__?.props || {};
    const stateStoreName = nextProps.userInfo?.mall?.mall_name
      || nextProps.headerProps?.serverData?.userInfo?.mall?.mall_name
      || nextProps.headerProps?.serverData?.userInfo?.all?.mall?.mall_name
      || '';
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(visible);
    return {
      url: location.href,
      title: document.title || '',
      body,
      loggedIn: Boolean(document.querySelector('#mms-header-next'))
        || (body.includes('商家后台') && (body.includes('退出当前账号') || body.includes('后台首页'))),
      storeName: storeText(headerStore) || storeText(fallbackStore) || stateStoreName,
      accountLoginVisible: Array.from(document.querySelectorAll('button, [role="button"], div, span'))
        .some((el) => visible(el) && (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '账号登录'),
      loginFormVisible: visibleInputs.some((el) => el.type === 'password'),
      verificationVisible: /验证码|安全验证|请完成验证|拖动滑块|滑块验证/.test(body),
    };
  })()`);
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
  let state = await pageSnapshot(page);
  while (Date.now() < initialDeadline && !state.loggedIn && !state.accountLoginVisible && !state.loginFormVisible) {
    await page.wait(0.5);
    state = await pageSnapshot(page);
  }
  if (state.loggedIn) return state;

  if (!account || !password) {
    throw new AuthRequiredError(
      'mms.pinduoduo.com',
      'Pinduoduo is not logged in; pass --account and --password (or PINDUODUO_ACCOUNT / PINDUODUO_PASSWORD), or log in manually in the OpenCLI profile',
    );
  }

  if (state.accountLoginVisible) {
    const marked = await markExactText(page, 'pdd-account-login', '账号登录');
    if (marked) await nativeClickSelector(page, '[data-opencli-pdd-account-login="1"]', 'Pinduoduo account-login entry was not clickable');
    await page.wait(0.5);
  }

  const formDeadline = Date.now() + 15000;
  state = await pageSnapshot(page);
  while (Date.now() < formDeadline && !state.loginFormVisible) {
    await page.wait(0.5);
    state = await pageSnapshot(page);
  }
  if (!state.loginFormVisible) throw new CommandExecutionError('Pinduoduo account/password login form did not appear');

  await fillLoginForm(page, account, password);
  const loginDeadline = Date.now() + loginTimeoutSeconds * 1000;
  while (Date.now() < loginDeadline) {
    await page.wait(1);
    state = await pageSnapshot(page);
    if (state.loggedIn) return state;
    if (state.verificationVisible) {
      process.stderr.write('Pinduoduo login needs a manual verification step; complete it in the visible browser window.\n');
    }
  }
  if (state.verificationVisible) throw new TimeoutError('Pinduoduo manual verification and login', loginTimeoutSeconds);
  throw new AuthRequiredError('mms.pinduoduo.com', 'Pinduoduo account login did not reach the authenticated merchant home page');
}

/* ------------------------------------------------------------------ *
 * 交易概况页：自定义日期面板交互（与用户描述的流程一致；失败不阻断取数）
 * ------------------------------------------------------------------ */

async function overviewSnapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const body = document.body?.innerText || '';
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    const group = document.querySelector('[class*="date-picker-group_date-picker-group-wrap"]');
    const items = group ? Array.from(group.querySelectorAll('[class*="date-picker-item-inner"]'))
      .map((el) => textOf(el)) : [];
    const confirmButtons = Array.from(document.querySelectorAll('button'))
      .filter((el) => visible(el) && textOf(el) === '确认');
    return {
      url: location.href,
      title: document.title || '',
      body,
      rangeReady: items.length > 0,
      rangeItems: items,
      customVisible: items.includes('自定义'),
      customPanels: Array.from(document.querySelectorAll('[class*="date-picker-group"]'))
        .filter((el) => textOf(el).includes('自定义')).length,
      confirmCount: confirmButtons.length,
      loginFormVisible: Array.from(document.querySelectorAll('input')).some((el) => visible(el) && el.type === 'password'),
      panelPlaceholder: /请选择开始日期|请选择结束日期/.test(body),
    };
  })()`);
}

async function waitForOverviewPage(page, overviewUrl, timeoutSeconds) {
  await page.goto(overviewUrl);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let state = await overviewSnapshot(page);
  while (Date.now() < deadline) {
    if (state.rangeReady && /交易概况/.test(state.body)) return state;
    if (state.loginFormVisible || /账号登录|登录已失效/.test(state.body) || /\/login(?:[/?#]|$)/i.test(state.url)) {
      throw new AuthRequiredError('mms.pinduoduo.com', 'Pinduoduo merchant session expired while opening 交易数据/交易概况');
    }
    await page.wait(0.5);
    state = await overviewSnapshot(page);
  }
  throw new TimeoutError('Pinduoduo 交易概况 page', timeoutSeconds);
}

async function openCustomDatePanel(page) {
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    document.querySelectorAll('[data-opencli-pdd-custom]').forEach((el) => el.removeAttribute('data-opencli-pdd-custom'));
    const inner = Array.from(document.querySelectorAll('[class*="date-picker-group_date-picker-item-inner"]'))
      .filter(visible)
      .find((el) => textOf(el) === '自定义');
    if (!inner) return false;
    const host = inner.parentElement || inner;
    host.setAttribute('data-opencli-pdd-custom', '1');
    return true;
  })()`);
  if (!marked) return { ok: false, note: '自定义 入口未找到' };
  try {
    await page.click('[data-opencli-pdd-custom="1"]');
  } catch (error) {
    return { ok: false, note: `自定义 点击失败: ${error?.message || error}` };
  }
  await page.wait(1.5);
  const state = await overviewSnapshot(page);
  const opened = state.confirmCount > 0 || state.panelPlaceholder;
  return { ok: opened, note: opened ? '' : '日期面板未出现（确认按钮未找到）' };
}

async function pickCalendarDay(page, date) {
  const [year, month, day] = date.split('-').map(Number);
  const picked = await page.evaluate(`(() => {
    const wanted = { year: ${year}, month: ${month}, day: ${day} };
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const pad = (n) => String(n).padStart(2, '0');
    document.querySelectorAll('[data-opencli-pdd-day]').forEach((el) => el.removeAttribute('data-opencli-pdd-day'));
    const cells = Array.from(document.querySelectorAll('td, [class*="cell"], [class*="day"]'))
      .filter(visible)
      .filter((el) => /^(?:0?[1-9]|[12]\\d|3[01])$/.test((el.innerText || el.textContent || '').replace(/\\s+/g, '').trim()));
    // 面板里会有多个月份，优先选“未置灰 + 尺寸合理”的同号日期单元格
    const candidates = cells.filter((el) => {
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
      return Number(text) === wanted.day;
    });
    const target = candidates[candidates.length - 1] || candidates[0];
    if (!target) return { ok: false, total: cells.length };
    const rect = target.getBoundingClientRect();
    target.setAttribute('data-opencli-pdd-day', '1');
    return { ok: true, total: cells.length, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!picked.ok) return { ok: false, note: `日历中未找到 ${day} 号单元格` };
  try {
    if (typeof page.nativeClick === 'function') await page.nativeClick(picked.x, picked.y);
    else await page.click('[data-opencli-pdd-day="1"]');
  } catch (error) {
    return { ok: false, note: `日历点击失败: ${error?.message || error}` };
  }
  await page.wait(0.8);
  return { ok: true, note: '' };
}

async function confirmDatePanel(page) {
  const state = await overviewSnapshot(page);
  if (!state.confirmCount) return { ok: false, note: '日期面板确认按钮未找到' };
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    document.querySelectorAll('[data-opencli-pdd-confirm]').forEach((el) => el.removeAttribute('data-opencli-pdd-confirm'));
    const buttons = Array.from(document.querySelectorAll('button')).filter((el) => visible(el) && textOf(el) === '确认');
    if (!buttons.length) return false;
    buttons[0].setAttribute('data-opencli-pdd-confirm', '1');
    return true;
  })()`);
  if (!marked) return { ok: false, note: '日期面板确认按钮未找到' };
  try {
    await page.click('[data-opencli-pdd-confirm="1"]');
  } catch (error) {
    return { ok: false, note: `确认点击失败: ${error?.message || error}` };
  }
  await page.wait(2.5);
  return { ok: true, note: '' };
}

/**
 * 按用户描述的顺序驱动页面：自定义 → （默认昨天，或指定日期）→ 确认 → 等待刷新。
 * 该过程只影响页面展示；取数以接口为准，因此失败仅记录，不中断。
 */
async function applyDateRangeOnPage(page, date) {
  const notes = [];
  const yesterday = yesterdayLocal();
  const panel = await openCustomDatePanel(page);
  if (!panel.ok) notes.push(panel.note);
  if (panel.ok && date !== yesterday) {
    const day = await pickCalendarDay(page, date);
    if (!day.ok) notes.push(day.note);
  }
  const confirmed = await confirmDatePanel(page);
  if (!confirmed.ok) notes.push(confirmed.note);
  return notes.filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 取数：明文日维度接口
 * ------------------------------------------------------------------ */

async function fetchTradeSeries(page, overviewUrl, startDate, endDate) {
  const url = new URL(TRADE_LIST_API, overviewUrl);
  // dateShortDisplay 必须放在查询字符串里，放进 body 会被服务端判为非法请求。
  url.searchParams.set('dateShortDisplay', endDate);

  let payload;
  try {
    payload = await page.fetchJson(url.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        queryType: CUSTOM_QUERY_TYPE,
        queryDate: endDate,
        startDate,
        endDate,
      },
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (/401|403|login|登录|AUTH/i.test(message)) {
      throw new AuthRequiredError('mms.pinduoduo.com', '交易概览取数需要已登录的拼多多商家会话');
    }
    throw new CommandExecutionError(`拼多多交易概览取数失败: ${message}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new CommandExecutionError('拼多多交易概览接口返回了非 JSON 内容');
  }
  if (payload.success !== true) {
    const message = payload.errorMsg || payload.error_msg || `errorCode=${payload.errorCode ?? 'unknown'}`;
    if (/login|登录|未登录|认证/i.test(String(message))) {
      throw new AuthRequiredError('mms.pinduoduo.com', `拼多多交易概览接口拒绝访问: ${message}`);
    }
    throw new CommandExecutionError(`拼多多交易概览接口报错: ${message}`);
  }
  const result = payload.result || {};
  const dayList = Array.isArray(result.dayList) ? result.dayList : [];
  if (!dayList.length) {
    throw new CommandExecutionError('拼多多交易概览接口未返回 dayList 日明细');
  }
  return dayList.map((row) => ({
    date: String(row.stateDate || ''),
    gmv: typeof row.payOrdrAmt === 'number' ? round2(row.payOrdrAmt) : null,
    refundAmount: typeof row.sucRfOrdrAmt1d === 'number' ? round2(row.sucRfOrdrAmt1d) : null,
    orderCount: typeof row.payOrdrCnt === 'number' ? row.payOrdrCnt : null,
    buyerCount: typeof row.payOrdrUsrCnt === 'number' ? row.payOrdrUsrCnt : null,
    aup: typeof row.payOrdrAup === 'number' ? round2(row.payOrdrAup) : null,
    refundOrderCount: typeof row.sucRfOrdrCnt1d === 'number' ? row.sucRfOrdrCnt1d : null,
  })).filter((row) => DATE_RE.test(row.date));
}

/* ------------------------------------------------------------------ *
 * Excel 导出
 * ------------------------------------------------------------------ */

function writeExcel(targetPath, payload) {
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-xlsx.mjs');
  if (!fs.existsSync(scriptPath)) {
    throw new CommandExecutionError(`Excel 导出器缺失: ${scriptPath}`);
  }
  const result = spawnSync(process.execPath, [scriptPath, targetPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw new CommandExecutionError(`无法启动 Excel 导出器: ${result.error.message}`);
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new CommandExecutionError(`写入 Excel 失败 ${targetPath}: ${message}`);
  }
  if (!fs.existsSync(targetPath)) {
    throw new CommandExecutionError(`Excel 导出器未生成文件: ${targetPath}`);
  }
}

cli({
  site: 'pinduoduo-trade-overview',
  name: 'download',
  description: '读取拼多多商家后台 交易数据→交易概况 的「成交金额」「退款金额」(指定日期，默认昨天) 并导出 Excel。',
  access: 'read',
  example: 'opencli --profile opc-pro1 pinduoduo-trade-overview download --date 2026-09-09 --account "登录账号" --password "登录密码" --output . --site-session persistent --keep-tab true --window foreground -f yaml',
  domain: 'pinduoduo.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'date', type: 'string', default: '', help: '统计日期 YYYY-MM-DD，默认昨天。' },
    { name: 'days', type: 'int', default: 1, help: '从 --date 往前连续导出的天数（默认 1，即仅该日）。' },
    { name: 'account', type: 'string', default: '', help: '登录账号；默认读 PINDUODUO_ACCOUNT。' },
    { name: 'password', type: 'string', default: '', help: '登录密码；默认读 PINDUODUO_PASSWORD。' },
    { name: 'store-name', type: 'string', default: '', help: '期望店铺名（可选，用于校验登录店铺）。' },
    { name: 'store-alias', type: 'string', default: '', help: '店铺简称，自动追加「销售」后缀用作文件名前缀（如 拼多多1店 → 拼多多1店销售-2026-09-09.xlsx）；不传则用默认命名 <日期>拼多多交易概览.xlsx。' },
    { name: 'output', type: 'string', default: '.', help: 'Excel 输出目录，文件名 <日期前缀>拼多多交易概览.xlsx。' },
    { name: 'overwrite', type: 'string', default: 'false', help: '文件已存在时是否覆盖 true/false。' },
    { name: 'timeout', type: 'int', default: 600, help: '整个命令的最长秒数（默认 600）。' },
  ],
  columns: ['status', 'date', 'range', 'gmv', 'refundAmount', 'orderCount', 'refundOrderCount', 'file', 'uiNote'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('pinduoduo-trade-overview download 需要浏览器会话');

    const endDate = validDate(kwargs.date || process.env.PINDUODUO_TRADE_DATE || yesterdayLocal(), 'date');
    const days = positiveInt(kwargs.days, 'days', 1, 90);
    const startDate = shiftDate(endDate, -(days - 1));
    const account = String(kwargs.account || process.env.PINDUODUO_ACCOUNT || '').trim();
    const password = String(kwargs.password || process.env.PINDUODUO_PASSWORD || '');
    const expectedStore = String(kwargs['store-name'] || kwargs.storeName || process.env.PINDUODUO_STORE_NAME || '').trim();
    const storeAlias = String(kwargs['store-alias'] || kwargs.storeAlias || process.env.PINDUODUO_STORE_ALIAS || '').trim();
    const filePrefix = storeAlias ? (storeAlias.endsWith('销售') ? storeAlias : `${storeAlias}销售`) : '';
    const outputDir = resolveOutputDir(kwargs.output);
    const overwrite = String(kwargs.overwrite ?? 'false').trim().toLowerCase() === 'true';
    const timeoutSeconds = positiveInt(kwargs.timeout, 'timeout', 600, 3600);

    const homeState = await ensureLoggedIn(page, DEFAULT_HOME_URL, account, password, Math.min(timeoutSeconds, 300));
    if (expectedStore && homeState.storeName
      && !homeState.storeName.includes(expectedStore) && !expectedStore.includes(homeState.storeName)) {
      throw new CommandExecutionError(`登录店铺不符：期望 "${expectedStore}"，当前 "${homeState.storeName}"`);
    }

    await waitForOverviewPage(page, DEFAULT_OVERVIEW_URL, 60);
    const overviewState = await overviewSnapshot(page);
    const uiNotes = await applyDateRangeOnPage(page, endDate);

    const series = await fetchTradeSeries(page, DEFAULT_OVERVIEW_URL, startDate, endDate);
    const inRange = series.filter((row) => row.date >= startDate && row.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    const target = inRange.find((row) => row.date === endDate);
    if (!target) {
      throw new CommandExecutionError(
        `接口未返回 ${endDate} 的日明细（可返回区间 ${series[0]?.date || '?'} ~ ${series[series.length - 1]?.date || '?'}）`,
      );
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = filePrefix
      ? (days > 1 ? `${filePrefix}-${startDate}_${endDate}.xlsx` : `${filePrefix}-${endDate}.xlsx`)
      : (days > 1 ? `${startDate}_${endDate}拼多多交易概览.xlsx` : `${endDate}拼多多交易概览.xlsx`);
    const filePath = path.join(outputDir, fileName);
    if (fs.existsSync(filePath) && !overwrite) {
      throw new CommandExecutionError(`目标文件已存在: ${filePath}；需要覆盖请加 --overwrite true`);
    }

    writeExcel(filePath, {
      storeName: homeState.storeName || overviewState.storeName || '',
      startDate,
      endDate,
      target,
      daily: inRange,
      sourceUrl: DEFAULT_OVERVIEW_URL,
      fetchedAt: `${localStamp()} Asia/Shanghai`,
    });

    return inRange.map((row) => ({
      status: 'ok',
      date: row.date,
      range: `${startDate}~${endDate}`,
      gmv: row.gmv,
      refundAmount: row.refundAmount,
      orderCount: row.orderCount,
      refundOrderCount: row.refundOrderCount,
      file: filePath,
      uiNote: row.date === endDate ? uiNotes.join('; ') : '',
    }));
  },
});
