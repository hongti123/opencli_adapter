import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

const DEFAULT_PORTAL_URL = 'https://etax.guangdong.chinatax.gov.cn:8443/loginb/';
const DEFAULT_QUOTA_URL = 'https://dppt.guangdong.chinatax.gov.cn:8443/invoice-business?ruuid=1786615619552';
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Downloads');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUTH_FAILURE_STABLE_SECONDS = 8;
const SHEET_NAME = '额度';

if (!process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT) {
  process.env.OPENCLI_BROWSER_COMMAND_TIMEOUT = '180';
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
    const result = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      };
      const taxpayerIdRe = /[0-9A-Z]{15,20}/;
      const subjectCandidates = [];

      for (const element of document.querySelectorAll('div[title]')) {
        if (!visible(element)) continue;
        const name = (element.getAttribute('title') || element.textContent || '').trim();
        if (!name || name.length < 4) continue;
        let ancestor = element.parentElement;
        for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
          const text = (ancestor.innerText || ancestor.textContent || '').trim();
          const taxpayerId = text.match(taxpayerIdRe)?.[0] || '';
          if (taxpayerId) {
            subjectCandidates.push({ subjectName: name, taxpayerId, depth, textLength: text.length });
            break;
          }
        }
      }

      subjectCandidates.sort((left, right) => left.depth - right.depth || left.textLength - right.textLength);
      return {
        url: location.href,
        title: document.title || '',
        body: document.body?.innerText || '',
        subjectCandidate: subjectCandidates[0] || null,
      };
    });
    const authenticationPending = observeAuthentication(result);
    if (!authenticationPending && result.subjectCandidate?.subjectName) return result.subjectCandidate;
    await page.wait(0.5);
  }

  throw new TimeoutError('tax subject information', timeoutSeconds);
}

function parseQuotaAmount(value, label) {
  const text = String(value || '').replace(/[，,]/g, '').trim();
  const matched = text.match(/-?\d+(?:\.\d+)?/);
  if (!matched) throw new CommandExecutionError(`${label} was not a recognizable numeric amount: ${value || '(empty)'}`);
  const amount = Number(matched[0]);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new CommandExecutionError(`${label} was not a valid non-negative amount: ${value}`);
  }
  return amount;
}

async function extractQuota(page, quotaUrl, timeoutSeconds) {
  await page.goto(quotaUrl);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const observeAuthentication = createAuthenticationMonitor(new URL(quotaUrl).hostname);

  while (Date.now() < deadline) {
    const result = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      };
      const normalize = (value) => String(value || '').replace(/\s+/g, '');
      const sections = Array.from(document.querySelectorAll('.section-wrap')).filter(visible);
      const quotaSection = sections.find((section) => normalize(section.innerText).includes('开票情况概览'));
      let availableText = '';
      let totalText = '';

      if (quotaSection) {
        quotaSection.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
        const panels = Array.from(quotaSection.querySelectorAll('.g-data-display-panel')).filter(visible);
        const quotaPanel = panels.find((panel) => {
          const header = panel.querySelector('.g-data-display-panel-header');
          const headerText = normalize(header?.innerText || header?.textContent);
          return /^可用发票额度(?:（申报前）|（申报后）)?（元）$/.test(headerText);
        });
        availableText = (quotaPanel?.querySelector('.g-data-display-content')?.textContent || '').trim();
        const footerParts = Array.from(quotaPanel?.querySelectorAll('.g-data-display-panel-footer .g-tooltip-label-label') || []);
        totalText = (footerParts.find((element) => normalize(element.textContent).startsWith('发票总额度：'))?.textContent || '').trim();
      }

      return {
        url: location.href,
        title: document.title || '',
        body: document.body?.innerText || '',
        sectionFound: Boolean(quotaSection),
        availableText,
        totalText,
      };
    });
    const authenticationPending = observeAuthentication(result);
    if (!authenticationPending && result.sectionFound && result.availableText && result.totalText) {
      await page.wait(0.5);
      return {
        availableInvoiceQuota: parseQuotaAmount(result.availableText, 'available invoice quota'),
        totalInvoiceQuota: parseQuotaAmount(result.totalText, 'total invoice quota'),
        url: result.url,
      };
    }
    await page.wait(0.5);
  }

  throw new TimeoutError('invoice quota overview', timeoutSeconds);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  const { time, day } = dosTimestamp();
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const source = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const localHeader = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(8), uint16(time), uint16(day),
      uint32(checksum), uint32(compressed.length), uint32(source.length), uint16(name.length), uint16(0), name,
    ]);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.concat([
      uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(8), uint16(time), uint16(day),
      uint32(checksum), uint32(compressed.length), uint32(source.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(offset), name,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(centralDirectory.length), uint32(offset), uint16(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function workbookEntries(availableInvoiceQuota, totalInvoiceQuota) {
  const created = new Date().toISOString();
  const sheetName = xmlEscape(SHEET_NAME);
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:B2"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols><col min="1" max="2" width="22" customWidth="1"/></cols>
  <sheetData>
    <row r="1" ht="24" customHeight="1">
      <c r="A1" s="1" t="inlineStr"><is><t>可用发票额度</t></is></c>
      <c r="B1" s="1" t="inlineStr"><is><t>发票总额度</t></is></c>
    </row>
    <row r="2" ht="24" customHeight="1">
      <c r="A2" s="2"><v>${availableInvoiceQuota}</v></c>
      <c r="B2" s="2"><v>${totalInvoiceQuota}</v></c>
    </row>
  </sheetData>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;

  return [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: 'docProps/app.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>OpenCLI</Application>
  <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>
  <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${sheetName}</vt:lpstr></vt:vector></TitlesOfParts>
</Properties>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>OpenCLI</dc:creator><cp:lastModifiedBy>OpenCLI</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
  <sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E2E3"/></left><right style="thin"><color rgb="FFD9E2E3"/></right><top style="thin"><color rgb="FFD9E2E3"/></top><bottom style="thin"><color rgb="FFD9E2E3"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: worksheet },
  ];
}

function writeQuotaWorkbook(targetPath, availableInvoiceQuota, totalInvoiceQuota, overwrite) {
  if (fs.existsSync(targetPath) && !overwrite) {
    throw new CommandExecutionError(`Target file already exists: ${targetPath}; pass --overwrite true to replace it`);
  }

  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const workbook = createZip(workbookEntries(availableInvoiceQuota, totalInvoiceQuota));
    fs.writeFileSync(temporaryPath, workbook, { flag: 'wx' });
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {}
    if (error instanceof CommandExecutionError) throw error;
    throw new CommandExecutionError(`Could not create quota workbook: ${error?.message || error}`);
  }
}

// Strategy: UI_SELECTOR; contract: visible-ui. The page's signed internal API
// is intentionally avoided in favor of the user-visible quota overview panel.
cli({
  site: 'chinatax-invoice-quo',
  name: 'download',
  description: 'Read the authenticated tax subject and invoice quota overview, then create a one-sheet Excel workbook named for the subject and file date.',
  access: 'read',
  example: 'opencli --profile opc-default chinatax-invoice-quo download --portal-url "https://etax.guangdong.chinatax.gov.cn:8443/loginb/" --quota-url "https://dppt.guangdong.chinatax.gov.cn:8443/invoice-business?ruuid=1786615619552" --site-session persistent --keep-tab true -f yaml',
  domain: 'chinatax.gov.cn',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'portal-url', type: 'string', default: '', help: 'Authenticated tax portal URL used to read the subject name. Defaults to CHINATAX_PORTAL_URL, then the Guangdong portal URL.' },
    { name: 'quota-url', type: 'string', default: '', help: 'Invoice-business URL containing the quota overview. Defaults to CHINATAX_INVOICE_QUO_URL / CHINATAX_INVOICE_QUOTA_URL, then the Guangdong invoice-business URL.' },
    { name: 'file-date', type: 'string', default: '', help: 'Date used in [subject]-发票额度-[file-date].xlsx (YYYY-MM-DD). Defaults to CHINATAX_INVOICE_QUO_FILE_DATE, then today.' },
    { name: 'output-dir', type: 'string', default: '', help: 'Directory for the generated workbook. Defaults to CHINATAX_INVOICE_QUO_OUTPUT_DIR, then the Downloads directory.' },
    { name: 'overwrite', type: 'boolean', default: false, help: 'Replace an existing [subject]-发票额度-[file-date].xlsx file.' },
    { name: 'subject-timeout', type: 'int', default: 30, help: 'Seconds to wait for subject information.' },
    { name: 'quota-timeout', type: 'int', default: 60, help: 'Seconds to wait for the invoice quota overview.' },
    { name: 'timeout', type: 'int', default: 180, help: 'Max seconds for the overall command (default: 180).' },
  ],
  columns: ['status', 'subjectName', 'taxpayerId', 'availableInvoiceQuota', 'totalInvoiceQuota', 'filename', 'filePath', 'sheetName', 'url'],
  func: async (page, kwargs) => {
    if (!page) throw new CommandExecutionError('Browser session required for chinatax-invoice-quo download');

    const portalUrl = taxPlatformUrl(
      argument(kwargs, 'portal-url', 'portalUrl')
        || process.env.CHINATAX_PORTAL_URL
        || DEFAULT_PORTAL_URL,
      'portal-url',
    );
    const quotaUrl = taxPlatformUrl(
      argument(kwargs, 'quota-url', 'quotaUrl')
        || process.env.CHINATAX_INVOICE_QUO_URL
        || process.env.CHINATAX_INVOICE_QUOTA_URL
        || DEFAULT_QUOTA_URL,
      'quota-url',
    );
    const fileDate = validDate(
      argument(kwargs, 'file-date', 'fileDate')
        || process.env.CHINATAX_INVOICE_QUO_FILE_DATE
        || formatLocalDate(new Date()),
      'file-date',
    );
    const outputDir = path.resolve(String(
      argument(kwargs, 'output-dir', 'outputDir')
        || process.env.CHINATAX_INVOICE_QUO_OUTPUT_DIR
        || DEFAULT_OUTPUT_DIR,
    ));
    const overwrite = booleanArg(argument(kwargs, 'overwrite', 'overwrite'), false, 'overwrite');
    const subjectTimeout = positiveInt(argument(kwargs, 'subject-timeout', 'subjectTimeout'), 'subject-timeout');
    const quotaTimeout = positiveInt(argument(kwargs, 'quota-timeout', 'quotaTimeout'), 'quota-timeout');

    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (error) {
      throw new CommandExecutionError(`Could not create output directory ${outputDir}: ${error?.message || error}`);
    }
    if (!fs.statSync(outputDir).isDirectory()) throw new ArgumentError(`output-dir is not a directory: ${outputDir}`);

    const subject = await extractSubject(page, portalUrl, subjectTimeout);
    const quota = await extractQuota(page, quotaUrl, quotaTimeout);
    const filename = `${sanitizeFilePart(subject.subjectName)}-发票额度-${fileDate}.xlsx`;
    const targetPath = path.join(outputDir, filename);
    writeQuotaWorkbook(targetPath, quota.availableInvoiceQuota, quota.totalInvoiceQuota, overwrite);

    return [{
      status: 'created',
      subjectName: subject.subjectName,
      taxpayerId: subject.taxpayerId,
      availableInvoiceQuota: quota.availableInvoiceQuota,
      totalInvoiceQuota: quota.totalInvoiceQuota,
      filename,
      filePath: targetPath,
      sheetName: SHEET_NAME,
      url: quota.url,
    }];
  },
});
