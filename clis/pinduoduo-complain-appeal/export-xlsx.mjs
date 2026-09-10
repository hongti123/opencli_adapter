import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const outputPath = path.resolve(String(process.argv[2] || '').trim());
if (!process.argv[2]) throw new Error('Usage: export-xlsx.mjs <output.xlsx>');

let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input || '{}');
const rows = Array.isArray(payload.rows) ? payload.rows : [];

const headers = [
  '订单编号',
  '商品标题',
  '商品ID',
  '问题类型',
  '补偿金额',
  '扣款进度',
  '创建时间',
  '处理状态',
  '补偿原因',
  '补偿依据',
  '相关订单',
];

function excelDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
    parsed.getMilliseconds(),
  );
}

const values = rows.map((row) => [
  row.orderSn ?? null,
  row.goodsTitle ?? null,
  row.goodsId ?? null,
  row.issueType ?? null,
  row.compensationAmount ?? null,
  row.deductionProgress ?? null,
  excelDate(row.createdTime),
  row.processingStatus ?? null,
  row.compensationReason ?? null,
  row.compensationBasis ?? null,
  row.relatedOrder ?? null,
]);

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('申诉明细');
sheet.showGridLines = false;
sheet.freezePanes.freezeRows(1);
sheet.getRange('A1:K1').values = [headers];
if (values.length) sheet.getRangeByIndexes(1, 0, values.length, headers.length).values = values;

const lastRow = Math.max(1, values.length + 1);
const usedRange = sheet.getRange(`A1:K${lastRow}`);
const headerRange = sheet.getRange('A1:K1');
headerRange.format = {
  fill: '#1F4E78',
  font: { bold: true, color: '#FFFFFF', size: 11 },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  rowHeight: 28,
};

if (values.length) {
  const dataRange = sheet.getRange(`A2:K${lastRow}`);
  dataRange.format = {
    font: { color: '#1F2937', size: 10 },
    verticalAlignment: 'center',
    rowHeight: 54,
  };
  sheet.getRange(`A2:A${lastRow}`).format.numberFormat = '@';
  sheet.getRange(`C2:C${lastRow}`).format.numberFormat = '@';
  sheet.getRange(`E2:E${lastRow}`).format.numberFormat = '¥#,##0.00';
  sheet.getRange(`E2:E${lastRow}`).format.horizontalAlignment = 'right';
  sheet.getRange(`G2:G${lastRow}`).format.numberFormat = 'yyyy-mm-dd hh:mm:ss';
  sheet.getRange(`G2:G${lastRow}`).format.horizontalAlignment = 'center';
  sheet.getRange(`B2:B${lastRow}`).format.wrapText = true;
  sheet.getRange(`I2:J${lastRow}`).format.wrapText = true;
  const table = sheet.tables.add(`A1:K${lastRow}`, true, 'AppealDetailsTable');
  table.style = 'TableStyleMedium2';
  table.showFilterButton = true;
}

const widths = [24, 42, 18, 14, 12, 14, 21, 16, 48, 48, 24];
for (let column = 0; column < widths.length; column += 1) {
  sheet.getRangeByIndexes(0, column, lastRow, 1).format.columnWidth = widths[column];
}

let inspectSummary = null;
let formulaErrorSummary = null;
if (process.env.PINDUODUO_COMPLAIN_APPEAL_VERIFY === '1') {
  const inspected = await workbook.inspect({
    kind: 'table',
    range: `申诉明细!A1:K${Math.min(lastRow, 8)}`,
    include: 'values,formulas',
    tableMaxRows: 8,
    tableMaxCols: 11,
    maxChars: 4000,
  });
  const formulaErrors = await workbook.inspect({
    kind: 'match',
    searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
    options: { useRegex: true, maxResults: 100 },
    summary: 'formula error scan',
    maxChars: 2000,
  });
  inspectSummary = inspected.ndjson;
  formulaErrorSummary = formulaErrors.ndjson;
}
if (process.env.PINDUODUO_COMPLAIN_APPEAL_PREVIEW_PATH) {
  const preview = await workbook.render({
    sheetName: '申诉明细',
    autoCrop: 'all',
    scale: 1,
    format: 'png',
  });
  await fs.writeFile(
    process.env.PINDUODUO_COMPLAIN_APPEAL_PREVIEW_PATH,
    new Uint8Array(await preview.arrayBuffer()),
  );
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
process.stdout.write(JSON.stringify({
  rowCount: values.length,
  sheetCount: 1,
  inspect: inspectSummary,
  formulaErrors: formulaErrorSummary,
}));
