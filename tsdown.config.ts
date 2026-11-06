import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-connect-miaoshou'

/**
 * 浏览器半边**不能**打包进去的模块。
 *
 * shell 在自己的 `__ModuleLoader__` 里注册了这些，所以把它们外部化就是让每个
 * import 变成页面自己解析的 `require`。
 *
 * `react-dom` / `react-dom/client` 与 react 同理，而且理由是一次真实的线上故障
 * 而不是风格选择：打包任何一个都会内联它的 CJS 构建，而每个这样的构建开头都是
 *
 *   if (process.env.NODE_ENV !== "production") …
 *
 * 在浏览器里抛 `ReferenceError: process is not defined` —— 发生在模块求值时，
 * 于是**整个** client 半边导入失败，shell 报 `web boot: 1 entry did not activate`。
 *
 * 下面的 `@deepseek-ai/dsh-client-*` 在本包里是 TYPE-ONLY import，构建时会被擦除，
 * 不会产生 `require`。列出来是为了把意图写明，也让回归测试能看见将来若有人改成
 * 值导入会被抓住。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-renderer/client',
] as const

/**
 * 两个构建目标，因为插件交付两半、模块系统**不同**：
 *
 *  - `index`（esm，platform node）是 provider：shim、adapter、路由。由宿主进程
 *    通过 Node 的 ESM loader 加载。
 *  - `client`（cjs，platform browser）是设置卡。由 shell 用自己的
 *    `__ModuleLoader__` 以 `<script>` 加载。
 *
 * client 半边**必须**是 CommonJS。shell 不会给插件的 client 入口加
 * `type="module"`，ESM 包会在求值时就抛：
 *
 *   Uncaught SyntaxError: Cannot use import statement outside a module
 *     at dsh-app://app/plugins/dsh-connect-miaoshou/client.js:1
 *
 * 这会让该条目失败并拖垮整个 web boot（`web boot: 1 entry did not activate`）。
 * 下面的 banner/footer/intro 三件套是那个契约的另一半：把 CJS 主体包进 shell 的
 * `__ModuleLoader__.load({ factory })` 调用，并定义浏览器本来没有的
 * `module`/`exports` 绑定。
 *
 * peer 依赖永远不打包 —— 运行时从 Harness 解析。
 */
export default [
  {
    entry: {
      index: 'src/index.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        // 设置 schema 在模块加载时用 schemastery 构建，所以**必须**是宿主那一份：
        // 两份会让 Loader 的 `.validate()` 落在另一个 schema 对象上。
        '@deepseek-ai/schemastery',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    // CJS，不是 ESM —— 见上面的模块说明。这一个词决定了「卡片能渲染」还是
    // 「桌面 GUI 起不来」。
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    // `clean` 关掉：上面的 node 构建拥有 lib/，两者顺序执行。
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      // 不加 hash：shell 按字面量 `plugins/<id>/client.js` 解析 client 入口。
      entryFileNames: 'client.js',
      // 把 CJS 主体包进 shell 期待的 loader 调用…
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      // …再把 exports 从 factory 交出去。
      footer: 'return module.exports; } });',
      // 浏览器没有 `module`/`exports`；在 factory 内部定义它们。
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
