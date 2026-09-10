import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

// Xiaohongshu Juguang (聚光) - Campaign > Creativity (推广-创意) CSV download adapter.
// Generated 2026-09-09 from live-page exploration; modeled after xiaohongshu-juguang/download-note-report.js.
// Author account: shuzhihua-hongti@arrowlighting.cn
// Flow: login (email/password) -> goto creativity list -> set date (yesterday shortcut or typed date)
//       -> click export button on the last (creativity table) card -> rename CSV to YYYY-MM-DD聚光创意.csv -> logout.

const HOME_URL = 'https://ad.xiaohongshu.com';
const CREATIVE_URL = 'https://ad.xiaohongshu.com/aurora/ad/manage/creativity?vSellerId=6a587f389dba8100152bd1d1';
// Switching via changeAccount=true pins the session to the target seller (箭牌照明01).
// Visiting the creativity URL directly after a fresh login keeps the default seller instead.
const SWITCH_URL = 'https://ad.xiaohongshu.com/aurora/ad/manage/campaign?changeAccount=true&vSellerId=6a587f389dba8100152bd1d1';
const T_ACCOUNT_NAME = '\u7bad\u724c\u7167\u660e01'; // 箭牌照明01
const DEFAULT_EMAIL = 'shuzhihua-hongti@arrowlighting.cn';
const DEFAULT_PASSWORD = 'Hongti*123';
if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '600';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Downloaded file is named "创意-数据.csv" by the platform.
const DOWNLOAD_BASENAME_RE = /^\u521b\u610f-\u6570\u636e.*\.csv$/i;
// Matched strings are kept as \uXXXX escapes on purpose (file-encoding safe).
const T_ACCOUNT_LOGIN = '\u8d26\u53f7\u767b\u5f55'; // 账号登录
const T_LOGIN = '\u767b\u5f55'; // 登录
const T_YESTERDAY = '\u6628\u5929'; // 昨天
const T_CREATIVE_FILTER = '\u521b\u610f\u7b5b\u9009'; // 创意筛选 (creativity table card marker)
const T_CREATIVE_NAME = '\u521b\u610f\u540d\u79f0'; // 创意名称
const T_LOGOUT = '\u767b\u51fa'; // 登出
const T_LOGOUT_ALT = '\u9000\u51fa\u767b\u5f55'; // 退出登录
const T_NEW_AD = '\u65b0\u5efa\u5e7f\u544a'; // 新建广告
// Reference export 创意-数据.csv has 39 columns: fixed identity columns are always included;
// the selectable set below is ordered dimension columns first, then the 24 default metrics,
// matching the reference header exactly (verified 2026-09-09 against \\...\temp\创意-数据 9.8.csv).
const FULL_COLUMN_ORDER = ['marketingTarget', 'placement', 'optimizeObjective', 'deepOptimizeObjective', 'conversionType', 'campaignName', 'unitName', 'creativityId', 'noteId', 'itemId', 'creativityCreateTime', 'fee', 'impression', 'click', 'ctr', 'acp', 'cpm', 'interaction', 'cpi', 'videoPlay5sCnt', 'videoPlay5sRate', 'iUserNum', 'iUserPrice', 'tiUserNum', 'tiUserPrice', 'messageConsult', 'initiativeMessage', 'msgLeadsNum', 'messageConsultCpl', 'initiativeMessageCpl', 'msgLeadsCost', 'externalGoodsOrder15', 'externalGoodsOrderRate15New', 'outClickEnterStoreCnt15d', 'outClickEnterStoreCvr15dNew'];
// The creativity manage page persists its table column config in localStorage under a key like
// "<login-seller-prefix>-indicator-promotion-manage" (observed prefix: 5f13db5d0000000001005785).
const COLUMN_CONFIG_KEY_SUFFIX = 'indicator-promotion-manage';
const COLUMN_CONFIG_KEY_FALLBACK = '5f13db5d0000000001005785-indicator-promotion-manage';

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
    throw new CommandExecutionError('Timed out waiting for Xiaohongshu Juguang creativity CSV download');
  }
  return candidate;
}

async function readPageState(page) {
  return await page.evaluate(`(() => {
    const q = (sel) => document.querySelector(sel);
    const isDate = (value) => {
      const text = String(value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => visible(input) && isDate(input.value));
    const bodyText = document.body.innerText || '';
    const compactText = bodyText.replace(/\\s+/g, '');
    const countMatch = bodyText.match(/\\u5171\\s*\\d+\\s*\\u6761/); // 共 N 条
    const hasEmailPassword = Boolean(visible(q('input[name="email"]')) && visible(q('input[name="password"]')));
    const hasLoginPrompt = compactText.includes('\\u8d26\\u53f7\\u767b\\u5f55') || compactText.includes('\\u77ed\\u4fe1\\u767b\\u5f55') || location.href.includes('login');
    const card = Array.from(document.querySelectorAll('.page-card')).find((el) => visible(el) && (el.innerText || '').includes('\\u521b\\u610f\\u7b5b\\u9009'));
    return {
      url: location.href,
      title: document.title || '',
      startDate: inputs[0]?.value || '',
      endDate: inputs[1]?.value || '',
      hasLoginForm: hasEmailPassword || hasLoginPrompt,
      hasCreative: Boolean(card) && bodyText.includes('\\u521b\\u610f\\u540d\\u79f0'),
      rowText: countMatch ? countMatch[0].trim() : '',
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
    document.querySelectorAll('[data-opencli-jgcreative-account-tab]').forEach((el) => el.removeAttribute('data-opencli-jgcreative-account-tab'));
    const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span'))
      .filter(visible)
      .sort((a, b) => textOf(a).length - textOf(b).length)
      .filter((el) => textOf(el) === ${JSON.stringify(T_ACCOUNT_LOGIN)});
    if (!candidates.length) return false;
    let target = candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 50 && rect.height >= 24;
    }) || candidates[0];
    if (target.getBoundingClientRect().height < 24 && target.parentElement && textOf(target.parentElement) === ${JSON.stringify(T_ACCOUNT_LOGIN)}) {
      target = target.parentElement;
    }
    target.setAttribute('data-opencli-jgcreative-account-tab', '1');
    return true;
  })()`);
  if (marked) await page.click('[data-opencli-jgcreative-account-tab]');
  await page.wait(0.5);
}

async function clickAccountLoginTabByEvents(page) {
  // Some persistent sessions swallow a plain .click() (SPA re-render between
  // mark and click). Dispatch a full mouse event sequence directly instead.
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim();
    const wanted = ${JSON.stringify(T_ACCOUNT_LOGIN)};
    const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span'))
      .filter(visible)
      .sort((a, b) => textOf(a).length - textOf(b).length);
    const target = nodes.find((el) => textOf(el) === wanted);
    if (!target) return false;
    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    target.click();
    return true;
  })()`);
}

async function waitForLoginFields(page) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      return visible(document.querySelector('input[name="email"]')) && visible(document.querySelector('input[name="password"]'));
    })()`);
    if (ready) return;

    // A captcha/slider wall would keep the fields hidden forever - surface it early.
    // Note: match whole phrases only; the login page always contains 验证码 words,
    // so single-character classes would false-positive on the SMS tab.
    const blocked = await page.evaluate(`(() => {
      const text = document.body.innerText || '';
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const captchaFrame = iframes.some((frame) => /captcha|geetest|nocaptcha|slider/i.test(String(frame.src || '')));
      const wallText = /滑块|安全验证|风险验证|请完成验证|请进行验证|拖动|向右滑动|验证失败|图形验证/.test(text);
      const emailInput = document.querySelector('input[name="email"]');
      const emailVisible = emailInput && (emailInput.offsetWidth || emailInput.offsetHeight);
      return (wallText || captchaFrame) && !emailVisible;
    })()`);
    if (blocked) {
      throw new CommandExecutionError('Login requires manual verification (slider/captcha); complete it in Chrome and rerun the command');
    }

    // Keep (re)clicking the 账号登录 tab; the SPA may drop the first clicks.
    await clickAccountLoginTabByEvents(page).catch(() => false);
    await page.wait(0.6);
  }
  let snapshot = '';
  try {
    snapshot = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const activeText = Array.from(document.querySelectorAll('[role="tab"], div, span'))
        .filter((el) => visible(el) && /\\u8d26\\u53f7\\u767b\\u5f55|\\u77ed\\u4fe1\\u767b\\u5f55/.test((el.innerText || '').replace(/\\s+/g, '')))
        .slice(0, 4)
        .map((el) => (el.innerText || '').replace(/\\s+/g, ''));
      return 'email=' + visible(document.querySelector('input[name="email"]'))
        + ' pass=' + visible(document.querySelector('input[name="password"]'))
        + ' tabs=' + activeText.join(',')
        + ' url=' + location.href;
    })()`);
  } catch {
    snapshot = 'unavailable';
  }
  throw new CommandExecutionError(`Email/password login fields did not appear. Page state: ${snapshot}`);
}

async function ensureLoggedIn(page, email, password) {
  await page.goto(CREATIVE_URL);
  await page.wait(2);

  let state = await readPageState(page);
  if (state.hasCreative) return;
  if (!state.hasLoginForm) {
    // Neither the report page nor the login form: revisit once, then fail.
    await page.goto(CREATIVE_URL);
    await page.wait(2);
    state = await readPageState(page);
    if (state.hasCreative) return;
    if (!state.hasLoginForm) throw new CommandExecutionError('Creativity page did not load and no login form was found');
  }

  await activateAccountLoginTab(page);
  await waitForLoginFields(page);

  if (!email || !password) {
    throw new CommandExecutionError('Juguang creativity login requires --email/--password or XHS_JUGUANG_EMAIL/XHS_JUGUANG_PASSWORD');
  }

  await setInputValue(page, 'input[name="email"]', email);
  await setInputValue(page, 'input[name="password"]', password);

  // Agree to the service terms checkbox (hidden input inside .checkbox-wrap).
  await page.evaluate(`(() => {
    const wrap = document.querySelector('.checkbox-wrap');
    const box = wrap ? wrap.querySelector('input[type="checkbox"]') : null;
    const fallback = Array.from(document.querySelectorAll('input[type="checkbox"]')).pop();
    const target = box || fallback;
    if (target && !target.checked) target.click();
  })()`);
  await page.wait(0.3);

  const clickedLogin = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const password = document.querySelector('input[name="password"]');
    const passwordRect = password?.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const loginText = ${JSON.stringify(T_LOGIN)};
    const target = buttons.find((button) => {
      const text = (button.innerText || button.textContent || '').replaceAll(' ', '');
      if (!text.includes(loginText)) return false;
      if (!passwordRect) return true;
      const rect = button.getBoundingClientRect();
      return rect.top > passwordRect.bottom - 8 && Math.abs((rect.left + rect.right) / 2 - (passwordRect.left + passwordRect.right) / 2) < 240;
    }) || buttons.find((button) => (button.innerText || button.textContent || '').replaceAll(' ', '').includes(loginText)) || null;
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clickedLogin) {
    const marked = await markButtonByText(page, 'jgcreative-submit-login', T_LOGIN);
    if (marked) await clickMarked(page, 'jgcreative-submit-login', 'Login button not found');
  }

  // Wait until the login form disappears (successful auth redirects away).
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.wait(1);
    state = await readPageState(page).catch(() => ({}));
    if (state.hasCreative) return;
    if (!state.hasLoginForm && !state.url.includes('/login')) {
      await page.goto(CREATIVE_URL);
      await page.wait(2);
      const again = await readPageState(page).catch(() => ({}));
      if (again.hasCreative) return;
      state = again;
    }
    const text = await page.evaluate(`document.body.innerText || ''`);
    if (/滑块|安全验证|风险验证|请完成验证|请进行验证|拖动滑块|向右滑动/.test(text)) {
      throw new CommandExecutionError('Login requires manual verification; complete it in Chrome and rerun the command');
    }
  }
  throw new CommandExecutionError('Login did not finish within 60 seconds');
}

async function isTargetAccountActive(page) {
  const text = await page.evaluate(`(document.title || '') + '|' + (document.body.innerText || '').slice(0, 3000)`);
  return text.includes(T_ACCOUNT_NAME) && !text.includes('login');
}

async function switchToTargetAccount(page) {
  // Idempotent: after a successful switch the page title shows 箭牌照明01.
  const already = await isTargetAccountActive(page).catch(() => false);
  if (already) return;
  await page.goto(SWITCH_URL);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await page.wait(1);
    const active = await isTargetAccountActive(page).catch(() => false);
    if (active) return;
    const text = await page.evaluate(`(document.body.innerText || '').slice(0, 1000)`).catch(() => '');
    if (text.includes('\u8d26\u53f7\u767b\u5f55') && text.includes('\u77ed\u4fe1\u767b\u5f55')) {
      throw new CommandExecutionError('Login page is still visible while switching account');
    }
  }
  throw new CommandExecutionError('Account switch to the target seller did not finish within 30 seconds');
}

async function ensureCreativePage(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await readPageState(page).catch(() => ({}));
    if (state.hasCreative) return state;
    if (state.hasLoginForm) throw new CommandExecutionError('Login page is still visible after login attempt');
    await page.wait(0.7);
  }
  throw new CommandExecutionError('Creativity page did not load');
}

function openDatePickerScript() {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => visible(input) && /^20\\d{2}-\\d{2}-\\d{2}$/.test(input.value || ''));
    inputs[0]?.click();
  })()`;
}

async function openDatePicker(page) {
  await page.evaluate(openDatePickerScript());
  try {
    await page.wait({ selector: '.d-datepicker-cell, .d-ranges, .d-popover', timeout: 8000 });
  } catch {
    throw new CommandExecutionError('Date picker did not open');
  }
}

async function clickYesterdayShortcut(page) {
  const marked = await markButtonByText(page, 'jgcreative-yesterday', [T_YESTERDAY, '\u6628\u65e5']); // 昨天 / 昨日
  if (!marked) return false;
  await clickMarked(page, 'jgcreative-yesterday', 'Yesterday shortcut not found');
  await page.wait(1.5);
  return true;
}

async function setDateInputsDirect(page, date) {
  // Mark the two page-level date inputs so we can drive them with real (Playwright)
  // keystrokes. Synthetic value-setter events do NOT update the SPA date state
  // (verified 2026-09-09: after a synthetic set the date rolls back on reload),
  // so this function must use page.fill instead of page.evaluate.
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const isDateInput = (input) => {
      const text = String(input.value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => visible(input) && isDateInput(input));
    if (inputs.length < 2) return false;
    inputs[0].setAttribute('data-opencli-jgcreative-date-start', '1');
    inputs[1].setAttribute('data-opencli-jgcreative-date-end', '1');
    return true;
  })()`);
  if (!marked) return false;

  await page.fill('[data-opencli-jgcreative-date-start]', date);
  await page.press('[data-opencli-jgcreative-date-start]', 'Enter');
  await page.fill('[data-opencli-jgcreative-date-end]', date);
  await page.press('[data-opencli-jgcreative-date-end]', 'Enter');
  await page.evaluate(`document.body.click()`);
  await page.wait(0.5);

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await page.wait(0.5);
    const state = await readPageState(page).catch(() => ({}));
    if (state.startDate === date && state.endDate === date) return true;
  }
  return false;
}

// The date-range inputs commit ONLY on real (trusted) interaction: typing or clicking a
// calendar day. Synthetic value-setter events update the visible text but roll back on
// reload (verified 2026-09-09), so the picker is driven with real page.click calls.
async function clickDayInOpenCalendar(page, year, month, day) {
  const res = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-jgcreative-day]').forEach((el) => el.removeAttribute('data-opencli-jgcreative-day'));
    const wantedYear = ${year}; const wantedMonth = ${month}; const wantedDay = ${day};
    const panels = Array.from(document.querySelectorAll('.d-datepicker-calendar, [class*="datepicker-calendar"]')).filter(visible);
    for (const panel of panels) {
      const headText = (panel.innerText || '').slice(0, 40);
      const match = headText.match(/(\d{4})\s*\u5e74\s*(\d{1,2})\s*\u6708/); // YYYY年M月
      if (!match) continue;
      if (Number(match[1]) !== wantedYear || Number(match[2]) !== wantedMonth) continue;
      const cells = Array.from(panel.querySelectorAll('.d-datepicker-cell')).filter(visible).filter((c) => !String(c.className || '').includes('disabled'));
      const cell = cells.find((c) => (c.innerText || c.textContent || '').trim() === String(wantedDay));
      if (!cell) return 'neednav';
      cell.setAttribute('data-opencli-jgcreative-day', '1');
      return 'clicked';
    }
    return 'neednav';
  })()`);
  if (res === 'clicked') {
    await page.click('[data-opencli-jgcreative-day]');
    await page.wait(0.8);
    return true;
  }
  return false;
}

async function navOpenCalendar(page, direction) {
  const res = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-jgcreative-nav]').forEach((el) => el.removeAttribute('data-opencli-jgcreative-nav'));
    const panels = Array.from(document.querySelectorAll('.d-datepicker-calendar, [class*="datepicker-calendar"]')).filter(visible);
    const arrows = [];
    for (const panel of panels) {
      arrows.push(...Array.from(panel.querySelectorAll('div, span')).filter((el) => visible(el) && el.querySelector('svg') && !((el.innerText || '').trim())));
    }
    if (!arrows.length) return false;
    arrows.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
    const target = ${direction} < 0 ? arrows[0] : arrows[arrows.length - 1];
    target.setAttribute('data-opencli-jgcreative-nav', '1');
    return true;
  })()`);
  if (!res) return false;
  await page.click('[data-opencli-jgcreative-nav]');
  await page.wait(0.6);
  return true;
}

// Pick a single-day range by real-clicking the day cell in the start and end pickers.
// The date inputs only commit on trusted interaction. The picker can be slow to open or
// close itself after a pick, so every step waits for the panel and retries opening it.
async function pickSingleDayRange(page, date) {
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const isDateInput = (input) => {
      const text = String(input.value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => visible(input) && isDateInput(input));
    if (inputs.length < 2) return false;
    inputs[0].setAttribute('data-opencli-jgcreative-date-start', '1');
    inputs[1].setAttribute('data-opencli-jgcreative-date-end', '1');
    return true;
  })()`);
  if (!marked) return false;

  const [year, month, day] = date.split('-').map((part) => Number(part));

  const panelCount = () => page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    return Array.from(document.querySelectorAll('.d-datepicker-calendar, [class*="datepicker-calendar"]')).filter(visible).length;
  })()`).catch(() => 0);

  // Click the input, then wait (with retries) until a calendar panel is visible.
  const ensurePanel = async (inputSelector) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.click(inputSelector);
      const waitUntil = Date.now() + 3500;
      while (Date.now() < waitUntil) {
        if ((await panelCount()) > 0) return true;
        await page.wait(0.35);
      }
      if ((await panelCount()) > 0) return true;
      await page.evaluate(`document.body.click()`).catch(() => {});
      await page.wait(0.3);
    }
    return false;
  };

  // With the panel open, locate the target day cell; nudge the month arrows when the
  // visible panel shows another month. Returns false when the panel disappears.
  const pickDay = async () => {
    for (let step = 0; step < 12; step += 1) {
      if (await clickDayInOpenCalendar(page, year, month, day)) return true;
      if ((await panelCount()) === 0) return false;
      const dir = step % 2 === 0 ? -1 : 1;
      if (!(await navOpenCalendar(page, dir))) return false;
      await page.wait(0.4);
    }
    return false;
  };

  // Start day: open the start input's calendar and pick the day.
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
    if (!(await ensurePanel('[data-opencli-jgcreative-date-start]'))) continue;
    ok = await pickDay();
  }
  if (!ok) return false;
  await page.wait(1);

  // End day: the picker usually stays open after the start pick; otherwise reopen it.
  ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
    if ((await panelCount()) === 0) {
      if (!(await ensurePanel('[data-opencli-jgcreative-date-end]'))) continue;
    }
    ok = await pickDay();
  }
  if (!ok) return false;
  await page.wait(1);

  // Close the panel and verify the committed range.
  await page.evaluate(`document.body.click()`).catch(() => {});
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await readPageState(page).catch(() => ({}));
    if (state.startDate === date && state.endDate === date) return true;
    await page.wait(0.5);
  }
  return false;
}

// Preferred date setter: drive the two page-level date inputs with native (trusted)
// keystrokes via opencli's fillText/pressKey (CDP Input.*), then let the page reload so
// the creativity list re-queries for the requested date. Synthetic value-setter events
// do NOT update the SPA date state (verified 2026-09-09: they roll back on reload).
async function setDateByTyping(page, date) {
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const isDateInput = (input) => {
      const text = String(input.value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => visible(input) && isDateInput(input));
    if (inputs.length < 2) return false;
    inputs[0].setAttribute('data-opencli-jgcreative-date-start', '1');
    inputs[1].setAttribute('data-opencli-jgcreative-date-end', '1');
    return true;
  })()`);
  if (!marked) return false;
  await page.fillText('[data-opencli-jgcreative-date-start]', date);
  await page.pressKey('Enter');
  await page.fillText('[data-opencli-jgcreative-date-end]', date);
  await page.pressKey('Enter');
  await page.evaluate(`document.body.click()`).catch(() => {});
  await page.wait(0.6);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await readPageState(page).catch(() => ({}));
    if (state.startDate === date && state.endDate === date) return true;
    await page.wait(0.5);
  }
  return false;
}

async function selectDate(page, date) {
  // Prefer native typing into the date inputs (trusted events); fall back to calendar clicks.
  if (await setDateByTyping(page, date)) return;
  if (await pickSingleDayRange(page, date)) return;
  const diag = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const isDateInput = (input) => {
      const text = String(input.value || '');
      return text.length === 10 && text.startsWith('20') && text[4] === '-' && text[7] === '-';
    };
    const inputs = Array.from(document.querySelectorAll('input.d-text')).filter((input) => visible(input) && isDateInput(input));
    const panels = Array.from(document.querySelectorAll('.d-datepicker-calendar, [class*="datepicker-calendar"]')).filter(visible);
    const heads = panels.map((p) => (p.innerText || '').slice(0, 20));
    const stage = window.__jgstage || '';
    return JSON.stringify({ dateInputs: inputs.length, values: inputs.map((i) => i.value), openPanels: panels.length, heads, stage });
  })()`).catch(() => 'diag-failed');
  throw new CommandExecutionError(`Could not set date ${date} through the calendar picker; diag=${diag}`);
}

// Fallback only: click the target day inside the visible calendar of the opened picker.
async function chooseSingleDateFallback(page, date) {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  await openDatePicker(page);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(`(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const wantedDay = ${day};
      const wantedMonth = ${month};
      const wantedYear = ${year};
      const cells = Array.from(document.querySelectorAll('.d-datepicker-cell')).filter((cell) => visible(cell) && !String(cell.className || '').includes('disabled'));
      const headerText = (document.querySelector('.d-datepicker-header')?.innerText || '') + (document.querySelector('.d-datepicker-selector')?.innerText || '');
      const headerMatch = headerText.match(/(\\d{4})\\s*\\u5e74\\s*(\\d{1,2})\\s*\\u6708/);
      let matchesMonth = false;
      if (headerMatch) {
        matchesMonth = Number(headerMatch[1]) === ${year} && Number(headerMatch[2]) === ${month};
      }
      const target = cells.find((cell) => {
        const text = (cell.innerText || cell.textContent || '').trim();
        return text === String(wantedDay) && (matchesMonth || !/prev|next|outside|other/i.test(String(cell.className || '')));
      });
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (clicked) {
      await page.wait(1.2);
      return;
    }
    // Try the previous/next month arrow buttons.
    const nav = await page.evaluate(`(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const header = Array.from(document.querySelectorAll('.d-datepicker-header, .d-datepicker-selector, [class*="datepicker"] span')).filter(visible);
      const arrows = header.filter((el) => el.querySelector('svg'));
      const target = arrows.find((el) => /\\u524d|prev/i.test((el.getAttribute('class') || '') + (el.getAttribute('aria-label') || '')))
        || arrows.find((el) => {
          const rect = el.getBoundingClientRect();
          const headerBox = (document.querySelector('.d-datepicker-header')?.getBoundingClientRect()) || rect;
          return rect.top >= headerBox.top - 10 && rect.left < headerBox.left + headerBox.width / 2;
        })
        || arrows[0];
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!nav) {
      await page.evaluate(`document.body.click()`);
      throw new CommandExecutionError(`Date cell not found in picker: ${date}`);
    }
    await page.wait(0.6);
  }
  throw new CommandExecutionError(`Date not found in picker: ${date}`);
}

async function waitForDateApplied(page, date) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await readPageState(page).catch(() => ({}));
    if (state.startDate === date && state.endDate === date && state.hasCreative) return state;
    await page.wait(0.7);
  }
  const state = await readPageState(page).catch(() => ({}));
  throw new CommandExecutionError(`Creativity page did not switch to ${date}; current range is ${state.startDate || ''} to ${state.endDate || ''}`);
}

// The creativity table card is the last .page-card on the page. Its export button is the
// right-most empty (icon-only) button in the card header row.
async function ensureFullColumnConfig(page) {
  // Persist the full 39-column layout (dimension columns first, then the default metrics)
  // into every creativity manage column-config key found in localStorage, plus the known key
  // so a fresh browser profile still gets the full layout. Then reload so the table header
  // and the CSV export both use the reference column order.
  const written = await page.evaluate(`(() => {
    const order = ${JSON.stringify(FULL_COLUMN_ORDER)};
    const suffix = ${JSON.stringify(COLUMN_CONFIG_KEY_SUFFIX)};
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.endsWith(suffix)) keys.push(key);
    }
    if (!keys.includes(${JSON.stringify(COLUMN_CONFIG_KEY_FALLBACK)})) keys.push(${JSON.stringify(COLUMN_CONFIG_KEY_FALLBACK)});
    for (const key of keys) {
      try {
        const cfg = JSON.parse(localStorage.getItem(key) || '{}');
        cfg.columns = order;
        localStorage.setItem(key, JSON.stringify(cfg));
      } catch (e) { /* keep other keys untouched */ }
    }
    return keys.length;
  })()`);
  if (!written) return false;
  await page.goto(CREATIVE_URL);
  await page.wait(1.5);
  return true;
}

async function waitForColumnConfigApplied(page) {
  // 营销诉求/所属计划 are dimension columns only present when the config took effect.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(`(() => {
      const body = document.body.innerText || '';
      return body.includes(${JSON.stringify('\u8425\u9500\u8bc9\u6c42')}) && body.includes(${JSON.stringify('\u6240\u5c5e\u8ba1\u5212')});
    })()`).catch(() => false);
    if (ok) return true;
    await page.wait(0.7);
  }
  const state = await readPageState(page).catch(() => ({}));
  const diag = await page.evaluate(`(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
    const cfgKeys = keys.filter((k) => k.includes('indicator'));
    const head = (document.body.innerText || '').replace(/\\s+/g, '|').slice(0, 400);
    return JSON.stringify({ cfgKeys, head });
  })()`).catch(() => 'no-diag');
  throw new CommandExecutionError(`Creativity column config did not apply; page state: title=${state.title || ''}, hasCreative=${state.hasCreative}; diag=${diag}`);
}

async function markExportButton(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-jgcreative-export]').forEach((el) => el.removeAttribute('data-opencli-jgcreative-export'));
    const cards = Array.from(document.querySelectorAll('.page-card')).filter((el) => visible(el) && (el.innerText || '').includes(${JSON.stringify(T_CREATIVE_FILTER)}));
    if (!cards.length) return false;
    const card = cards[cards.length - 1];
    const cardRect = card.getBoundingClientRect();
    const buttons = Array.from(card.querySelectorAll('button')).filter((el) => visible(el) && !(el.innerText || '').trim());
    const headerButtons = buttons.filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.top < cardRect.top + 140 && rect.left > cardRect.left + cardRect.width * 0.55;
    }).sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const target = headerButtons[0];
    if (!target) return false;
    target.setAttribute('data-opencli-jgcreative-export', '1');
    return true;
  })()`);
}

async function downloadCreativeCsv(page, date, outputDir) {
  const card = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const cards = Array.from(document.querySelectorAll('.page-card')).filter((el) => visible(el) && (el.innerText || '').includes(${JSON.stringify(T_CREATIVE_FILTER)}));
    if (!cards.length) return false;
    cards[cards.length - 1].scrollIntoView({ block: 'start' });
    return true;
  })()`);
  if (!card) throw new CommandExecutionError('Creativity table card not found');
  await page.wait(0.5);

  const marked = await markExportButton(page);
  if (!marked) throw new CommandExecutionError('Creativity export button not found');

  fs.mkdirSync(outputDir, { recursive: true });
  const startedAt = Date.now();
  const clicked = await page.evaluate(`(() => {
    const button = document.querySelector('[data-opencli-jgcreative-export]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new CommandExecutionError('Creativity export button not found');

  const targetPath = path.join(outputDir, `${date}\u805a\u5149\u521b\u610f.csv`); // YYYY-MM-DD聚光创意.csv
  let downloaded = null;
  try {
    downloaded = await waitForDownloadedCsv(downloadsDir(), startedAt, 90000);
  } catch {
    throw new CommandExecutionError('Timed out waiting for Xiaohongshu Juguang creativity CSV download');
  }
  // The destination may be locked (e.g. open in Excel). Retry briefly, then fall back to a
  // numbered file name (YYYY-MM-DD聚光创意 (1).csv ...) instead of failing the whole run.
  let finalPath = targetPath;
  if (fs.existsSync(targetPath)) {
    for (let attempt = 0; attempt < 6 && fs.existsSync(targetPath); attempt += 1) {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  if (fs.existsSync(targetPath)) {
    let alt = null;
    for (let n = 1; n <= 99; n += 1) {
      const candidate = path.join(outputDir, `${date}\u805a\u5149\u521b\u610f (${n}).csv`);
      if (!fs.existsSync(candidate)) {
        alt = candidate;
        break;
      }
    }
    if (!alt) throw new CommandExecutionError(`Output file ${targetPath} is locked and no numbered fallback name is available`);
    finalPath = alt;
  }
  fs.copyFileSync(downloaded.path, finalPath);
  try {
    fs.unlinkSync(downloaded.path);
  } catch {
    // Chrome may still hold the file briefly; the copied target is already complete.
  }
  return finalPath;
}

async function logout(page) {
  const hovered = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const topbar = document.querySelector('#topbar-new-box');
    const scope = topbar || document;
    let account = scope.querySelector('button.account_btn');
    if (!account || !visible(account)) {
      const buttons = Array.from(scope.querySelectorAll('button')).filter(visible);
      const newAdIndex = buttons.findIndex((button) => (button.innerText || button.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(T_NEW_AD)}));
      account = newAdIndex > 0 ? buttons[newAdIndex - 1] : null;
    }
    if (!account) return false;
    account.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    account.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return true;
  })()`);
  if (!hovered) return;
  await page.wait(0.8);

  const clicked = await page.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const labels = [${JSON.stringify(T_LOGOUT)}, ${JSON.stringify(T_LOGOUT_ALT)}];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span')).filter(visible);
    const target = nodes.sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length)
      .find((el) => labels.some((label) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').includes(label)));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await page.wait(0.8);
}

cli({
  site: 'xiaohongshu-juguang-creative',
  name: 'download-creative-report',
  description: 'Download Xiaohongshu Juguang Creativity (推广-创意) CSV for one date and log out.',
  access: 'read',
  example: 'opencli --profile opc-default xiaohongshu-juguang-creative download-creative-report --date 2026-09-08 --output . -f json',
  domain: 'ad.xiaohongshu.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'date', type: 'string', default: '', help: 'Report date YYYY-MM-DD. Defaults to yesterday; uses the "昨日/昨天" shortcut when unset.' },
    { name: 'email', type: 'string', default: '', help: 'Login email. Defaults to XHS_JUGUANG_EMAIL.' },
    { name: 'password', type: 'string', default: '', help: 'Login password. Defaults to XHS_JUGUANG_PASSWORD.' },
    { name: 'output', type: 'string', default: '.', help: 'Directory for YYYY-MM-DD聚光创意.csv.' },
    { name: 'timeout', type: 'int', default: 600, help: 'Max seconds for the overall command (default: 600).' },
  ],
  columns: ['status', 'date', 'account', 'file', 'rows', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu-juguang-creative download-creative-report');

    const date = requireDate(kwargs.date);
    const email = String(kwargs.email || process.env.XHS_JUGUANG_EMAIL || DEFAULT_EMAIL).trim();
    const password = String(kwargs.password || process.env.XHS_JUGUANG_PASSWORD || DEFAULT_PASSWORD);
    const outputDir = resolveOutputDir(kwargs.output);

    try {
      await ensureLoggedIn(page, email, password);
      await switchToTargetAccount(page);
      await page.goto(CREATIVE_URL);
      await page.wait(2);
      const state = await ensureCreativePage(page);
      // Hard guard: never export under the wrong seller account.
      const pageTitle = String(state.title || '');
      if (!pageTitle.includes(T_ACCOUNT_NAME)) {
        throw new CommandExecutionError(`Account guard failed: page title is "${pageTitle}", expected ${T_ACCOUNT_NAME}; aborting download`);
      }
      // Export layout must match the reference 39-column header; persist + reload before picking the date.
      // A fresh browser profile needs one extra round (write config -> reload -> verify), so retry once.
      let configOk = false;
      for (let attempt = 0; attempt < 2 && !configOk; attempt += 1) {
        await ensureFullColumnConfig(page);
        configOk = await waitForColumnConfigApplied(page).catch(() => false);
      }
      if (!configOk) {
        await waitForColumnConfigApplied(page); // throws with diagnostics on final failure
      }
      // The two page-level date inputs drive the whole manage view, but the creativity
      // list only re-queries on page load (verified 2026-09-09: editing the inputs does
      // not refresh an already-loaded list, so exporting right away yields the previous
      // day's data). Set the date, then reload so the list (and the CSV export) matches
      // the requested date.
      await selectDate(page, date);
      await page.goto(CREATIVE_URL);
      await page.wait(1.5);
      const applied = await waitForDateApplied(page, date);
      const file = await downloadCreativeCsv(page, date, outputDir);

      return [{
        status: 'ok',
        date,
        account: pageTitle.split('-')[0].trim(),
        file,
        rows: applied.rowText || '',
        url: applied.url || CREATIVE_URL,
      }];
    } finally {
      await logout(page).catch(() => {});
    }
  },
});
