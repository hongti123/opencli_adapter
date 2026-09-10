import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_PORTAL_URL = 'https://etax.guangdong.chinatax.gov.cn:8443/loginb/';
const DEFAULT_QUERY_URL = 'https://dppt.guangdong.chinatax.gov.cn:8443/dedeuction-type-checked-business';
const DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUTH_FAILURE_STABLE_SECONDS = 8;
const QUERY_CONFIRM_ATTEMPTS = 3;
const QUERY_CONFIRM_WAIT_SECONDS = 10;

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '300';
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function yesterday() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  return formatLocalDate(date);
}

const DEFAULT_QUERY_DATE = yesterday();

function argument(kwargs, kebabName, camelName) {
  return kwargs?.[camelName] ?? kwargs?.[kebabName];
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

function taxPlatformUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new ArgumentError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ArgumentError(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.hostname !== 'chinatax.gov.cn' && !parsed.hostname.endsWith('.chinatax.gov.cn')) {
    throw new ArgumentError(`${label} must point to chinatax.gov.cn`);
  }
  return parsed.href;
}

function sanitizeFilePart(value) {
  const result = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!result) throw new CommandExecutionError('Subject name cannot be used as a Windows filename');
  return result;
}

function authenticationFailureReason(snapshot) {
  const text = `${snapshot.title || ''}\n${snapshot.body || ''}`;
  if (/身份认证已失效|请重新登录|登录已失效|账号退出|帐号退出|账户退出|账号已退出/.test(text)) {
    return 'the page displayed an authentication-expired or account-exited message';
  }
  if (/\/login(?:[/?#]|$)/i.test(snapshot.url || '')) return 'the browser remained on a login URL';
  if (/tpass\./i.test(snapshot.url || '')) return 'the browser remained on the tax passport site';
  return '';
}

function createAuthenticationMonitor(domain, stableSeconds = AUTH_FAILURE_STABLE_SECONDS) {
  let observedSince = 0;
  let consecutiveSamples = 0;
  let latestReason = '';

  return (snapshot) => {
    const reason = authenticationFailureReason(snapshot);
    if (!reason) {
      observedSince = 0;
      consecutiveSamples = 0;
      latestReason = '';
      return false;
    }
    if (!observedSince) observedSince = Date.now();
    consecutiveSamples += 1;
    latestReason = reason;
    if (consecutiveSamples >= 3 && Date.now() - observedSince >= stableSeconds * 1000) {
      throw new AuthRequiredError(
        domain,
        `China Tax authentication appears to be missing or expired: ${latestReason} for at least ${stableSeconds} seconds; run chinatax-login first with the same OpenCLI profile`,
      );
    }
    return true;
  };
}

async function extractSubject(page, portalUrl, timeoutSeconds) {
  await page.goto(portalUrl);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const observeAuthentication = createAuthenticationMonitor(new URL(portalUrl).hostname);
  while (Date.now() < deadline) {
    const result = await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const taxpayerIdRe = /[0-9A-Z]{15,20}/;
      const candidates = [];
      for (const el of document.querySelectorAll('div[title]')) {
        if (!visible(el)) continue;
        const name = (el.getAttribute('title') || el.textContent || '').trim();
        if (!name || name.length < 4) continue;
        let ancestor = el.parentElement;
        for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
          const text = (ancestor.innerText || ancestor.textContent || '').trim();
          const taxpayerId = text.match(taxpayerIdRe)?.[0] || '';
          if (taxpayerId) {
            candidates.push({ name, taxpayerId, depth, textLength: text.length });
            break;
          }
        }
      }
      candidates.sort((a, b) => a.depth - b.depth || a.textLength - b.textLength);
      return {
        url: location.href,
        title: document.title || '',
        body: document.body?.innerText || '',
        subject: candidates[0] || null,
      };
    })()`);
    const authenticationPending = observeAuthentication(result);
    if (!authenticationPending && result.subject?.name) return result.subject;
    await page.wait(0.5);
  }
  throw new TimeoutError('tax subject information', timeoutSeconds);
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

async function markDateInput(page, labelText) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-date-input]').forEach((el) => el.removeAttribute('data-opencli-date-input'));
    const wanted = ${JSON.stringify(labelText)};
    const label = Array.from(document.querySelectorAll('form label'))
      .find((el) => visible(el) && (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === wanted);
    const item = label?.closest('.t-form__item');
    const input = Array.from(item?.querySelectorAll('input') || []).find(visible);
    if (!input) return false;
    input.setAttribute('data-opencli-date-input', '1');
    return true;
  })()`);
}

async function readVisibleDatePanel(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-date-panel]').forEach((el) => el.removeAttribute('data-opencli-date-panel'));
    const input = document.querySelector('[data-opencli-date-input="1"]');
    if (!input) return null;
    const inputRect = input.getBoundingClientRect();
    const panels = Array.from(document.querySelectorAll('.t-date-picker__panel')).filter(visible);
    panels.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const ad = Math.abs(ar.left - inputRect.left) * 10 + Math.abs(ar.top - inputRect.bottom);
      const bd = Math.abs(br.left - inputRect.left) * 10 + Math.abs(br.top - inputRect.bottom);
      return ad - bd;
    });
    const panel = panels[0];
    if (!panel) return null;
    panel.setAttribute('data-opencli-date-panel', '1');
    const monthText = panel.querySelector('.t-date-picker__header-controller-month input')?.value || '';
    const yearText = panel.querySelector('.t-date-picker__header-controller-year input')?.value || '';
    return {
      year: Number(yearText.match(/\\d{4}/)?.[0] || 0),
      month: Number(monthText.match(/\\d{1,2}/)?.[0] || 0),
      yearText,
      monthText,
    };
  })()`);
}

async function setDateInput(page, labelText, value) {
  const [targetYear, targetMonth, targetDay] = value.split('-').map(Number);
  const targetMonthIndex = targetYear * 12 + targetMonth - 1;
  const componentClick = async (selector, errorMessage) => {
    const clicked = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(errorMessage);
  };
  try {
    await page.pressKey('Escape');
    await page.wait(0.2);
    if (!await markDateInput(page, labelText)) throw new Error(`date input for ${labelText} was not found`);
    const panelDeadline = Date.now() + 10000;
    let panel = null;
    while (Date.now() < panelDeadline && (!panel?.year || !panel?.month)) {
      await componentClick('[data-opencli-date-input="1"]', `Could not click ${labelText}`);
      const attemptDeadline = Math.min(panelDeadline, Date.now() + 2000);
      while (Date.now() < attemptDeadline) {
        await page.wait(0.2);
        panel = await readVisibleDatePanel(page);
        if (panel?.year && panel?.month) break;
      }
    }
    if (!panel?.year || !panel?.month) {
      throw new Error(`visible date picker header was unreadable (year=${panel?.yearText || '(none)'}, month=${panel?.monthText || '(none)'})`);
    }

    let currentMonthIndex = panel.year * 12 + panel.month - 1;
    const monthDistance = targetMonthIndex - currentMonthIndex;
    if (Math.abs(monthDistance) > 240) throw new Error('target month is more than 240 months from the displayed month');
    const directionTitle = monthDistance < 0 ? '上个月' : '下个月';
    for (let step = 0; step < Math.abs(monthDistance); step += 1) {
      const previous = currentMonthIndex;
      const marked = await page.evaluate(`(() => {
        const panel = document.querySelector('[data-opencli-date-panel="1"]');
        const button = panel?.querySelector('button[title=${JSON.stringify(directionTitle)}]');
        if (!button) return false;
        document.querySelectorAll('[data-opencli-month-nav]').forEach((el) => el.removeAttribute('data-opencli-month-nav'));
        button.setAttribute('data-opencli-month-nav', '1');
        return true;
      })()`);
      if (!marked) throw new Error(`${directionTitle} button was not found`);
      await componentClick('[data-opencli-month-nav="1"]', `Could not click ${directionTitle}`);
      const navigationDeadline = Date.now() + 5000;
      while (Date.now() < navigationDeadline) {
        await page.wait(0.15);
        panel = await readVisibleDatePanel(page);
        if (panel?.year && panel?.month) {
          currentMonthIndex = panel.year * 12 + panel.month - 1;
          if (currentMonthIndex !== previous) break;
        }
      }
      if (currentMonthIndex === previous) throw new Error(`${directionTitle} did not change the displayed month`);
    }

    const dayReady = await page.evaluate(`(() => {
      const panel = document.querySelector('[data-opencli-date-panel="1"]');
      if (!panel) return false;
      document.querySelectorAll('[data-opencli-date-day]').forEach((el) => el.removeAttribute('data-opencli-date-day'));
      const cell = Array.from(panel.querySelectorAll('.t-date-picker__cell')).find((el) => {
        if (el.classList.contains('t-date-picker__cell--additional')) return false;
        if (el.classList.contains('t-date-picker__cell--disabled')) return false;
        return Number((el.textContent || '').trim()) === ${targetDay};
      });
      if (!cell) return false;
      cell.setAttribute('data-opencli-date-day', '1');
      return true;
    })()`);
    if (!dayReady) throw new Error(`selectable day ${targetDay} was not found`);
    await page.wait(0.5);
    await componentClick('[data-opencli-date-day="1"]', `Could not click day ${targetDay}`);

    const valueDeadline = Date.now() + 10000;
    let selected = false;
    while (Date.now() < valueDeadline) {
      const actual = await page.evaluate(`(() => document.querySelector('[data-opencli-date-input="1"]')?.value || '')()`);
      if (actual === value) {
        selected = true;
        break;
      }
      await page.wait(0.15);
    }
    if (!selected) throw new Error(`date input did not retain ${value}`);

    const pickerIsOpen = async () => await page.evaluate(`(() => {
      const input = document.querySelector('[data-opencli-date-input="1"]');
      return Boolean(input?.closest('.t-date-picker')?.querySelector('.t-select-input--popup-visible'));
    })()`);
    const closeDeadline = Date.now() + 3000;
    let stillOpen = true;
    while (Date.now() < closeDeadline) {
      stillOpen = await pickerIsOpen();
      if (!stillOpen) break;
      await page.wait(0.15);
    }
    if (stillOpen) {
      await nativeClickSelector(
        page,
        '[data-opencli-date-input="1"]',
        `Could not close the date picker for ${labelText}`,
      );
      await page.wait(0.3);
      stillOpen = await pickerIsOpen();
      if (stillOpen) {
        await page.pressKey('Escape');
        await page.wait(0.3);
        stillOpen = await pickerIsOpen();
      }
      if (stillOpen) throw new Error(`date picker for ${labelText} remained open after selecting ${value}`);
    }
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(`Could not select date ${value} for ${labelText}: ${error?.message || error}`);
  }
}

async function waitForQueryForm(page, queryUrl, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const observeAuthentication = createAuthenticationMonitor(new URL(queryUrl).hostname);
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const text = document.body?.innerText || '';
      const labels = Array.from(document.querySelectorAll('form label'))
        .map((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim());
      return {
        url: location.href,
        title: document.title || '',
        body: text,
        startReady: labels.includes('开票日期（起）'),
        endReady: labels.includes('开票日期（止）'),
        queryReady: Array.from(document.querySelectorAll('button'))
          .some((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '查询'),
      };
    })()`);
    const authenticationPending = observeAuthentication(state);
    if (!authenticationPending && state.startReady && state.endReady && state.queryReady) return;
    await page.wait(0.5);
  }
  throw new TimeoutError('purchase invoice query form', timeoutSeconds);
}

async function clickExactVisible(page, text, selectors, errorMessage) {
  const marked = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const wanted = ${JSON.stringify(text)};
    document.querySelectorAll('[data-opencli-click-target]').forEach((el) => el.removeAttribute('data-opencli-click-target'));
    const target = Array.from(document.querySelectorAll(${JSON.stringify(selectors)}))
      .filter(visible)
      .find((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === wanted);
    if (!target) return false;
    target.setAttribute('data-opencli-click-target', '1');
    return true;
  })()`);
  if (!marked) throw new CommandExecutionError(errorMessage);
  await nativeClickSelector(page, '[data-opencli-click-target="1"]', errorMessage);
}

async function verifyDateInputs(page, startDate, endDate) {
  const values = await page.evaluate(`(() => {
    const read = (wanted) => {
      const label = Array.from(document.querySelectorAll('form label'))
        .find((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === wanted);
      return label?.closest('.t-form__item')?.querySelector('input')?.value || '';
    };
    return { start: read('开票日期（起）'), end: read('开票日期（止）') };
  })()`);
  if (values.start !== startDate || values.end !== endDate) {
    throw new CommandExecutionError(
      `Date inputs changed before query: expected ${startDate} to ${endDate}, got ${values.start || '(empty)'} to ${values.end || '(empty)'}`,
    );
  }
}

async function queryResultSnapshot(page) {
  return await page.evaluate(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const tables = Array.from(document.querySelectorAll('table')).filter((table) => {
        if (!visible(table)) return false;
        const text = table.innerText || table.textContent || '';
        return text.includes('开票日期') && text.includes('销售方纳税人名称');
      });
      const totalTexts = Array.from(document.querySelectorAll('.t-pagination__total, [class*="pagination"]'))
        .filter(visible)
        .map((el) => el.innerText || el.textContent || '');
      const matches = totalTexts.flatMap((text) => Array.from(text.matchAll(/共\\s*(\\d+)\\s*条/g)));
      const rowCount = matches.length ? Number(matches[matches.length - 1][1]) : null;
      const noData = tables.some((table) => (table.innerText || table.textContent || '').includes('暂无数据'));
      const exportVisible = Array.from(document.querySelectorAll('button')).some((el) =>
        visible(el) && (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === '导出'
      );
      return {
        url: location.href,
        title: document.title || '',
        body: document.body?.innerText || '',
        rowCount,
        noData,
        exportVisible,
        tableReady: tables.length > 0,
      };
    })()`);
}

async function confirmQueryResult(page, queryUrl) {
  const observeAuthentication = createAuthenticationMonitor(new URL(queryUrl).hostname);
  const samples = [];

  for (let attempt = 1; attempt <= QUERY_CONFIRM_ATTEMPTS; attempt += 1) {
    await clickExactVisible(page, '查询', 'button[type="submit"], button', `Query button not found on attempt ${attempt}`);
    await page.wait(QUERY_CONFIRM_WAIT_SECONDS);
    const result = await queryResultSnapshot(page);
    observeAuthentication(result);
    samples.push(result);
  }

  const counts = samples.map((sample) => sample.rowCount);
  const allCountsReadable = counts.every((count) => Number.isInteger(count) && count >= 0);
  const allCountsEqual = allCountsReadable && counts.every((count) => count === counts[0]);
  if (!allCountsEqual) {
    throw new CommandExecutionError(
      `Purchase invoice query did not stabilize after ${QUERY_CONFIRM_ATTEMPTS} attempts; record counts: ${counts.map((count) => count ?? 'unreadable').join(', ')}`,
    );
  }

  const result = samples[samples.length - 1];
  if (!result.tableReady) {
    throw new CommandExecutionError(
      `Purchase invoice query table was unavailable after ${QUERY_CONFIRM_ATTEMPTS} attempts; record counts: ${counts.join(', ')}`,
    );
  }
  if (result.rowCount > 0 && !result.exportVisible) {
    throw new CommandExecutionError(
      `Purchase invoice query stabilized at ${result.rowCount} records, but the Export button is unavailable; record counts: ${counts.join(', ')}`,
    );
  }
  return result;
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
  let lastCandidate = null;
  let stableChecks = 0;
  while (Date.now() < deadline) {
    const candidate = newestChangedXlsx(directory, before);
    if (candidate && candidate.size > 0) {
      if (lastCandidate?.fullPath === candidate.fullPath && lastCandidate.size === candidate.size) stableChecks += 1;
      else stableChecks = 0;
      lastCandidate = candidate;
      if (stableChecks >= 1 && !fs.existsSync(`${candidate.fullPath}.crdownload`)) return candidate.fullPath;
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

function writeEmptyMarkerFile(targetPath, overwrite) {
  if (fs.existsSync(targetPath) && !overwrite) {
    throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
  }
  try {
    fs.writeFileSync(targetPath, '');
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(`Could not create no-data marker file: ${error?.message || error}`);
  }
}

cli({
  site: 'chinatax-purchase-detail',
  name: 'download',
  description: 'Query purchase-invoice details for a date range, export matching rows, or create an empty .txt marker when no data exists.',
  access: 'read',
  example: 'opencli --profile opc-default chinatax-purchase-detail download --portal-url "https://etax.guangdong.chinatax.gov.cn:8443/loginb/" --query-url "https://dppt.guangdong.chinatax.gov.cn:8443/dedeuction-type-checked-business" --site-session persistent --keep-tab true -f yaml',
  domain: 'chinatax.gov.cn',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'portal-url', type: 'string', default: DEFAULT_PORTAL_URL, help: 'Authenticated tax portal URL used to read the subject name. Supports CHINATAX_PORTAL_URL.' },
    { name: 'query-url', type: 'string', default: DEFAULT_QUERY_URL, help: 'Purchase-detail query URL. Supports CHINATAX_PURCHASE_QUERY_URL.' },
    { name: 'date', type: 'string', default: '', help: `Convenience date for both start and end (YYYY-MM-DD). Defaults to yesterday (${DEFAULT_QUERY_DATE}). Supports CHINATAX_PURCHASE_DATE.` },
    { name: 'start-date', type: 'string', default: DEFAULT_QUERY_DATE, help: 'Invoice date start (YYYY-MM-DD). Defaults to yesterday. Supports CHINATAX_PURCHASE_START_DATE.' },
    { name: 'end-date', type: 'string', default: DEFAULT_QUERY_DATE, help: 'Invoice date end (YYYY-MM-DD). Defaults to yesterday. Supports CHINATAX_PURCHASE_END_DATE.' },
    { name: 'downloads-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Chrome download directory to watch. Supports CHINATAX_DOWNLOADS_DIR.' },
    { name: 'output-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Directory for the renamed workbook. Supports CHINATAX_PURCHASE_OUTPUT_DIR.' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Replace an existing date-range output file (.xlsx for data, .txt for no data).' },
    { name: 'subject-timeout', type: 'int', default: 30, help: 'Seconds to wait for subject information.' },
    { name: 'query-timeout', type: 'int', default: 60, help: 'Seconds to wait for the query form and result.' },
    { name: 'download-timeout', type: 'int', default: 120, help: 'Seconds to wait for the exported workbook.' },
    { name: 'timeout', type: 'int', default: 300, help: 'Max seconds for the overall command (default: 300).' },
  ],
  columns: ['status', 'subjectName', 'startDate', 'endDate', 'rowCount', 'downloaded', 'filename', 'filePath', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for chinatax-purchase-detail download');

    const portalUrl = taxPlatformUrl(
      String(argument(kwargs, 'portal-url', 'portalUrl') || process.env.CHINATAX_PORTAL_URL || DEFAULT_PORTAL_URL),
      'portal-url',
    );
    const queryUrl = taxPlatformUrl(
      String(argument(kwargs, 'query-url', 'queryUrl') || process.env.CHINATAX_PURCHASE_QUERY_URL || DEFAULT_QUERY_URL),
      'query-url',
    );
    const singleDate = String(argument(kwargs, 'date', 'date') || process.env.CHINATAX_PURCHASE_DATE || '').trim();
    const startDate = validDate(
      singleDate || process.env.CHINATAX_PURCHASE_START_DATE || argument(kwargs, 'start-date', 'startDate') || DEFAULT_QUERY_DATE,
      'start-date',
    );
    const endDate = validDate(
      singleDate || process.env.CHINATAX_PURCHASE_END_DATE || argument(kwargs, 'end-date', 'endDate') || DEFAULT_QUERY_DATE,
      'end-date',
    );
    if (startDate > endDate) throw new ArgumentError('start-date must be on or before end-date');
    const downloadsDir = path.resolve(String(
      argument(kwargs, 'downloads-dir', 'downloadsDir') || process.env.CHINATAX_DOWNLOADS_DIR || DEFAULT_DOWNLOADS_DIR,
    ));
    const outputDir = path.resolve(String(
      argument(kwargs, 'output-dir', 'outputDir') || process.env.CHINATAX_PURCHASE_OUTPUT_DIR || DEFAULT_DOWNLOADS_DIR,
    ));
    const overwrite = booleanArg(argument(kwargs, 'overwrite', 'overwrite'), false, 'overwrite');
    const subjectTimeout = positiveInt(argument(kwargs, 'subject-timeout', 'subjectTimeout'), 'subject-timeout');
    const queryTimeout = positiveInt(argument(kwargs, 'query-timeout', 'queryTimeout'), 'query-timeout');
    const downloadTimeout = positiveInt(argument(kwargs, 'download-timeout', 'downloadTimeout'), 'download-timeout');

    if (!fs.existsSync(downloadsDir) || !fs.statSync(downloadsDir).isDirectory()) {
      throw new ArgumentError(`downloads-dir is not a directory: ${downloadsDir}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });

    const subject = await extractSubject(page, portalUrl, subjectTimeout);
    const filenameStem = `${sanitizeFilePart(subject.name)}-进项-${startDate}_${endDate}`;
    const filename = `${filenameStem}.xlsx`;
    const targetPath = path.join(outputDir, filename);

    await page.goto(queryUrl);
    await waitForQueryForm(page, queryUrl, queryTimeout);
    await page.wait(1);
    await setDateInput(page, '开票日期（起）', startDate);
    await setDateInput(page, '开票日期（止）', endDate);
    await verifyDateInputs(page, startDate, endDate);
    const result = await confirmQueryResult(page, queryUrl);

    if (result.noData || result.rowCount === 0) {
      const noDataFilename = `${filenameStem}.txt`;
      const noDataPath = path.join(outputDir, noDataFilename);
      writeEmptyMarkerFile(noDataPath, overwrite);
      return [{
        status: 'no_data',
        subjectName: subject.name,
        startDate,
        endDate,
        rowCount: 0,
        downloaded: false,
        filename: noDataFilename,
        filePath: noDataPath,
        url: result.url,
      }];
    }

    if (fs.existsSync(targetPath) && !overwrite) {
      throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
    }
    const before = xlsxSnapshot(downloadsDir);
    await clickExactVisible(page, '导出', 'button', 'Export button not found after a non-empty query');
    const downloadedPath = await waitForNewXlsx(page, downloadsDir, before, downloadTimeout);
    try {
      moveDownloadedFile(downloadedPath, targetPath, overwrite);
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error;
      throw new CommandExecutionError(`Could not rename downloaded workbook: ${error?.message || error}`);
    }

    return [{
      status: 'downloaded',
      subjectName: subject.name,
      startDate,
      endDate,
      rowCount: result.rowCount,
      downloaded: true,
      filename,
      filePath: targetPath,
      url: result.url,
    }];
  },
});
