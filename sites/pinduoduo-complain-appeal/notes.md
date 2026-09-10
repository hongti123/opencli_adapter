## 2026-08-26 by Codex

- 页面为 Next.js 外壳加 aftersales 微前端；`__NEXT_DATA__` 主要用于登录店铺信息，业务列表不是 SSR state。
- 列表接口为 `POST /api/colombo/tuju/appealList`，详情接口为 `POST /api/colombo/tuju/detail`。
- 页面默认最近 7 个自然日、每页 20 条、全部处理状态；适配器逐页读取并按 `ticketSn` 查询每条详情。
- “消费者补偿说明”字段按订单变化。适配器除常用字段外，始终保留完整 `list` 与 `detail` 原始对象。
- 2026-08-26 实测 43 条列表与 43 条详情，`orderSn` / `ticketSn` 对应关系无错配。
- OpenCLI 1.8.6 的 `browser verify` 对适配器子进程硬编码 30 秒超时；完整详情归档超过该时限。直接命令和 fixture 离线校验可通过，不应通过缩减数据范围来伪装完整验证。

## 2026-08-27 by Codex

- 用户将输出收紧为 11 个可见业务字段，并改为单工作表 Excel；不再保留原始列表、详情响应或元数据。
- 输出文件固定命名为 `订单申诉明细-[店铺简称]-开始日期_结束日期.xlsx`，店铺简称优先采用 `--store-short-name`。
- 问题类型必须跳过 `appealListTabs` 中覆盖所有 `ticketType` 的“全部”页签，匹配“商品问题”或“服务问题”。
- 商品标题和商品 ID 优先取列表行的 `mmsGoodsInfoVO`，详情字段作为兜底；详情仍以 `ticketSn` 请求并用订单号校验对应关系。
