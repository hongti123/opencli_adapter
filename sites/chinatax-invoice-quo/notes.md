## 2026-08-20 by Codex

Implemented `chinatax-invoice-quo/download` with `Strategy.UI` and a persistent browser session.

- The subject name is the visible `div[title]` in the portal card whose nearby ancestor contains a 15–20 character taxpayer ID.
- The quota overview is the visible `.section-wrap` containing `开票情况概览`; the adapter scrolls it into view before reading the panel.
- Available quota is `.g-data-display-content` under the panel whose header is exactly `可用发票额度（元）`; total quota is the footer label beginning `发票总额度：`.
- The underlying quota request uses dynamic security parameters, so the adapter deliberately follows the visible UI contract rather than replaying an internal API.
- No authenticated raw response was saved because it contains private taxpayer data; the redacted fixture records only selector and type shape.
