import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const SITE = 'xiaohongshu-pgy';
const HOST = 'pgy.xiaohongshu.com';
const HOME_URL = `https://${HOST}/`;
const REPORT_URL = `https://${HOST}/solar/post-trade/content-manage`;
const DEFAULT_SHARE_DIR = String.raw`\\192.168.2.149\it部\红提RPA项目share\AiAH-04-新媒体木棉蒲公英`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTPUT_BASENAME = '新媒体蒲公英';

function pad(value) {
  return String(value).padStart(2, '0');
}

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseDate(value) {
  const date = String(value || todayLocal()).trim();
  if (!DATE_RE.test(date)) {
    throw new ArgumentError(`date must be YYYY-MM-DD, got: ${value || ''}`);
  }
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ArgumentError(`date must be a real calendar date, got: ${date}`);
  }
  const normalized = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  if (normalized !== date) {
    throw new ArgumentError(`date must be a real calendar date, got: ${date}`);
  }
  return date;
}

function parsePositiveInteger(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ArgumentError(`${name} must be a positive integer`);
  }
  return number;
}

function resolveOutputDir(value) {
  const output = String(value || '.').trim();
  if (!output) throw new ArgumentError('output must not be empty');
  return path.resolve(output);
}

function downloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

async function pageState(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '').trim();
    const bodyText = document.body?.innerText || '';
    const emailInput = document.querySelector('input[name="email"]');
    const passwordInput = document.querySelector('input[name="password"]');
    const controls = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], div, span'))
      .filter(visible);
    return {
      url: location.href,
      title: document.title || '',
      bodyText,
      hasReport: bodyText.includes('笔记报告'),
      hasEmail: visible(emailInput),
      hasPassword: visible(passwordInput),
      hasLoginFormDom: Boolean(emailInput && passwordInput),
      hasLoginButton: controls.some((element) => compact(element) === '登录'),
      hasVerification: /滑块|安全验证|风险验证|请完成验证|请进行验证/.test(bodyText),
    };
  });
}

async function navigate(page, url) {
  try {
    await page.goto(url, { waitUntil: 'none' });
  } catch (error) {
    const message = String(error?.message || error);
    if (!/navigate command was dispatched; it may have completed/i.test(message)) {
      throw new CommandExecutionError(`Could not navigate to ${url}: ${message}`);
    }
    // The bridge can reconnect after a redirect even though Chrome completed it.
    await page.wait(1);
  }
}

async function waitForPageState(page, predicate, deadline, label) {
  const allowedSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  while (Date.now() < deadline) {
    let state = null;
    try {
      state = await pageState(page);
    } catch {
      // A navigation may briefly invalidate the execution context.
    }
    if (state && predicate(state)) return state;
    await page.wait(0.5);
  }
  throw new TimeoutError(label, allowedSeconds);
}

async function markByText(page, marker, texts, selectors = 'button, [role="button"], [role="tab"], div, span') {
  const wanted = Array.isArray(texts) ? texts : [texts];
  return await page.evaluate(({ markerName, labels, query }) => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '').trim();
    document.querySelectorAll(`[data-opencli-${markerName}]`)
      .forEach((element) => element.removeAttribute(`data-opencli-${markerName}`));
    const candidates = Array.from(document.querySelectorAll(query))
      .filter(visible)
      .sort((left, right) => compact(left).length - compact(right).length);
    const exact = candidates.find((element) => labels.includes(compact(element)));
    const partial = candidates.find((element) => labels.some((label) => compact(element).includes(label)));
    const target = exact || partial;
    if (!target) return false;
    const clickable = target.closest('button, [role="button"], [role="tab"]') || target;
    clickable.setAttribute(`data-opencli-${markerName}`, '1');
    return true;
  }, { markerName: marker, labels: wanted, query: selectors });
}

async function clickMarked(page, marker, errorMessage) {
  const selector = `[data-opencli-${marker}]`;
  const found = await page.evaluate((query) => Boolean(document.querySelector(query)), selector);
  if (!found) throw new CommandExecutionError(errorMessage);
  await page.click(selector);
}

async function setControlledInput(page, selector, value) {
  const changed = await page.evaluate(({ query, nextValue }) => {
    const input = document.querySelector(query);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, nextValue);
    else input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === nextValue;
  }, { query: selector, nextValue: value });
  if (!changed) throw new CommandExecutionError(`Could not fill ${selector}`);
}

async function openLoginDialog(page) {
  const clicked = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '').trim();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const loginButtons = buttons.filter((element) => compact(element) === '登录');
    const accountButtons = buttons.filter((element) => compact(element) === '账号登录');
    const target = loginButtons.find((element) => element.getBoundingClientRect().top < 160)
      || loginButtons[0]
      || accountButtons[0];
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.click();
    return true;
  });
  if (!clicked) return false;
  await page.wait(0.5);
  return true;
}

async function activateAccountLogin(page) {
  const clicked = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '').trim();
    const form = document.querySelector('#login-form') || document.querySelector('input[name="email"]')?.closest('form');
    if (!form) return false;
    let root = form.parentElement;
    while (root && root !== document.body) {
      const text = compact(root);
      if (text.includes('短信登录') && text.includes('账号登录')) break;
      root = root.parentElement;
    }
    if (!root || root === document.body) return false;
    const candidates = Array.from(root.querySelectorAll('[role="tab"], [role="button"], button, div, span'))
      .filter(visible)
      .filter((element) => compact(element) === '账号登录')
      .sort((left, right) => compact(left.parentElement || left).length - compact(right.parentElement || right).length);
    const target = candidates[0];
    if (!target) return false;
    const clickable = target.closest('[role="tab"], [role="button"], button') || target;
    clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    clickable.click();
    return true;
  });
  if (!clicked) return false;
  await page.wait(0.5);
  return true;
}

async function acceptTerms(page) {
  const accepted = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(visible);
    const target = boxes.find((box) => {
      const container = box.closest('label') || box.parentElement?.parentElement || box.parentElement;
      return (container?.innerText || '').includes('我已阅读并同意');
    }) || boxes.at(-1);
    if (!target) return false;
    if (!target.checked) target.click();
    return target.checked;
  });
  if (!accepted) throw new CommandExecutionError('Terms checkbox not found or could not be checked');
}

async function submitLogin(page) {
  const submitted = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '');
    const password = document.querySelector('input[name="password"]');
    const passwordRect = password?.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .filter((element) => compact(element) === '登录');
    const button = candidates.find((element) => {
      if (!passwordRect) return false;
      const rect = element.getBoundingClientRect();
      const passwordCenter = (passwordRect.left + passwordRect.right) / 2;
      const buttonCenter = (rect.left + rect.right) / 2;
      return rect.top >= passwordRect.bottom - 8 && Math.abs(buttonCenter - passwordCenter) < 260;
    });
    if (!button) return false;
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    button.click();
    return true;
  });
  if (!submitted) throw new CommandExecutionError('Login submit button not found');
}

async function ensureLoggedIn(page, email, password, deadline) {
  await navigate(page, REPORT_URL);
  let state = await waitForPageState(
    page,
    (next) => next.hasReport
      || (next.hasEmail && next.hasPassword)
      || next.hasLoginButton,
    deadline,
    'xiaohongshu-pgy landing page',
  );
  if (state.hasReport) return state;

  if (!state.hasEmail || !state.hasPassword) {
    if (!await openLoginDialog(page)) {
      throw new CommandExecutionError('Login button not found on the Xiaohongshu Pgy landing page');
    }
    state = await waitForPageState(
      page,
      (next) => next.hasLoginFormDom,
      deadline,
      'xiaohongshu-pgy login dialog',
    );
    if (!state.hasEmail || !state.hasPassword) {
      if (!await activateAccountLogin(page)) {
        throw new CommandExecutionError('Account login tab not found');
      }
    }
    state = await waitForPageState(
      page,
      (next) => next.hasEmail && next.hasPassword,
      deadline,
      'xiaohongshu-pgy login form',
    );
  }

  if (!email || !password) {
    throw new AuthRequiredError(
      HOST,
      'Open a logged-in Xiaohongshu Pgy session, or provide --email/--password (prefer XHS_PGY_EMAIL/XHS_PGY_PASSWORD)',
    );
  }

  await setControlledInput(page, 'input[name="email"]', email);
  await setControlledInput(page, 'input[name="password"]', password);
  await acceptTerms(page);
  await submitLogin(page);

  state = await waitForPageState(
    page,
    (next) => next.hasVerification || (!next.hasEmail && !next.hasPassword),
    deadline,
    'xiaohongshu-pgy login',
  );
  if (state.hasVerification) {
    throw new AuthRequiredError(HOST, 'Complete the verification in Chrome, then rerun the command');
  }

  await navigate(page, REPORT_URL);
  return await waitForPageState(
    page,
    (next) => next.hasReport,
    deadline,
    'xiaohongshu-pgy note report page',
  );
}

function fileSnapshot(directory) {
  if (!fs.existsSync(directory)) {
    throw new CommandExecutionError(`Downloads directory does not exist: ${directory}`);
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => !/\.(crdownload|tmp|part)$/i.test(entry.name))
    .filter((entry) => /\.(csv|xlsx)$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        // Chrome may rename a completed download between readdirSync and statSync.
        // Treat that transient disappearance as a normal polling race.
        if (error?.code === 'ENOENT') return null;
        throw new CommandExecutionError(
          `Could not inspect downloaded report candidate ${filePath}: ${error?.message || error}`,
        );
      }
      return {
        name: entry.name,
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .filter(Boolean);
}

function findFreshReport(directory, startedAt) {
  return fileSnapshot(directory)
    .filter((file) => file.mtimeMs >= startedAt - 1000)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null;
}

async function waitForDownloadedReport(directory, startedAt, deadline, allowedSeconds) {
  let previous = null;
  while (Date.now() < deadline) {
    const candidate = findFreshReport(directory, startedAt);
    if (candidate && candidate.size > 0) {
      if (previous && previous.filePath === candidate.filePath && previous.size === candidate.size) {
        return candidate;
      }
      previous = candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new TimeoutError('xiaohongshu-pgy report download', allowedSeconds);
}

async function clickExportButton(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '');
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .filter((element) => compact(element) === '导出');
    const scoped = candidates.find((element) => {
      let container = element.parentElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        const text = compact(container);
        if (text.includes('查询') && text.includes('重置')) return true;
      }
      return false;
    });
    const target = scoped || candidates.at(-1);
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.click();
    return true;
  });
}

async function confirmExportIfNeeded(page) {
  await page.wait(0.5);
  const marked = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '');
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], .d-modal, .d-dialog'))
      .filter(visible)
      .at(-1);
    if (!dialog) return false;
    const labels = ['导出', '下载', '确定'];
    const button = Array.from(dialog.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .find((element) => labels.includes(compact(element)));
    if (!button) return false;
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    button.click();
    return true;
  });
  if (!marked) return false;
  return true;
}

async function downloadReport(page, date, outputDir, deadline) {
  fs.mkdirSync(outputDir, { recursive: true });
  let downloaded = null;
  for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt += 1) {
    const startedAt = Date.now();
    const clicked = await clickExportButton(page);
    if (!clicked) {
      throw new CommandExecutionError('Note report export button not found; verify that the 笔记报告 tab finished loading');
    }
    await confirmExportIfNeeded(page);

    const attemptDeadlineCandidate = Date.now() + 45000;
    const attemptDeadline = attemptDeadlineCandidate < deadline ? attemptDeadlineCandidate : deadline;
    const allowedSeconds = Math.max(1, Math.ceil((attemptDeadline - Date.now()) / 1000));
    try {
      downloaded = await waitForDownloadedReport(downloadsDir(), startedAt, attemptDeadline, allowedSeconds);
      break;
    } catch (error) {
      if (!(error instanceof TimeoutError) || attempt === 3 || Date.now() >= deadline) throw error;
    }
  }
  if (!downloaded) {
    throw new TimeoutError('xiaohongshu-pgy report download', 1);
  }
  const extension = path.extname(downloaded.name).toLowerCase();
  const targetPath = path.join(outputDir, `${date}${OUTPUT_BASENAME}${extension}`);
  try {
    fs.copyFileSync(downloaded.filePath, targetPath);
  } catch (error) {
    throw new CommandExecutionError(`Could not copy downloaded report to ${targetPath}: ${error?.message || error}`);
  }
  return targetPath;
}

function copyToShare(localFile, shareDir) {
  if (!shareDir) throw new ArgumentError('share must not be empty when copy-share is true');
  const targetPath = path.join(shareDir, path.basename(localFile));
  try {
    if (!fs.existsSync(shareDir)) {
      throw new Error(`share directory does not exist: ${shareDir}`);
    }
    fs.copyFileSync(localFile, targetPath);
  } catch (error) {
    throw new CommandExecutionError(
      `Report was downloaded to ${localFile}, but copying to the share failed: ${error?.message || error}`,
    );
  }
  return targetPath;
}

async function logout(page) {
  const opened = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const compact = (element) => (element.innerText || element.textContent || '').replace(/\s+/g, '');
    const topbar = document.querySelector('header, [class*="header"], [class*="topbar"]') || document;
    const clickable = Array.from(topbar.querySelectorAll('button, [role="button"], [class*="avatar"]'))
      .filter(visible)
      .filter((element) => !['登录', '立即入驻'].includes(compact(element)));
    const account = clickable.at(-1);
    if (!account) return false;
    account.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    account.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    account.click();
    return true;
  });
  if (!opened) return false;
  await page.wait(0.8);
  const marked = await markByText(page, 'pgy-logout', ['退出登录', '登出']);
  if (!marked) return false;
  await clickMarked(page, 'pgy-logout', 'Logout button not found');
  await page.wait(0.8);
  return true;
}

cli({
  site: SITE,
  name: 'download-note-report',
  description: 'Download the Xiaohongshu Pgy note report CSV/XLSX, optionally copy it to the configured share, then log out.',
  access: 'read',
  example: 'opencli xiaohongshu-pgy download-note-report --output . --copy-share true --logout true --site-session persistent --keep-tab false --window foreground -f yaml',
  domain: HOST,
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'date', type: 'string', default: '', help: 'Date prefix for the output file, YYYY-MM-DD. Defaults to today.' },
    { name: 'email', type: 'string', default: '', help: 'Login email. Defaults to XHS_PGY_EMAIL; omit when Chrome is already logged in.' },
    { name: 'password', type: 'string', default: '', help: 'Login password. Defaults to XHS_PGY_PASSWORD; prefer the environment variable.' },
    { name: 'output', type: 'string', default: '.', help: 'Directory for YYYY-MM-DD新媒体蒲公英.csv (or .xlsx if the site changes format).' },
    { name: 'share', type: 'string', default: DEFAULT_SHARE_DIR, help: 'Network share directory used when --copy-share is true.' },
    { name: 'copy-share', type: 'bool', default: true, help: 'Copy the downloaded report to --share (default: true).' },
    { name: 'logout', type: 'bool', default: true, help: 'Log out after the command, including after failures (default: true).' },
    { name: 'timeout', type: 'int', default: 600, help: 'Maximum seconds for login, export, download, and copy (default: 600).' },
  ],
  columns: ['status', 'date', 'file', 'sharedFile', 'size', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for xiaohongshu-pgy download-note-report');

    const date = parseDate(kwargs.date);
    const timeoutSeconds = parsePositiveInteger(kwargs.timeout, 600, 'timeout');
    const deadline = Date.now() + timeoutSeconds * 1000;
    const email = String(kwargs.email || process.env.XHS_PGY_EMAIL || '').trim();
    const password = String(kwargs.password || process.env.XHS_PGY_PASSWORD || '');
    const outputDir = resolveOutputDir(kwargs.output);
    const copyShare = kwargs['copy-share'] !== false;
    const shouldLogout = kwargs.logout !== false;
    const shareDir = String(kwargs.share || DEFAULT_SHARE_DIR).trim();

    let finalUrl = REPORT_URL;
    try {
      const reportState = await ensureLoggedIn(page, email, password, deadline);
      finalUrl = reportState.url || REPORT_URL;
      const file = await downloadReport(page, date, outputDir, deadline);
      const sharedFile = copyShare ? copyToShare(file, shareDir) : null;
      const size = fs.statSync(file).size;

      return [{
        status: 'ok',
        date,
        file,
        sharedFile,
        size,
        url: finalUrl,
      }];
    } finally {
      if (shouldLogout) await logout(page).catch(() => {});
    }
  },
});
