import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_PORTAL_URL = 'https://etax.guangdong.chinatax.gov.cn:8443/loginb/';
const DEFAULT_QUERY_URL = 'https://dppt.guangdong.chinatax.gov.cn:8443/invoice-query/invoice-query';
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
          const id = text.match(taxpayerIdRe)?.[0] || '';
          if (id) {
            candidates.push({ name, taxpayerId: id, depth, textLength: text.length });
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

async function setDateInput(page, placeholder, value) {
  const selector = `input[placeholder="${placeholder}"]`;
  const [targetYear, targetMonth, targetDay] = value.split('-').map(Number);
  const targetMonthIndex = targetYear * 12 + targetMonth - 1;

  const componentClick = async (clickSelector, errorMessage) => {
    const clicked = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(clickSelector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(errorMessage);
  };

  const readVisiblePanel = async () => await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const activeInput = document.querySelector('[data-opencli-date-input="1"]');
    const activePicker = activeInput?.closest('.t-date-picker');
    const activeSelect = activePicker?.querySelector('.t-select-input');
    if (!activeSelect?.classList.contains('t-select-input--popup-visible')) return null;
    document.querySelectorAll('[data-opencli-date-panel]').forEach((el) => el.removeAttribute('data-opencli-date-panel'));
    const panels = Array.from(document.querySelectorAll('.t-date-picker__panel')).filter(visible);
    const inputRect = activeInput.getBoundingClientRect();
    panels.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      const aDistance = Math.abs(aRect.left - inputRect.left) * 10 + Math.abs(aRect.top - inputRect.bottom);
      const bDistance = Math.abs(bRect.left - inputRect.left) * 10 + Math.abs(bRect.top - inputRect.bottom);
      return aDistance - bDistance;
    });
    const panel = panels[0];
    if (!panel) return null;
    panel.setAttribute('data-opencli-date-panel', '1');
    const monthText = panel.querySelector('.t-date-picker__header-controller-month input')?.value || '';
    const yearText = panel.querySelector('.t-date-picker__header-controller-year input')?.value || '';
    const month = Number(monthText.match(/\\d{1,2}/)?.[0] || 0);
    const year = Number(yearText.match(/\\d{4}/)?.[0] || 0);
    return { year, month, yearText, monthText };
  })()`);

  try {
    await page.pressKey('Escape');
    await page.wait(0.2);
    const inputReady = await page.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      document.querySelectorAll('[data-opencli-date-input]').forEach((el) => el.removeAttribute('data-opencli-date-input'));
      input.setAttribute('data-opencli-date-input', '1');
      return true;
    })()`);
    if (!inputReady) throw new Error(`input ${placeholder} was not found`);

    const panelDeadline = Date.now() + 15000;
    let panel = null;
    while (Date.now() < panelDeadline && (!panel?.year || !panel?.month)) {
      await componentClick('[data-opencli-date-input="1"]', `date input ${placeholder} was not clickable`);
      const attemptDeadline = Math.min(panelDeadline, Date.now() + 2000);
      while (Date.now() < attemptDeadline) {
        panel = await readVisiblePanel();
        if (panel?.year && panel?.month) break;
        await page.wait(0.2);
      }
    }
    if (!panel?.year || !panel?.month) {
      const clickState = await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return { input: false };
        const rect = input.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const picker = input.closest('.t-date-picker');
        return {
          input: true,
          disabled: Boolean(input.disabled),
          readOnly: Boolean(input.readOnly),
          inputClass: input.className || '',
          pickerClass: picker?.className || '',
          selectClass: picker?.querySelector('.t-select-input')?.className || '',
          topTag: top?.tagName || '',
          topClass: top?.className || '',
          topText: (top?.textContent || '').trim().slice(0, 80),
        };
      })()`);
      throw new Error(
        `visible date picker panel did not appear or its header was unreadable (year=${panel?.yearText || '(none)'}, month=${panel?.monthText || '(none)'}, clickState=${JSON.stringify(clickState)})`,
      );
    }

    let currentMonthIndex = panel.year * 12 + panel.month - 1;
    const monthDistance = targetMonthIndex - currentMonthIndex;
    if (Math.abs(monthDistance) > 240) {
      throw new Error(`target month is ${Math.abs(monthDistance)} months away; date picker navigation limit is 240 months`);
    }

    const directionTitle = monthDistance < 0 ? '上个月' : '下个月';
    for (let step = 0; step < Math.abs(monthDistance); step += 1) {
      const previousMonthIndex = currentMonthIndex;
      await componentClick(
        `[data-opencli-date-panel="1"] button[title="${directionTitle}"]`,
        `${directionTitle} button was not clickable in ${placeholder}`,
      );
      const navigationDeadline = Date.now() + 5000;
      while (Date.now() < navigationDeadline) {
        await page.wait(0.15);
        panel = await readVisiblePanel();
        if (panel?.year && panel?.month) {
          currentMonthIndex = panel.year * 12 + panel.month - 1;
          if (currentMonthIndex !== previousMonthIndex) break;
        }
      }
      if (currentMonthIndex === previousMonthIndex) {
        throw new Error(`${directionTitle} did not change the displayed month`);
      }
    }

    if (currentMonthIndex !== targetMonthIndex) {
      throw new Error(`date picker showed ${panel?.year || '?'}-${String(panel?.month || '?').padStart(2, '0')} instead of ${value.slice(0, 7)}`);
    }

    // TDesign exposes the calendar DOM before its popup transition has fully
    // settled. Clicking a day immediately can be ignored, especially for the
    // second date picker, so wait for the interactive panel to stabilize.
    await page.wait(1);

    const dayReady = await page.evaluate(`(() => {
      const panel = document.querySelector('[data-opencli-date-panel="1"]');
      if (!panel) return false;
      document.querySelectorAll('[data-opencli-date-day]').forEach((el) => el.removeAttribute('data-opencli-date-day'));
      const day = ${targetDay};
      const cells = Array.from(panel.querySelectorAll('.t-date-picker__cell'));
      const cell = cells.find((el) => {
        if (el.classList.contains('t-date-picker__cell--additional')) return false;
        if (el.classList.contains('t-date-picker__cell--disabled')) return false;
        return Number((el.textContent || '').trim()) === day;
      });
      if (!cell) return false;
      cell.setAttribute('data-opencli-date-day', '1');
      return true;
    })()`);
    if (!dayReady) throw new Error(`selectable day ${targetDay} was not found in the date picker`);

    await componentClick('[data-opencli-date-day="1"]', `day ${targetDay} was not clickable in ${placeholder}`);

    const valueDeadline = Date.now() + 10000;
    let actual = '';
    let selected = false;
    while (Date.now() < valueDeadline) {
      actual = await page.evaluate(`(() => document.querySelector(${JSON.stringify(selector)})?.value || '')()`);
      if (actual === value) {
        selected = true;
        break;
      }
      await page.wait(0.15);
    }
    if (!selected) {
      const selectionState = await page.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden'
            && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        };
        return {
          activeInputs: Array.from(document.querySelectorAll('.t-date-picker .t-select-input--popup-visible input'))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              return { placeholder: el.placeholder || '', value: el.value || '', left: rect.left, top: rect.top };
            }),
          markedDayClass: document.querySelector('[data-opencli-date-day="1"]')?.className || '',
          visiblePanels: Array.from(document.querySelectorAll('.t-date-picker__panel')).filter(visible).map((panel) => ({
            activeDay: panel.querySelector('.t-date-picker__cell--active')?.textContent?.trim() || '',
            left: panel.getBoundingClientRect().left,
            marked: panel.hasAttribute('data-opencli-date-panel'),
            month: panel.querySelector('.t-date-picker__header-controller-month input')?.value || '',
            year: panel.querySelector('.t-date-picker__header-controller-year input')?.value || '',
          })),
        };
      })()`);
      throw new Error(`date picker retained ${actual || '(empty)'} instead of ${value}; selectionState=${JSON.stringify(selectionState)}`);
    }

    const closeDeadline = Date.now() + 3000;
    let stillOpen = true;
    while (Date.now() < closeDeadline) {
      stillOpen = await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        return Boolean(input?.closest('.t-date-picker')?.querySelector('.t-select-input--popup-visible'));
      })()`);
      if (!stillOpen) break;
      await page.wait(0.15);
    }
    if (stillOpen) {
      await nativeClickSelector(
        page,
        selector,
        `Could not close the date picker for ${placeholder}`,
      );
      await page.wait(0.3);
      stillOpen = await page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        return Boolean(input?.closest('.t-date-picker')?.querySelector('.t-select-input--popup-visible'));
      })()`);
      if (stillOpen) throw new Error(`date picker for ${placeholder} remained open after selecting ${value}`);
    }
  } catch (error) {
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(`Could not select date ${value} for ${placeholder}: ${error?.message || error}`);
  }
}

async function verifyDateInputs(page, startDate, endDate) {
  const values = await page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return {
      start: inputs.find((el) => el.placeholder === '开票日期起')?.value || '',
      end: inputs.find((el) => el.placeholder === '开票日期止')?.value || '',
    };
  })()`);
  if (values.start !== startDate || values.end !== endDate) {
    throw new CommandExecutionError(
      `Date inputs changed before query: expected ${startDate} to ${endDate}, got ${values.start || '(empty)'} to ${values.end || '(empty)'}`,
    );
  }
}

async function waitForQueryForm(page, queryUrl, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const observeAuthentication = createAuthenticationMonitor(new URL(queryUrl).hostname);
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return {
        url: location.href,
        title: document.title || '',
        body: document.body?.innerText || '',
        startReady: inputs.some((el) => el.placeholder === '开票日期起'),
        endReady: inputs.some((el) => el.placeholder === '开票日期止'),
        queryTypeReady: Array.from(document.querySelectorAll('label'))
          .some((el) => (el.textContent || '').replace(/\\s+/g, '') === '查询类型'),
      };
    })()`);
    const authenticationPending = observeAuthentication(state);
    if (!authenticationPending && state.startReady && state.endReady && state.queryTypeReady) return;
    await page.wait(0.5);
  }
  throw new TimeoutError('sales invoice query form', timeoutSeconds);
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
    if (typeof page.nativeClick === 'function') {
      await page.nativeClick(point.x, point.y);
    } else {
      await page.click(selector);
    }
  } catch (error) {
    throw new CommandExecutionError(`${errorMessage}: ${error?.message || error}`);
  }
}

async function ensureIssuedInvoiceQuery(page) {
  const result = await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const label = Array.from(document.querySelectorAll('label'))
      .find((el) => visible(el) && (el.textContent || '').replace(/\\s+/g, '') === '查询类型');
    if (!label) return { found: false, value: '' };
    let root = label.parentElement;
    for (let depth = 0; root && depth < 8; depth += 1, root = root.parentElement) {
      const input = Array.from(root.querySelectorAll('input')).find(visible);
      if (input) {
        if ((input.value || '').includes('开具发票')) return { found: true, value: input.value, ready: true };
        document.querySelectorAll('[data-opencli-query-type]').forEach((el) => el.removeAttribute('data-opencli-query-type'));
        input.setAttribute('data-opencli-query-type', '1');
        return { found: true, value: input.value || '', ready: false };
      }
    }
    return { found: false, value: '' };
  })()`);
  if (!result.found) throw new CommandExecutionError('Query type input not found');
  if (result.ready) return;
  const markVisibleIssuedOption = async () => await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    document.querySelectorAll('[data-opencli-issued-option]').forEach((el) => el.removeAttribute('data-opencli-issued-option'));
    const option = Array.from(document.querySelectorAll('.t-select-option[title="开具发票"]')).find(visible);
    if (!option) return false;
    option.setAttribute('data-opencli-issued-option', '1');
    return true;
  })()`);
  try {
    let optionReady = await markVisibleIssuedOption();
    if (!optionReady) {
      await nativeClickSelector(page, '[data-opencli-query-type="1"]', 'Could not click query type input');
      const optionDeadline = Date.now() + 10000;
      while (Date.now() < optionDeadline && !optionReady) {
        await page.wait(0.25);
        optionReady = await markVisibleIssuedOption();
      }
    }
    if (!optionReady) throw new Error('visible 开具发票 option did not appear within 10 seconds');
    await nativeClickSelector(page, '[data-opencli-issued-option="1"]', 'Could not click 开具发票 option');
    await page.wait(0.25);
  } catch (error) {
    throw new CommandExecutionError(`Could not select query type 开具发票: ${error?.message || error}`);
  }
  const selectedValue = await page.evaluate(`(() => document.querySelector('[data-opencli-query-type="1"]')?.value || '')()`);
  if (!selectedValue.includes('开具发票')) {
    throw new CommandExecutionError(`Query type retained ${selectedValue || '(empty)'} instead of 开具发票`);
  }
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
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selectors)}))
      .filter(visible)
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    const target = nodes.find((el) => (el.innerText || el.textContent || '').replace(/\\s+/g, '').trim() === wanted);
    if (!target) return false;
    target.setAttribute('data-opencli-click-target', '1');
    return true;
  })()`);
  if (!marked) throw new CommandExecutionError(errorMessage);
  await nativeClickSelector(page, '[data-opencli-click-target="1"]', errorMessage);
}

async function queryResultSnapshot(page) {
  return await page.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const deeplyVisible = (el) => {
      if (!visible(el)) return false;
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          style.display === 'none'
          || style.visibility === 'hidden'
          || Number(style.opacity || 1) === 0
          || node.hidden
          || node.getAttribute?.('aria-hidden') === 'true'
        ) return false;
      }
      return true;
    };
    const body = document.body?.innerText || '';
    const invoiceTables = Array.from(document.querySelectorAll('table')).filter((table) => {
      if (!deeplyVisible(table)) return false;
      const text = table.innerText || table.textContent || '';
      return table.tBodies.length > 0 && text.includes('序号') && text.includes('开票日期');
    });
    invoiceTables.sort((a, b) => {
      const score = (table) => {
        const rows = Array.from(table.tBodies).flatMap((tbody) => Array.from(tbody.rows));
        const businessRows = rows.filter((row) => !(row.innerText || row.textContent || '').includes('暂无数据')).length;
        return businessRows * 100000 + (table.innerText || table.textContent || '').length;
      };
      return score(b) - score(a);
    });
    const invoiceTable = invoiceTables[0] || null;
    const tableText = (invoiceTable?.innerText || invoiceTable?.textContent || '')
      .replace(/\\s+/g, ' ')
      .trim();
    const resultRoot = invoiceTable?.closest('.invoiceQuery__table') || invoiceTable?.parentElement || null;
    const resultText = (resultRoot?.innerText || resultRoot?.textContent || '').replace(/\\s+/g, ' ').trim();
    const paginationCounts = Array.from(document.querySelectorAll('.t-pagination__total, [class*="pagination"]'))
      .filter(deeplyVisible)
      .flatMap((el) => Array.from((el.innerText || el.textContent || '').matchAll(/共\\s*(\\d+)\\s*条/g)))
      .map((match) => Number(match[1]));
    const resultCountMatches = Array.from(resultText.matchAll(/共\\s*(\\d+)\\s*条/g));
    const tableRows = invoiceTable
      ? Array.from(invoiceTable.tBodies).flatMap((tbody) => Array.from(tbody.rows))
          .filter((row) => !(row.innerText || row.textContent || '').includes('暂无数据')).length
      : null;
    const rowCount = paginationCounts.length
      ? paginationCounts[paginationCounts.length - 1]
      : resultCountMatches.length
        ? Number(resultCountMatches[resultCountMatches.length - 1][1])
        : tableRows;
    const exportVisible = Array.from(document.querySelectorAll('button'))
      .some((el) => visible(el) && (el.innerText || el.textContent || '').replace(/\\s+/g, '') === '导出');
    const noData = resultText.includes('暂无数据');
    return {
      url: location.href,
      title: document.title || '',
      body,
      rowCount,
      exportVisible,
      noData,
      fingerprint: JSON.stringify({ rowCount, exportVisible, noData, tableText }),
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
      `Sales invoice query did not stabilize after ${QUERY_CONFIRM_ATTEMPTS} attempts; record counts: ${counts.map((count) => count ?? 'unreadable').join(', ')}`,
    );
  }

  const result = samples[samples.length - 1];
  if (result.rowCount > 0 && !result.exportVisible) {
    throw new CommandExecutionError(
      `Sales invoice query stabilized at ${result.rowCount} records, but the Export button is unavailable`,
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
      if (lastCandidate?.fullPath === candidate.fullPath && lastCandidate.size === candidate.size) {
        stableChecks += 1;
      } else {
        stableChecks = 0;
      }
      lastCandidate = candidate;
      const partialPath = `${candidate.fullPath}.crdownload`;
      if (stableChecks >= 1 && !fs.existsSync(partialPath)) return candidate.fullPath;
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

function writeNoDataMarker(targetPath, overwrite) {
  try {
    fs.writeFileSync(targetPath, '', { flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
    }
    throw new CommandExecutionError(`Could not create no-data marker file: ${error?.message || error}`);
  }
}

cli({
  site: 'chinatax-sales-detail',
  name: 'download',
  description: 'Query issued-invoice sales details between --start-date and --end-date; writes an .xlsx when data exists or an empty .txt marker when no records exist.',
  access: 'read',
  example: 'opencli --profile opc-default chinatax-sales-detail download --portal-url "https://etax.guangdong.chinatax.gov.cn:8443/loginb/" --query-url "https://dppt.guangdong.chinatax.gov.cn:8443/invoice-query/invoice-query" --start-date 2026-07-01 --end-date 2026-07-31 --site-session persistent --keep-tab true -f yaml',
  domain: 'chinatax.gov.cn',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'portal-url', type: 'string', default: DEFAULT_PORTAL_URL, help: 'Authenticated tax portal URL used to read the subject name. Supports CHINATAX_PORTAL_URL.' },
    { name: 'query-url', type: 'string', default: DEFAULT_QUERY_URL, help: 'Issued-invoice query URL. Supports CHINATAX_SALES_QUERY_URL.' },
    { name: 'date', type: 'string', default: '', help: `Convenience date for both start and end (YYYY-MM-DD). Defaults to yesterday (${DEFAULT_QUERY_DATE}). Supports CHINATAX_SALES_DATE.` },
    { name: 'start-date', type: 'string', default: DEFAULT_QUERY_DATE, help: 'Invoice issue-date start / 开票日期（起） (YYYY-MM-DD). Defaults to yesterday. Supports CHINATAX_SALES_START_DATE.' },
    { name: 'end-date', type: 'string', default: DEFAULT_QUERY_DATE, help: 'Invoice issue-date end / 开票日期（止） (YYYY-MM-DD). Defaults to yesterday. Supports CHINATAX_SALES_END_DATE.' },
    { name: 'downloads-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Chrome download directory to watch. Supports CHINATAX_DOWNLOADS_DIR.' },
    { name: 'output-dir', type: 'string', default: DEFAULT_DOWNLOADS_DIR, help: 'Directory for the renamed workbook. Supports CHINATAX_SALES_OUTPUT_DIR.' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Replace an existing .xlsx result or empty .txt no-data marker with the same subject and date range.' },
    { name: 'subject-timeout', type: 'int', default: 30, help: 'Seconds to wait for subject information.' },
    { name: 'query-timeout', type: 'int', default: 60, help: 'Seconds to wait for the query result.' },
    { name: 'download-timeout', type: 'int', default: 120, help: 'Seconds to wait for the exported workbook.' },
    { name: 'timeout', type: 'int', default: 300, help: 'Max seconds for the overall command (default: 300).' },
  ],
  columns: ['status', 'subjectName', 'startDate', 'endDate', 'rowCount', 'downloaded', 'filename', 'filePath', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for chinatax-sales-detail download');

    const portalUrl = taxPlatformUrl(
      String(argument(kwargs, 'portal-url', 'portalUrl') || process.env.CHINATAX_PORTAL_URL || DEFAULT_PORTAL_URL),
      'portal-url',
    );
    const queryUrl = taxPlatformUrl(
      String(argument(kwargs, 'query-url', 'queryUrl') || process.env.CHINATAX_SALES_QUERY_URL || DEFAULT_QUERY_URL),
      'query-url',
    );
    const singleDate = String(argument(kwargs, 'date', 'date') || process.env.CHINATAX_SALES_DATE || '').trim();
    const startDate = validDate(
      singleDate
        || process.env.CHINATAX_SALES_START_DATE
        || argument(kwargs, 'start-date', 'startDate')
        || DEFAULT_QUERY_DATE,
      'start-date',
    );
    const endDate = validDate(
      singleDate
        || process.env.CHINATAX_SALES_END_DATE
        || argument(kwargs, 'end-date', 'endDate')
        || DEFAULT_QUERY_DATE,
      'end-date',
    );
    if (startDate > endDate) throw new ArgumentError('start-date must be on or before end-date');
    const downloadsDir = path.resolve(String(
      argument(kwargs, 'downloads-dir', 'downloadsDir')
        || process.env.CHINATAX_DOWNLOADS_DIR
        || DEFAULT_DOWNLOADS_DIR,
    ));
    const outputDir = path.resolve(String(
      argument(kwargs, 'output-dir', 'outputDir')
        || process.env.CHINATAX_SALES_OUTPUT_DIR
        || DEFAULT_DOWNLOADS_DIR,
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
    const filenameBase = `${sanitizeFilePart(subject.name)}-销项-${startDate}_${endDate}`;
    const filename = `${filenameBase}.xlsx`;
    const targetPath = path.join(outputDir, filename);

    await page.goto(queryUrl);
    await waitForQueryForm(page, queryUrl, queryTimeout);
    await page.wait(2);
    await ensureIssuedInvoiceQuery(page);
    await setDateInput(page, '开票日期起', startDate);
    await setDateInput(page, '开票日期止', endDate);
    await page.wait(0.5);
    await verifyDateInputs(page, startDate, endDate);
    const result = await confirmQueryResult(page, queryUrl);

    if (result.noData || result.rowCount === 0) {
      const noDataFilename = `${filenameBase}.txt`;
      const noDataPath = path.join(outputDir, noDataFilename);
      writeNoDataMarker(noDataPath, overwrite);
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

    await clickExactVisible(page, '导出', 'button', 'Export button not found after a non-empty query');
    await page.wait(0.25);
    const before = xlsxSnapshot(downloadsDir);
    await clickExactVisible(
      page,
      '导出全部',
      '.t-dropdown__item-text, .t-dropdown__item, [role="menuitem"], li',
      'Export all menu item not found',
    );
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
