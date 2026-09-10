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

const HEALTH_URL = 'https://jdsz.jd.com/szweb/view/supply/health-inventory-analysis-temp.html';
const REPORT_URL = 'https://jdsz.jd.com/szweb/view/reports-center/my-report-temp.html?brand=%2Fbrand%2FreportCenter%2FmyReport.html';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_NAME_RE = /长库龄明细.*\.xlsx$/i;

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

function requireDate(value) {
  const reportDate = String(value || yesterdayLocal()).trim();
  if (!DATE_RE.test(reportDate)) {
    throw new ArgumentError(`date must be YYYY-MM-DD, got: ${value || ''}`);
  }

  const [year, month, day] = reportDate.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (formatLocalDate(parsed) !== reportDate) {
    throw new ArgumentError(`date is not a valid calendar date: ${reportDate}`);
  }
  if (reportDate > yesterdayLocal()) {
    throw new ArgumentError(`date must not be later than yesterday (${yesterdayLocal()})`);
  }
  return reportDate;
}

function requireTimeout(value) {
  const timeoutSeconds = Number(value ?? 600);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 60) {
    throw new ArgumentError('timeout must be an integer >= 60 seconds');
  }
  if (timeoutSeconds > 1800) {
    throw new ArgumentError('timeout must be <= 1800 seconds');
  }
  return timeoutSeconds;
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
      return {
        sourceName: entry.name,
        sourcePath: fullPath,
        sourceSize: stat.size,
        sourceMtimeMs: stat.mtimeMs,
      };
    });
}

function findFreshDownloadedXlsx(dir, sinceMs) {
  return fileSnapshot(dir)
    .filter((item) => item.sourceMtimeMs >= sinceMs - 1000)
    .filter((item) => !item.sourceName.endsWith('.crdownload') && !item.sourceName.endsWith('.tmp'))
    .filter((item) => REPORT_NAME_RE.test(item.sourceName) || item.sourceName.toLowerCase().endsWith('.xlsx'))
    .sort((left, right) => right.sourceMtimeMs - left.sourceMtimeMs)[0] || null;
}

async function waitForDownloadedXlsx(dir, sinceMs, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    const freshItem = findFreshDownloadedXlsx(dir, sinceMs);
    if (freshItem && freshItem.sourceSize > 0) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const stableItem = findFreshDownloadedXlsx(dir, sinceMs);
      if (
        stableItem
        && stableItem.sourcePath === freshItem.sourcePath
        && stableItem.sourceSize === freshItem.sourceSize
      ) {
        return stableItem;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new TimeoutError('JD Shangzhi long-inventory XLSX download', Math.ceil(timeoutMs / 1000));
}

async function waitForStableDownloadedFile(sourcePath, sinceMs, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  let previousSize = -1;
  while (Date.now() < deadlineMs) {
    if (sourcePath && fs.existsSync(sourcePath)) {
      const stat = fs.statSync(sourcePath);
      const isFresh = stat.mtimeMs >= sinceMs - 1500;
      const isCompleteName = !sourcePath.endsWith('.crdownload') && !sourcePath.endsWith('.tmp');
      if (isFresh && isCompleteName && stat.size > 0 && stat.size === previousSize) {
        return {
          sourceName: path.basename(sourcePath),
          sourcePath,
          sourceSize: stat.size,
          sourceMtimeMs: stat.mtimeMs,
        };
      }
      previousSize = stat.size;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function dismissInterferingPopups(page) {
  let dismissedCount = 0;

  // A native alert/confirm blocks every CDP-backed page operation. Dismiss it
  // defensively; Chrome returns an error when no JavaScript dialog is open.
  if (typeof page.handleJavaScriptDialog === 'function') {
    try {
      await page.handleJavaScriptDialog(false);
      dismissedCount += 1;
      await page.wait(0.2);
    } catch {
      // No native dialog is currently open.
    }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marked = await page.evaluate(() => {
      const marker = 'data-opencli-jd-popup-dismiss';
      document.querySelectorAll(`[${marker}]`)
        .forEach((element) => element.removeAttribute(marker));

      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0;
      };
      const normalizedText = (element) => (element.innerText || element.textContent || '')
        .replace(/\s+/g, '')
        .trim();
      const popupSelector = [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]',
        'dialog[open]',
        '.jmtd-modal',
        '.jmtd-modal-wrap',
        '.jmtd-modal-wrapper',
        '.jmtd-dialog',
        '.jmtd-dialog-wrap',
        '.grace-modal',
        '[class*="modal"]',
        '[class*="dialog"]',
        '[class*="popup"]',
      ].join(',');
      const nuisanceKeywords = [
        '公告', '通知', '温馨提示', '系统提示', '问卷', '调研', '满意度',
        '新手引导', '功能介绍', '体验新版', '我知道了', '知道了',
        '稍后再说', '下次再说', '不再提示',
      ];
      const protectedKeywords = [
        '前往下载中心', '下载数据', '生成报告', '报告生成',
      ];
      const dismissLabels = [
        '关闭', '我知道了', '知道了', '稍后再说', '下次再说',
        '暂不', '取消', '跳过', '不再提示', 'Close', 'Gotit', 'Later', 'Skip',
      ];

      const roots = Array.from(new Set(Array.from(document.querySelectorAll(popupSelector))))
        .filter(visible)
        .sort((left, right) => {
          const leftZ = Number.parseInt(getComputedStyle(left).zIndex, 10) || 0;
          const rightZ = Number.parseInt(getComputedStyle(right).zIndex, 10) || 0;
          return rightZ - leftZ;
        });

      for (const root of roots) {
        const rootText = normalizedText(root);
        if (protectedKeywords.some((keyword) => rootText.includes(keyword))) continue;

        const style = getComputedStyle(root);
        const explicitlyModal = root.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
        const popupLike = explicitlyModal
          || style.position === 'fixed'
          || nuisanceKeywords.some((keyword) => rootText.includes(keyword));
        if (!popupLike) continue;

        const candidates = Array.from(root.querySelectorAll([
          'button',
          '[role="button"]',
          '[aria-label]',
          '[title]',
          '.jmtd-modal-close',
          '.jmtd-dialog-close',
          '[class*="modal-close"]',
          '[class*="dialog-close"]',
          '[class*="close"]',
        ].join(','))).filter(visible);

        const target = candidates.find((element) => {
          const label = [
            normalizedText(element),
            element.getAttribute('aria-label') || '',
            element.getAttribute('title') || '',
          ].join('').replace(/\s+/g, '');
          const className = String(element.className || '');
          const labelMatches = dismissLabels.some((value) => label === value || label.includes(value));
          const closeIcon = /(^|[-_])(close|dismiss)([-_]|$)|jmti-close|icon-close/i.test(className)
            && (!label || /^(×|x)$/i.test(label));
          return labelMatches || closeIcon;
        });

        if (target) {
          target.setAttribute(marker, '1');
          return true;
        }
      }
      return false;
    });

    if (!marked) break;
    await page.click('[data-opencli-jd-popup-dismiss]');
    dismissedCount += 1;
    await page.wait(0.35);
  }

  return dismissedCount;
}

async function readPageState(page) {
  return await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const dateControl = document.querySelector('.jmtd-base-input.jmtd-date-picker:not(.jmtd-popover)');
    const selectedMetric = Array.from(document.querySelectorAll('label.jmtp-summary-card'))
      .find((element) => (element.textContent || '').includes('长库龄库存数量'));
    const detailSection = Array.from(document.querySelectorAll('section'))
      .find((element) => (element.querySelector('.title')?.textContent || '').replace(/\s+/g, '').includes('长库龄库存明细'));
    return {
      currentUrlText: location.href,
      pageTitleText: document.title || '',
      selectedDateText: (dateControl?.textContent || '').trim(),
      longMetricSelected: Boolean(selectedMetric?.classList.contains('jmtp-summary-card-checked')),
      detailSectionPresent: Boolean(detailSection),
      detailVisibleRowCount: detailSection?.querySelectorAll('tbody tr').length || 0,
      loginRequired: /请登录|账号登录|登录京东/.test(bodyText) || /login/i.test(location.href),
    };
  });
}

async function ensureHealthPage(page) {
  await page.goto(HEALTH_URL);
  const deadlineMs = Date.now() + 60000;
  while (Date.now() < deadlineMs) {
    await dismissInterferingPopups(page).catch(() => 0);
    const pageState = await readPageState(page).catch(() => ({}));
    if (pageState.loginRequired) {
      throw new AuthRequiredError('jdsz.jd.com', 'JD Shangzhi login is required in the selected Chrome profile');
    }
    if (pageState.pageTitleText.includes('库存健康') && pageState.selectedDateText) return pageState;
    await page.wait(0.8);
  }
  throw new TimeoutError('JD Shangzhi inventory health page', 60);
}

async function selectLongInventoryMetric(page) {
  await dismissInterferingPopups(page);
  const deadlineMs = Date.now() + 60000;
  while (Date.now() < deadlineMs) {
    const marked = await page.evaluate(() => {
      document.querySelectorAll('[data-opencli-jd-long-metric]')
        .forEach((element) => element.removeAttribute('data-opencli-jd-long-metric'));
      const target = Array.from(document.querySelectorAll('label.jmtp-summary-card'))
        .find((element) => (element.textContent || '').includes('长库龄库存数量'));
      if (!target) return false;
      target.setAttribute('data-opencli-jd-long-metric', '1');
      return true;
    });
    if (marked) {
      await page.click('[data-opencli-jd-long-metric]');
      await page.wait(0.5);
      return;
    }
    await page.wait(0.5);
  }
  throw new TimeoutError('JD Shangzhi long-inventory metric card', 60);
}

function monthKey(dateText) {
  return dateText.slice(0, 7);
}

function addMonths(monthText, delta) {
  const [year, month] = monthText.split('-').map(Number);
  const next = new Date(year, month - 1 + delta, 1);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}`;
}

async function openDatePicker(page) {
  await dismissInterferingPopups(page);
  const selector = '.jmtd-base-input.jmtd-date-picker:not(.jmtd-popover)';
  const exists = await page.evaluate((targetSelector) => Boolean(document.querySelector(targetSelector)), selector);
  if (!exists) throw new CommandExecutionError('JD Shangzhi date picker was not found');
  await page.click(selector);
  try {
    await page.wait({ selector: '.jmtd-popover.jmtd-date-picker.jmtd-popover-open', timeout: 10000 });
  } catch {
    throw new TimeoutError('JD Shangzhi date picker', 10);
  }
}

async function pickerMonth(page) {
  return await page.evaluate(() => {
    const text = document.querySelector('.jmtd-popover-open .jmtd-date-picker-header-content')?.textContent || '';
    const match = text.match(/(\d{4})\D+(\d{1,2})/);
    return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}` : '';
  });
}

async function clickPickerNavigation(page, direction) {
  const selector = direction < 0
    ? '.jmtd-popover-open .jmtd-date-picker-header-btn-prev-month'
    : '.jmtd-popover-open .jmtd-date-picker-header-btn-next-month';
  const exists = await page.evaluate((targetSelector) => Boolean(document.querySelector(targetSelector)), selector);
  if (!exists) throw new CommandExecutionError(`Could not navigate the date picker ${direction < 0 ? 'backward' : 'forward'}`);
  await page.click(selector);
  await page.wait(0.35);
}

async function markPickerDay(page, day) {
  return await page.evaluate((targetDay) => {
    document.querySelectorAll('[data-opencli-jd-date-cell]')
      .forEach((element) => element.removeAttribute('data-opencli-jd-date-cell'));
    const cells = Array.from(document.querySelectorAll(
      '.jmtd-popover-open td[role="gridcell"]:not(.jmtd-date-picker-date-cell-diff-month):not(.jmtd-date-picker-cell-disabled)',
    ));
    const target = cells.find((cell) => (cell.textContent || '').trim() === String(targetDay));
    if (!target) return false;
    target.setAttribute('data-opencli-jd-date-cell', '1');
    return true;
  }, day);
}

async function selectDate(page, reportDate) {
  await openDatePicker(page);
  const targetMonth = monthKey(reportDate);
  let visibleMonth = await pickerMonth(page);
  if (!/^\d{4}-\d{2}$/.test(visibleMonth)) {
    throw new CommandExecutionError('Could not read the visible month from the date picker');
  }

  for (let attempt = 0; attempt < 48 && visibleMonth !== targetMonth; attempt += 1) {
    const direction = targetMonth > visibleMonth ? 1 : -1;
    await clickPickerNavigation(page, direction);
    visibleMonth = addMonths(visibleMonth, direction);
  }
  if (visibleMonth !== targetMonth) {
    throw new CommandExecutionError(`Date picker could not reach ${targetMonth}`);
  }

  const marked = await markPickerDay(page, Number(reportDate.slice(8, 10)));
  if (!marked) throw new CommandExecutionError(`Date is unavailable in the picker: ${reportDate}`);
  await page.click('[data-opencli-jd-date-cell]');

  const deadlineMs = Date.now() + 10000;
  while (Date.now() < deadlineMs) {
    const pageState = await readPageState(page).catch(() => ({}));
    if (pageState.selectedDateText === reportDate) return;
    await page.wait(0.4);
  }
  throw new TimeoutError(`JD Shangzhi date selection ${reportDate}`, 10);
}

async function confirmFilters(page, reportDate) {
  await dismissInterferingPopups(page);
  const marked = await page.evaluate(() => {
    document.querySelectorAll('[data-opencli-jd-filter-confirm]')
      .forEach((element) => element.removeAttribute('data-opencli-jd-filter-confirm'));
    const buttons = Array.from(document.querySelectorAll('form button'));
    const target = buttons.find((button) => (button.textContent || '').trim() === '确定');
    if (!target) return false;
    target.setAttribute('data-opencli-jd-filter-confirm', '1');
    return true;
  });
  if (!marked) throw new CommandExecutionError('Inventory-health filter confirm button was not found');
  await page.click('[data-opencli-jd-filter-confirm]');

  const deadlineMs = Date.now() + 60000;
  while (Date.now() < deadlineMs) {
    const pageState = await readPageState(page).catch(() => ({}));
    if (
      pageState.selectedDateText === reportDate
      && pageState.longMetricSelected
      && pageState.detailSectionPresent
    ) {
      await page.wait(1);
      return pageState;
    }
    await page.wait(0.8);
  }
  throw new TimeoutError(`JD Shangzhi inventory data for ${reportDate}`, 60);
}

async function requestDetailReport(page) {
  await dismissInterferingPopups(page);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.wait(0.5);

  const marked = await page.evaluate(() => {
    document.querySelectorAll('[data-opencli-jd-detail-download]')
      .forEach((element) => element.removeAttribute('data-opencli-jd-detail-download'));
    const detailSection = Array.from(document.querySelectorAll('section'))
      .find((element) => (element.querySelector('.title')?.textContent || '').replace(/\s+/g, '').includes('长库龄库存明细'));
    const target = Array.from(detailSection?.querySelectorAll('button') || [])
      .find((button) => (button.textContent || '').trim() === '下载数据');
    if (!target) return false;
    target.setAttribute('data-opencli-jd-detail-download', '1');
    return true;
  });
  if (!marked) throw new CommandExecutionError('Long-inventory detail download button was not found');

  const requestedAtMs = Date.now();
  await page.click('[data-opencli-jd-detail-download]');
  const dialogDeadlineMs = Date.now() + 15000;
  while (Date.now() < dialogDeadlineMs) {
    const dialogReady = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
      .some((button) => (button.textContent || '').trim() === '前往下载中心'));
    if (dialogReady) return requestedAtMs;
    await page.wait(0.4);
  }
  throw new TimeoutError('JD Shangzhi report-generation dialog', 15);
}

async function readLatestReport(page, requestedAtMs) {
  return await page.evaluate((minimumCreatedMs) => {
    const rows = Array.from(document.querySelectorAll('tbody.grace-grid-tbody tr'));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const reportLabel = (row.querySelector('.reportName')?.textContent || '').trim();
      if (!reportLabel.includes('长库龄明细') || !reportLabel.toLowerCase().endsWith('.xlsx')) continue;
      const cells = Array.from(row.querySelectorAll('td'));
      const generatedAtText = (cells[2]?.textContent || '').trim();
      const reportStatusText = (cells[3]?.textContent || '').trim();
      const generatedAtMs = Date.parse(generatedAtText.replace(' ', 'T'));
      const recentEnough = Number.isFinite(generatedAtMs) && generatedAtMs >= minimumCreatedMs - 300000;
      return {
        reportLabelText: reportLabel,
        generatedAtDisplay: generatedAtText,
        statusDisplay: reportStatusText,
        generatedAtEpoch: generatedAtMs,
        isRecentEnough: recentEnough,
        sourceRowIndex: rowIndex,
      };
    }
    return null;
  }, requestedAtMs);
}

async function markLatestReportDownload(page, rowIndex) {
  return await page.evaluate((targetRowIndex) => {
    document.querySelectorAll('[data-opencli-jd-report-download]')
      .forEach((element) => element.removeAttribute('data-opencli-jd-report-download'));
    const row = document.querySelectorAll('tbody.grace-grid-tbody tr')[targetRowIndex];
    const target = Array.from(row?.querySelectorAll('.grid-operator-btn span') || [])
      .find((element) => (element.textContent || '').trim() === '下载');
    if (!target) return false;
    target.setAttribute('data-opencli-jd-report-download', '1');
    return true;
  }, rowIndex);
}

async function waitForLatestGeneratedReport(page, requestedAtMs, deadlineMs) {
  await page.goto(REPORT_URL);
  while (Date.now() < deadlineMs) {
    await dismissInterferingPopups(page).catch(() => 0);
    const bodyState = await page.evaluate(() => ({
      currentUrlText: location.href,
      bodyText: document.body?.innerText || '',
      hasReportTable: Boolean(document.querySelector('tbody.grace-grid-tbody')),
    })).catch(() => ({}));
    if (/请登录|账号登录|登录京东/.test(bodyState.bodyText || '') || /login/i.test(bodyState.currentUrlText || '')) {
      throw new AuthRequiredError('jdsz.jd.com', 'JD Shangzhi login expired before the report could be downloaded');
    }

    if (bodyState.hasReportTable) {
      const latestItem = await readLatestReport(page, requestedAtMs);
      if (
        latestItem
        && latestItem.isRecentEnough
        && latestItem.statusDisplay.includes('已生成')
      ) {
        const marked = await markLatestReportDownload(page, latestItem.sourceRowIndex);
        if (!marked) throw new CommandExecutionError('Download control was not found on the latest generated report');
        return latestItem;
      }
    }

    await page.wait(3);
    await page.goto(REPORT_URL);
  }
  const timeoutSeconds = Math.max(1, Math.ceil((deadlineMs - requestedAtMs) / 1000));
  throw new TimeoutError('JD Shangzhi report generation', timeoutSeconds);
}

async function clickAndWaitForReportDownload(page, timeoutMs, downloadPattern) {
  const startedAtMs = Date.now();
  const eventWait = typeof page.waitForDownload === 'function'
    ? page.waitForDownload(downloadPattern, timeoutMs)
      .then((result) => ({ result }))
      .catch((error) => ({ error }))
    : null;

  // Give the Browser Bridge enough time to register its download listeners
  // before the click starts the browser download.
  if (eventWait) await page.wait(0.25);
  await page.click('[data-opencli-jd-report-download]');

  let eventOutcome = null;
  if (eventWait) {
    eventOutcome = await eventWait;
    const eventPath = eventOutcome.result?.downloaded && eventOutcome.result?.filename
      ? path.resolve(eventOutcome.result.filename)
      : '';
    if (eventPath) {
      const eventItem = await waitForStableDownloadedFile(eventPath, startedAtMs, 5000);
      if (eventItem) return eventItem;
    }
  }

  // Older Browser Bridge versions and non-default Chrome download locations
  // may not yield an event path. Keep the original directory scan as a short
  // compatibility fallback after the event wait has completed.
  try {
    const fallbackMs = Math.max(1000, timeoutMs - (Date.now() - startedAtMs));
    return await waitForDownloadedXlsx(downloadsDir(), startedAtMs, fallbackMs);
  } catch {
    const reason = eventOutcome?.error?.message
      || eventOutcome?.result?.error
      || 'Chrome did not create an XLSX download';
    throw new CommandExecutionError(`JD Shangzhi report download did not start: ${reason}`);
  }
}

async function downloadLatestReport(page, reportDate, outputDir, remainingMs, latestItem) {
  fs.mkdirSync(outputDir, { recursive: true });
  const downloadDeadlineMs = Date.now() + remainingMs;
  const downloadPattern = latestItem.generatedAtDisplay.replace(' ', '').replaceAll(':', '_');
  let downloadedItem = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptRemainingMs = downloadDeadlineMs - Date.now();
    if (attemptRemainingMs < 1000) break;

    await dismissInterferingPopups(page);
    const marked = await markLatestReportDownload(page, latestItem.sourceRowIndex);
    if (!marked) {
      throw new CommandExecutionError('Download control was not found on the latest generated report');
    }

    if (attempt > 1) await page.wait(1);
    const attemptTimeoutMs = Math.min(45000, attemptRemainingMs);
    try {
      downloadedItem = await clickAndWaitForReportDownload(page, attemptTimeoutMs, downloadPattern);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!downloadedItem) {
    throw new CommandExecutionError(
      `JD Shangzhi report download failed after 2 attempts: ${lastError?.message || 'no browser download event'}`,
    );
  }
  const targetPath = path.join(outputDir, `${reportDate}京东自营长库龄库存明细.xlsx`);

  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  fs.copyFileSync(downloadedItem.sourcePath, targetPath);
  try {
    fs.unlinkSync(downloadedItem.sourcePath);
  } catch {
    // Chrome can keep the source file open briefly; the copied target is complete.
  }
  return { targetPath, targetSize: downloadedItem.sourceSize };
}

cli({
  site: 'jd-shangzhi',
  name: 'download-long-inventory-report',
  description: 'Download the JD self-operated long-inventory detail XLSX for one date and keep the current login session.',
  access: 'read',
  example: 'opencli --profile 36pr69ys jd-shangzhi download-long-inventory-report --date 2026-08-07 --output . --site-session persistent --window foreground -f yaml',
  domain: 'jdsz.jd.com',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'date', type: 'string', default: '', help: 'Inventory date, YYYY-MM-DD. Defaults to yesterday.' },
    { name: 'output', type: 'string', default: '.', help: 'Directory for YYYY-MM-DD京东自营长库龄库存明细.xlsx.' },
    { name: 'timeout', type: 'int', default: 600, help: 'Max seconds for the overall command (60-1800, default: 600).' },
  ],
  columns: ['status', 'date', 'file', 'bytes', 'reportName', 'createdAt', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for jd-shangzhi download-long-inventory-report');

    const reportDate = requireDate(kwargs.date);
    const timeoutSeconds = requireTimeout(kwargs.timeout);
    const outputDir = resolveOutputDir(kwargs.output);
    const overallDeadlineMs = Date.now() + timeoutSeconds * 1000;
    await ensureHealthPage(page);
    await selectLongInventoryMetric(page);
    await selectDate(page, reportDate);
    await confirmFilters(page, reportDate);
    const requestedAtMs = await requestDetailReport(page);
    const latestItem = await waitForLatestGeneratedReport(page, requestedAtMs, overallDeadlineMs);
    const remainingMs = overallDeadlineMs - Date.now();
    if (remainingMs <= 0) throw new TimeoutError('JD Shangzhi long-inventory workflow', timeoutSeconds);
    const downloadedResult = await downloadLatestReport(page, reportDate, outputDir, remainingMs, latestItem);

    return [{
      status: 'ok',
      date: reportDate,
      file: downloadedResult.targetPath,
      bytes: downloadedResult.targetSize,
      reportName: latestItem.reportLabelText,
      createdAt: latestItem.generatedAtDisplay,
      url: REPORT_URL,
    }];
  },
});
