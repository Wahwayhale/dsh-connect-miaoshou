# 发布检查清单 · dsh-connect-miaoshou

> 面向人。按顺序执行，每一步都给了**预期输出**，方便你比对。

## 0. 先跑这个

```powershell
cd E:\project\妙手\dsh-connect-miaoshou
node scripts\publish-checklist.mjs
```

**看到 `READY TO SUBMIT` 才继续。** 它只做本地只读检查，不会 commit / push / publish。

---

## 1. 确认暂存清单干净

```powershell
git status --short
```

预期：只有源码与资产（`src/`、`docs/assets/*.png`、`README*.md`、`CHANGELOG.md`、`scripts/`、
`awesome-dsh-plugin-submission/`），且**没有** `lib/`、`node_modules/`、`*.log`、`*.tgz`、`pub.log`
（已被 `.gitignore` 挡掉）。

## 2. 提交

```powershell
git add -A
git commit -m "Release 0.1.0: marketplace submission assets"
```

## 3. 再跑一次闸门

```powershell
node scripts\publish-checklist.mjs
```

这次应输出 **`ALL PASS` + `READY TO SUBMIT`**。

## 4. 推送 GitHub

```powershell
git push origin main
```

## 5. topic（市场硬性要求 R6）

GitHub 仓库页面右侧 → **Topics** → 必须有 `dsh-plugin`。（本仓库已打，无需重复。）

## 6. 打 tag

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## 7. 发布 npm

```powershell
npm publish --access public --registry=https://registry.npmjs.org/
```

⚠️ 默认 registry 是 npmmirror 镜像，**必须**显式指定 `--registry`，否则只会传到镜像。
⚠️ 账号开了 2FA（`EOTP`）时，跟上 `--otp=<6 位码>`，或先 `npm login --auth-type=web`。

## 8. 提 PR 到市场

```powershell
git clone https://github.com/Wahwayhale/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-connect-miaoshou

mkdir data\plugins -Force
copy E:\project\妙手\dsh-connect-miaoshou\awesome-dsh-plugin-submission\Wahwayhale__dsh-connect-miaoshou.yml `
      data\plugins\Wahwayhale__dsh-connect-miaoshou.yml

git add data\plugins\Wahwayhale__dsh-connect-miaoshou.yml
git commit -m "Add dsh-connect-miaoshou"
git push origin add-dsh-connect-miaoshou
```

然后浏览器打开 fork → **Compare & pull request** → 提到上游。

**24 小时年龄门**：本仓库 2026-11-06 17:35（北京时间）建仓，已满足，可以直接提。

## 9. 上架后核对

```powershell
curl -s -o NUL -w "%{http_code}\n" https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/plugins/Wahwayhale__dsh-connect-miaoshou.yml
```

预期 `200`。随后市场页 `https://awesome-dsh-plugin.com/p/Wahwayhale/dsh-connect-miaoshou/` 可访问。

---

## PR CI 失败时改什么

| 失败步骤 | 报错关键词 | 改什么 |
| --- | --- | --- |
| ① 条数 | `too many entries` | 一个 PR 最多 3 条，确认只提交了 1 个文件 |
| ② manifest | `dsh.bundle` not declared | `package.json` 的 `dsh.bundle.patch` 必须在，且仓库根有 `cordis.patch.yml` —— 都有，**别动** |
| ③ 仓库年龄 | `repository is too new` | 不是配置问题，等满 1 天再重跑 CI |
| ④ lint / 构建 | `awesome-lint` / 站点构建失败 | 看行号；常见是分隔符（必须是 `__`）或双语缺一侧 |

**修复方式**：在同一分支改完 `git push`，CI 自动重跑 —— **不需要重开 PR**。

---

## 万一要退回

| 想退回什么 | 怎么做 |
| --- | --- |
| 撤回未 push 的 commit | `git reset --soft HEAD~1`，文件回到暂存区 |
| 退回暂存 | `git reset`（改动保留） |
| 退回文件内容 | `git checkout -- <文件>`（⚠️ 丢弃本地改动） |
| 关闭 PR | GitHub PR 页面 → Close |

---

## 关键信息速查

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/Wahwayhale/dsh-connect-miaoshou` |
| npm 包 | `dsh-connect-miaoshou` |
| 投稿路径 | `data/plugins/Wahwayhale__dsh-connect-miaoshou.yml`（**双下划线**） |
| 分类 | `model` |
| 必需 topic | `dsh-plugin` |
| 许可证 | MIT，`Copyright (c) 2026 Wahwayhale` |
