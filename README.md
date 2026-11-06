# dsh-connect-miaoshou

把本机已登录的**妙手（美团 CatPaw / catpaw-moon）**桌面客户端接入 DeepSeek Harness。

它复用妙手自己的 passport 登录态（默认读 `~/.meituan-catpaw/auth.json`，
也可以在设置卡里扫码登录一次、完全不依赖客户端），
走 `nocode.cn` 的 chat → agent-stream → SSE 三段链路，把远端 headless agent
的逐字输出翻译成 OpenAI 兼容的流式响应；另附一块只读的积分/套餐/模型清单卡片。

## 它提供什么

- **模型 provider**：`miaoshou`，**12 个模型，与妙手 App 的模型选择器逐条对齐**
  （Auto / LongCat-2.5 / LongCat-2.0 / GLM-5.3-FlashX / GLM-5.3-Flash / GLM-5.3 /
  DeepSeek-V4.1-Flash / DeepSeek-V4-Pro / MiniMax-M3.1-Flash / MiniMax-M3 /
  Kimi-K3.1-Pro / Kimi-K3）。展示名与 App 一致，调用名按厂商口径转换，12 条全部实测可调通。
- **设置页「妙手」卡片**：可用积分、套餐到期与下次发放倒计时、账号状态、
  模型勾选（决定哪些模型出现在 DSH 的模型选择器里）、上游地址覆盖。
- **诊断**：目录条数与来源、当前上游地址、凭据读取状态。

## 已知限制

- **只支持文本**：妙手的图片走 `create` 的 `images` 字段，这条链路没打通，
  所以所有模型都只声明 `text` 模态 —— 模型选择器不会让你附图，而不是附了图
  却让模型看不见。
- **首字延迟约 8～12 秒**：上游把整段文本一次性发出（不是逐字增量），
  插件侧无法改变，表现为「等一会儿然后整段弹出」。
- **用量恒为 0**：妙手按积分计费，不返回 token 用量。每轮的积分消耗放在
  OpenAI 响应的 `miaoshou.creditCost` 自定义字段里。
- **模型可能带 agent 口癖**：上游会在部分请求里注入「这是一个知识性问题…」
  之类的开场，`isAgent:false` 也不能完全消除。

## 它不做什么

- 不执行妙手远端的工具（那是远端 headless agent 自己的事），
  所以 `isAgent` 固定为 `false`，拿回来的就是干净文本。
- 登录可选：客户端已登录时直接复用它的令牌；没装客户端也能在卡片里扫码登录一次。
- 浏览器侧永不接触令牌：所有路由只返回数字视图。

## 凭据来源

三个来源，按优先级：

### 1. 扫码登录（推荐，完全不依赖妙手客户端）

设置卡「账号状态」段点「扫码登录」→ 拿到链接 → 浏览器里扫码确认 → 令牌自动落盘。
拿到的是妙手自己的 passport 令牌（152 字符），与客户端 `auth.json` 里的
`auth.accessToken` **逐字节相同**，四套鉴权头全通。

链路（`src/miaoshou-passport.ts`，全部实测）：

```
GET  https://catx.nocode.cn/api/gateway/passport/login-config        ← 不需要鉴权头
  →  {data:{loginEntryUrl:"https://catpaw.meituan.com/api/gateway/passport/login-entry"}}

GET  {loginEntryUrl}?state=<hex>&redirect=<url>&sid=<hex>            ← 妙手扫码登录页
GET  https://catx.nocode.cn/api/gateway/passport/poll-token?sid=<sid> ← 每秒轮询，data 就是令牌
```

令牌落盘在 `~/.dsh/dsh-connect-miaoshou.token.json`（0600），下次启动直接用。
passport **没有 refresh_token**（客户端 `capabilities.canRefresh === false`），过期只能重扫。

### 2. 妙手客户端的登录态文件（兜底）

```
~/.meituan-catpaw/auth.json   →   auth.accessToken
```

可以用环境变量 `MIAOSHOU_HOME` 指向别的目录。令牌是 raw 值，不带 `Bearer`。

### 3. `ep` CLI —— 仅企业版

`ep` 是美团**商家**账号体系（`epassport.meituan.com/portal/login` 是商家中心扫码页），
与 CatPaw 账号不是同一套；实测 `ep login auth-link` 给出的是「经营宝」下载页，
`ep account --json` 始终 `not_logged_in`。个人版请用第 1 条。

`src/miaoshou-ep.ts` 仍保留（企业版 `EnterpriseEpAccountService` 用
`/api/v1/passport/ep/tokens`），但卡片上不再作为主路径。

> Windows 坑（仅 ep 路径）：ep 会把 cliguard 签名器解压到 `%TMP%` 再 fork。实测
> `C:\` 下的目录解压后 exe 直接消失，报
> `fork/exec …cliguard-cli-windows-amd64.exe: The system cannot find the path specified`；
> `E:\` 下正常。插件按 `MIAOSHOU_EP_SCRATCH` → 工作目录 `.miaoshou-ep` →
> `~/.dsh/dsh-connect-miaoshou-ep` → 系统临时目录的顺序试，第一个成功的记住。

两条链路用的是**两套**鉴权头，混用会 401：

| 用途 | 域名 | 头 |
| --- | --- | --- |
| 对话（create / agent-stream / SSE） | `nocode.cn` | `access-token` + `client-id: catdesk`，SSE 另加 `X-Passport-Token` + `Cookie` |
| 积分、账号 | `catx.nocode.cn` | `X-Auth-Token` |
| 模型目录 + 倍率 | `catpaw-agent.meituan.com` | `X-Passport-Token` |

模型目录**只**读 `catpaw-agent.meituan.com/api/agent/maas/model-types`
（`POST`，body `{"tenant":"CatDesk","scene":"CATX_APP","env":"EXTERNAL"}`），
因为那才是 App 模型选择器的数据源，也唯一带 `extendedInfo.rateMultiplier`
（积分消耗倍率）与 `marketingCopy`（「限时免费」）。`catx.nocode.cn` 的
`/api/gateway/v1/model/providers` 是另一套 slug 命名（`glm-5.1`、`kimi-k2.6`、
`deepseek-v4-flash` …），App 里看不到，所以**不混进目录**。

调用名与展示名的差异（实测规律，按厂商分）：

| 厂商 | 口径 | 例 |
| --- | --- | --- |
| GLM / DeepSeek / Kimi / Auto | 展示名小写化 | `GLM-5.3-FlashX` → `glm-5.3-flashx` |
| LongCat / MiniMax | 展示名原样（小写会失败） | `MiniMax-M3.1-Flash` → `MiniMax-M3.1-Flash` |

## 思考等级

DSH 的思考档位会翻译成妙手 agent-stream body 顶层的
`modelParams.declarativeParams`，只有上游真实接受的档位才会出现在选择器里：

| DSH 档位 | 发往上游 |
| --- | --- |
| Off | `{"thinking":"false"}` |
| Low / Medium / High / Xhigh / Max | `{"thinking":"true","effort":"<同名档位>"}` |
| 该模型没有 thinking 参数（GLM 三兄弟、MiniMax-M3.1-Flash） | 不发 `thinking`，只发 `effort` |
| 该模型没有 effort 参数（LongCat-2.0/2.5、MiniMax-M3） | `High` 代表「开思考」→ `{"thinking":"true"}` |

上游对 `effort` 有 enum 校验（非法值整轮一帧不出），所以未支持的档位一律不暴露；
`Auto` 没有任何参数，选择器里只有 Off。

## 开发

```bash
npm run build      # tsdown：lib/index.js (ESM) + lib/client.js (CJS)
npm run typecheck  # tsc 两套 tsconfig
```

`lib/client.js` **必须是 CJS**：宿主不给插件 client 入口加 `type="module"`，
ESM 会报 `Cannot use import statement outside a module` 并让整个 web 入口不激活。

## 安装

```bash
dsh plugin install <本目录绝对路径>
```
