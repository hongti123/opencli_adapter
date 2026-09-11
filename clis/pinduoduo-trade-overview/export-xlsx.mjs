/**
 * pinduoduo-trade-overview / export-xlsx.mjs
 *
 * 由 download.js 通过 stdin 传入 JSON，生成带样式的 xlsx：
 *   sheet1 「交易概览」：指定日期的成交金额 / 退款金额等核心指标
 *   sheet2 「日明细」：接口返回的日维度序列
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const outputPath = path.resolve(String(process.argv[2] || '').trim());
if (!process.argv[2]) throw new Error('Usage: export-xlsx.mjs <output.xlsx>');

let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input || '{}');

const target = payload.target || {};
const daily = Array.isArray(payload.daily) ? payload.daily : [];

const money = (value) => (typeof value === 'number' ? value : null);

const summaryRows = [
  ['店铺名称', payload.storeName || ''],
  ['统计日期', target.date || payload.endDate || ''],
  ['成交金额(元)', money(target.gmv)],
  ['退款金额(元)', money(target.refundAmount)],
  ['成交订单数', money(target.orderCount)],
  ['成交买家数', money(target.buyerCount)],
  ['客单价(元)', money(target.aup)],
  ['退款单数', money(target.refundOrderCount)],
];

const dailyHeaders = ['日期', '成交金额(元)', '退款金额(元)', '成交订单数', '成交买家数', '客单价(元)', '退款单数'];
const dailyValues = daily.map((row) => [
  row.date || '',
  money(row.gmv),
  money(row.refundAmount),
  money(row.orderCount),
  money(row.buyerCount),
  money(row.aup),
  money(row.refundOrderCount),
]);

const workbook = Workbook.create();

const summary = workbook.worksheets.add('交易概览');
summary.showGridLines = false;
summary.getRange('A1:B1').values = [['指标', '数值']];
summary.getRange(`A2:B${summaryRows.length + 1}`).values = summaryRows;
summary.getRange('A1:B1').format = {
  fill: '#1F4E78',
  font: { bold: true, color: '#FFFFFF', size: 11 },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  rowHeight: 26,
};
summary.getRange(`A2:A${summaryRows.length + 1}`).format = { font: { bold: true } };
summary.getRange('B3:B4').format.numberFormat = '#,##0.00';
summary.getRange('B7:B7').format.numberFormat = '#,##0.00';
summary.getRangeByIndexes(0, 0, summaryRows.length + 1, 1).format.columnWidth = 18;
summary.getRangeByIndexes(0, 1, summaryRows.length + 1, 1).format.columnWidth = 26;
const metaRow = summaryRows.length + 3;
summary.getRange(`A${metaRow}`).values = [['取数来源', `${payload.sourceUrl || ''}（交易数据→交易概况日维度接口）`]];
summary.getRange(`A${metaRow + 1}`).values = [['取数时间', payload.fetchedAt || '']];

const detail = workbook.worksheets.add('日明细');
const hasNoteRow = Boolean(payload.rangeNote);
const offset = hasNoteRow ? 1 : 0;
if (hasNoteRow) {
  detail.getRange('A1:G1').merge();
  detail.getRange('A1').values = [[payload.rangeNote]];
  detail.getRange('A1').format = { font: { color: '#B45309' } };
}
const headerRow = 1 + offset;
const firstDataRow = headerRow + 1;
const lastDataRow = Math.max(headerRow, firstDataRow + dailyValues.length - 1);
detail.showGridLines = false;
detail.getRange(`A${headerRow}:G${headerRow}`).values = [dailyHeaders];
detail.getRange(`A${headerRow}:G${headerRow}`).format = {
  fill: '#1F4E78',
  font: { bold: true, color: '#FFFFFF', size: 11 },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  rowHeight: 26,
};
if (dailyValues.length) {
  detail.getRange(`A${firstDataRow}:G${lastDataRow}`).values = dailyValues;
  detail.getRange(`A${firstDataRow}:G${lastDataRow}`).format = { verticalAlignment: 'center' };
  detail.getRange(`B${firstDataRow}:C${lastDataRow}`).format.numberFormat = '#,##0.00';
  detail.getRange(`F${firstDataRow}:F${lastDataRow}`).format.numberFormat = '#,##0.00';
}
detail.freezePanes.freezeRows(headerRow);
const detailWidths = [13, 15, 15, 12, 12, 12, 11];
for (let column = 0; column < detailWidths.length; column += 1) {
  detail.getRangeByIndexes(0, column, Math.max(lastDataRow, 1), 1).format.columnWidth = detailWidths[column];
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
process.stdout.write(JSON.stringify({ rows: dailyValues.length, sheetCount: 2 }));
