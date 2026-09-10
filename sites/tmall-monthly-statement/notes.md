## 2026-08-27 by Codex

- Verified with OpenCLI profile `opc-pro1` on the authenticated Tmall Seller monthly-summary page.
- Stable UI anchors observed: `#billCycle`, `td[title="YYYY-MM"]`, the month-summary table's `YYYYMM` first cell, and the row-scoped `下载明细` button.
- Selecting the same month cell twice sets both month-range endpoints and closes the picker.
- The current store name is readable from the visible seller header; the adapter validates `--store-name` when provided and avoids storing credentials or account identifiers in site memory.
