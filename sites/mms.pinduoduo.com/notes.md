# mms.pinduoduo.com 拼多多商家后台 导航笔记（更新于 2026-09-08）

## 关键入口
- 商家后台登录页：https://mms.pinduoduo.com/login/
- 聊天记录查询页：https://mms.pinduoduo.com/mms-chat/search?msfrom=mms_sidenav
  （未登录访问会自动跳 /login/?redirectUrl=...，登录后回跳）

## 登录页实测结构（2026-09-08 真实浏览器勘察）
- 登录表单为**直接 DOM，无 iframe**；
- 输入框：账号 = placeholder「请输入账号名/手机号」；密码 = type=password，placeholder「请输入密码」；
- Tab：默认「扫码登录」，需切到「账号登录」才能用账号密码；
- 提交按钮文案：「登录」；
- 登录后仍可能弹短信/滑块验证 → 项目内一律人工处理，不绕过。

## 聊天记录查询页
- 结构待首次登录后回填（用项目 --probe 勘察后更新本笔记）。

## 坑
- 本机浏览器（9222 调试口）当前未登录拼多多商家后台；
- pdd-chat-crawler 项目代码在本机运行时需 `pip install -r requirements.txt`
  且 `python -m playwright install chromium`（平台内置 Python 不含 playwright/httpx/yaml）。
