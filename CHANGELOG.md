# Changelog

本文件记录 dsh-connect-miaoshou 的版本变更。格式参照 Keep a Changelog，版本号遵循语义化版本。

## [0.1.0] - 2026-11-07

首个公开版本。

### 新增

- **模型 provider `miaoshou`**：把本机已登录的妙手（美团 CatPaw）桌面客户端接入 DeepSeek Harness。
  12 个模型与 App 内模型选择器逐条对齐 —— Auto / LongCat-2.5 / LongCat-2.0 /
  GLM-5.3-FlashX / GLM-5.3-Flash / GLM-5.3 / DeepSeek-V4.1-Flash / DeepSeek-V4-Pro /
  MiniMax-M3.1-Flash / MiniMax-M3 / Kimi-K3.1-Pro / Kimi-K3，12 条全部实测可调通。
- **展示名与调用名的厂商口径转换**：GLM / DeepSeek / Kimi / Auto 展示名小写化；
  LongCat / MiniMax 保持原样（小写会被上游拒绝）。
- **思考等级翻译**：DSH 的 Off / Low / Medium / High / Xhigh / Max 映射成上游
  `modelParams.declarativeParams`；模型没有对应参数时不发该字段，而不是发一个非法值让整轮一帧不出。
- **设置页「妙手」卡片**：可用积分、套餐到期与下次发放倒计时、账号状态、
  模型勾选（决定哪些模型出现在 DSH 的模型选择器里）、上游地址覆盖、目录诊断
  （条数与来源、凭据读取状态）。
- **扫码登录**：走 passport login-entry + poll-token 链路，令牌落盘
  `~/.dsh/dsh-connect-miaoshou.token.json`（0600），妙手客户端不必常驻运行；
  客户端已登录时也可直接复用 `~/.meituan-catpaw/auth.json`（环境变量 `MIAOSHOU_HOME` 可改目录）。
- **积分看板**：只读，显示「还剩多少」而不是「已用多少」，含每个模型的积分消耗倍率与限时免费标记。

### 已知限制

- **只支持文本**：妙手的图片走 `create` 的 `images` 字段，该链路未打通，
  所有模型只声明 `text` 模态 —— 模型选择器不会让你附图，而不是附了图却让模型看不见。
- **首字延迟约 8～12 秒**：上游把整段文本一次性发出（不是逐字增量），插件侧无法改变。
- **用量恒为 0**：妙手按积分计费，不返回 token 用量；每轮的积分消耗放在
  OpenAI 响应的 `miaoshou.creditCost` 自定义字段里。
- **模型可能带 agent 口癖**：上游在部分请求里注入开场白，`isAgent:false` 不能完全消除。
- **passport 没有 refresh_token**（客户端 `capabilities.canRefresh === false`），过期只能重扫。
- **企业版 `ep` 链路保留但非主路径**：`ep` 是美团商家账号体系，与 CatPaw 个人账号不是一套。

### 安全

- 浏览器侧永不接触令牌：所有 HTTP 路由只返回数字视图，令牌只在宿主进程内使用。
