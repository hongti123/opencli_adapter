/**
 * Strategy: COOKIE_API
 * Contract: internal-unstable
 * Evidence:
 * - Chrome download history records GET /flow/gray/excel.do with
 *   _path_=v3/excel/shop/source/detail/v3 for both requested source types.
 * - Authentication comes from page.getCookies({ url: SYCM_ORIGIN }).
 * - A direct replay with profile q7qj3m3a returned HTTP 200,
 *   application/msexcel, and a valid OLE/CFB XLS body.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  TimeoutError,
} from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const SYCM_ORIGIN = 'https://sycm.taobao.com';
const DOWNLOAD_PATH = '/flow/gray/excel.do';
const XLS_OLE_MAGIC = 'd0cf11e0a1b11ae1';
const ZIP_MAGIC = '504b0304';

const SOURCES = {
  keyword: {
    label: '关键词推广',
    pageId: '22.2',
    pPageId: '22.23',
    pageLevel: '3',
  },
  handtao: {
    label: '手淘搜索',
    pageId: '23.s1150',
    pPageId: '30',
    pageLevel: '2',
  },
};

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
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
    throw new ArgumentError(`date must be YYYY-MM-DD, got: ${value || ''}`);
  }
  const parts = date.split('-').map(Number);
  const parsed = new Date(parts[0], parts[1] - 1, parts[2]);
  if (formatLocalDate(parsed) !== date) {
    throw new ArgumentError(`date is not a valid calendar date: ${date}`);
  }
  return date;
}

function resolveSources(value) {
  const source = String(value || 'both').trim().toLowerCase();
  if (source === 'both' || source === 'all') return ['keyword', 'handtao'];
  if (source === 'keyword' || source === '关键词推广') return ['keyword'];
  if (source === 'handtao' || source === 'hand-tao' || source === '手淘搜索' || source === '手淘') return ['handtao'];
  throw new ArgumentError(`source must be one of keyword | handtao | both, got: ${value || ''}`);
}

function resolveOutputDir(value) {
  return path.resolve(String(value || '.'));
}

function resolveOptionalDir(value) {
  const raw = String(value || '').trim();
  return raw ? path.resolve(raw) : null;
}

function buildDownloadUrl(source, date) {
  const url = new URL(DOWNLOAD_PATH, SYCM_ORIGIN);
  const params = {
    _path_: 'v3/excel/shop/source/detail/v3',
    device: '2',
    dateType: 'day',
    dateRange: `${date}|${date}`,
    belong: 'all',
    pageId: source.pageId,
    pPageId: source.pPageId,
    childPageType: 'se_keyword',
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}

function buildRefererUrl(source, date) {
  const url = new URL('/flow/monitor/shopsource/detail', SYCM_ORIGIN);
  const params = {
    belong: 'all',
    childPageType: 'se_keyword',
    crowdType: 'all',
    dateRange: `${date}|${date}`,
    dateType: 'day',
    device: '2',
    pPageId: source.pPageId,
    pageId: source.pageId,
    pageLevel: source.pageLevel,
    pageName: source.label,
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

function formatCookieHeader(cookies) {
  return cookies
    .filter((cookie) => cookie && cookie.name && typeof cookie.value === 'string')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function looksLikeSpreadsheet(buffer) {
  const magic = buffer.subarray(0, 8).toString('hex').toLowerCase();
  return magic === XLS_OLE_MAGIC || magic.startsWith(ZIP_MAGIC);
}

function responsePreview(buffer) {
  return buffer.subarray(0, 500).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function looksLikeLogin(response, contentType, buffer) {
  const finalUrl = String(response.url || '').toLowerCase();
  if (finalUrl.includes('/login') || finalUrl.includes('/custom/login')) return true;
  if (!contentType.includes('html')) return false;
  const preview = responsePreview(buffer).toLowerCase();
  return preview.includes('login') || preview.includes('登录') || preview.includes('passport');
}

async function readSycmCookies(page) {
  const cookies = await page.getCookies({ url: `${SYCM_ORIGIN}/` });
  const cookieHeader = formatCookieHeader(cookies);
  if (!cookieHeader) {
    throw new AuthRequiredError('sycm.taobao.com', 'No Sycm login cookies were found in the selected OpenCLI profile');
  }
  return cookieHeader;
}

async function fetchSpreadsheet(source, date, cookieHeader, timeoutSeconds) {
  const url = buildDownloadUrl(source, date);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let response;
  let body;

  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.ms-excel,application/msexcel,application/octet-stream,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Cookie: cookieHeader,
        Referer: buildRefererUrl(source, date),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new TimeoutError('sycm-shop-flow/download-flow-source', timeoutSeconds);
    }
    throw new CommandExecutionError(`Failed to request Sycm XLS: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (response.status === 401 || response.status === 403 || looksLikeLogin(response, contentType, body)) {
    throw new AuthRequiredError('sycm.taobao.com', 'Sycm login has expired in the selected OpenCLI profile');
  }
  if (!response.ok) {
    throw new CommandExecutionError(`Sycm XLS request failed with HTTP ${response.status}`);
  }
  if (!body.length) {
    throw new CommandExecutionError(`Sycm returned an empty XLS response for ${source.label} on ${date}`);
  }
  if (!looksLikeSpreadsheet(body)) {
    const preview = responsePreview(body);
    throw new CommandExecutionError(
      `Sycm did not return an XLS file for ${source.label} on ${date} (content-type: ${contentType || 'unknown'}${preview ? `; response: ${preview}` : ''})`,
    );
  }

  return { url: url.toString(), body };
}

function saveSpreadsheet(outputDir, date, source, body) {
  fs.mkdirSync(outputDir, { recursive: true });
  const targetPath = path.join(outputDir, `${source.label}${date}.xls`);
  const partialPath = `${targetPath}.part`;

  try {
    fs.writeFileSync(partialPath, body);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.renameSync(partialPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch {
      // Preserve the original filesystem error below.
    }
    throw new CommandExecutionError(`Failed to save XLS to ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return targetPath;
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function moveSpreadsheet(stagingPath, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const targetPath = path.join(destinationDir, path.basename(stagingPath));
  if (samePath(stagingPath, targetPath)) return stagingPath;

  const partialPath = `${targetPath}.part`;
  try {
    if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    fs.copyFileSync(stagingPath, partialPath);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.renameSync(partialPath, targetPath);
    fs.unlinkSync(stagingPath);
  } catch (error) {
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch {
      // Preserve the original filesystem error below.
    }
    throw new CommandExecutionError(
      `Failed to move XLS from ${stagingPath} to ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return targetPath;
}

cli({
  site: 'sycm-shop-flow',
  name: 'download-flow-source',
  description: 'Download Sycm shop-flow source detail XLS directly with cookies from the selected OpenCLI profile.',
  access: 'read',
  example: 'opencli --profile q7qj3m3a sycm-shop-flow download-flow-source --date 2026-08-20 --source both --output "D:\\报表下载" --keyword-destination "\\\\server\\关键词推广" --handtao-destination "\\\\server\\手淘搜索" -f yaml',
  domain: 'sycm.taobao.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'date', type: 'string', default: '', help: 'Data date, YYYY-MM-DD. Defaults to yesterday.' },
    { name: 'source', type: 'string', default: 'both', help: 'Which data to download: keyword | handtao | both (default).' },
    { name: 'output', type: 'string', default: '.', help: 'Staging directory where downloaded XLS files are written first.' },
    { name: 'keyword-destination', type: 'string', default: '', help: 'Optional final directory for the keyword-promotion XLS.' },
    { name: 'handtao-destination', type: 'string', default: '', help: 'Optional final directory for the hand-tao-search XLS.' },
    { name: 'timeout', type: 'int', default: 120, help: 'Max seconds for each direct XLS request (default: 120).' },
  ],
  columns: ['status', 'date', 'source', 'file', 'bytes', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser cookie access is required for sycm-shop-flow download-flow-source');

    const date = requireDate(kwargs.date);
    const sources = resolveSources(kwargs.source);
    const outputDir = resolveOutputDir(kwargs.output);
    const destinations = {
      keyword: resolveOptionalDir(kwargs['keyword-destination']),
      handtao: resolveOptionalDir(kwargs['handtao-destination']),
    };
    const timeoutSeconds = Number(kwargs.timeout || 120);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new ArgumentError(`timeout must be a positive number of seconds, got: ${kwargs.timeout || ''}`);
    }

    const cookieHeader = await readSycmCookies(page);
    const stagedFiles = [];
    for (const sourceKey of sources) {
      const source = SOURCES[sourceKey];
      const result = await fetchSpreadsheet(source, date, cookieHeader, timeoutSeconds);
      const stagingPath = saveSpreadsheet(outputDir, date, source, result.body);
      stagedFiles.push({
        sourceKey,
        sourceConfig: source,
        downloadResult: result,
        stagedPath: stagingPath,
      });
    }

    const results = [];
    for (const staged of stagedFiles) {
      const destinationDir = destinations[staged.sourceKey];
      const targetPath = destinationDir
        ? moveSpreadsheet(staged.stagedPath, destinationDir)
        : staged.stagedPath;
      results.push({
        status: 'ok',
        date,
        source: staged.sourceConfig.label,
        file: targetPath,
        bytes: staged.downloadResult.body.length,
        url: staged.downloadResult.url,
      });
    }
    return results;
  },
});
