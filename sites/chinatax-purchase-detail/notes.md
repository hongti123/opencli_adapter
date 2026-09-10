## 2026-08-20 by Codex — query completeness alignment

- Purchase-detail now submits the query three times, waits a fixed 10 seconds after each submission, and reads the visible pagination total after every wait.
- All three counts must be readable non-negative integers and identical. Unreadable or inconsistent counts raise `CommandExecutionError` with all three readings.
- A stable positive count follows `导出` → `导出全部`; a stable zero count returns the operational `no_data` result.
- TDesign date inputs must be opened and selected with DOM component `click()` calls. After selection, the adapter verifies the value and actively closes any remaining picker popup before querying.

## 2026-08-20 by Codex

- Verified the portal subject name against the nearest visible container containing a taxpayer identifier.
- On the purchase-detail page, both invoice-date controls use `placeholder=请选择`; locate them through the exact labels `开票日期（起）` and `开票日期（止）` and their nearest `.t-form__item`.
- The result contract is a visible invoice table plus `共 N 条`; the only visible exact-text `导出` button is the export action.
- The default date is the previous local calendar day. The 2026-08-19 verification returned a legitimate zero-row result.
