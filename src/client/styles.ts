/**
 * 卡片样式，以单个 scoped 样式表字符串交付。
 *
 * 用字符串而不是 `import './x.css'`：浏览器 bundle 是运行时注入宿主页面的，
 * CSS import 需要一个 client 构建故意不装的打包插件；挂载时插一个 `<style>`
 * 让卡片自包含。
 *
 * 每个选择器都在 `msq-` 命名空间下，碰不到宿主元素；颜色全部写死而不用宿主
 * token —— 继承宿主主题变量的卡片，在宿主改一次变量名后就会读不清。
 *
 * @module dsh-connect-miaoshou/client-styles
 */
export const MIAOSHOU_CARD_CSS = `
.msq-card { display: flex; flex-direction: column; gap: 16px; padding: 16px 18px;
  border: 1px solid #262b33; border-radius: 14px; color: #e8eaed;
  background:
    radial-gradient(120% 150% at 0% 0%, rgba(255, 138, 76, .12), transparent 58%),
    linear-gradient(180deg, #191c22 0%, #14161b 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .04), 0 12px 30px -14px rgba(0, 0, 0, .8);
  font-size: 13px; line-height: 1.55; font-variant-numeric: tabular-nums; }

.msq-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.msq-title { font-weight: 600; font-size: 15px; letter-spacing: .01em; }
.msq-sub { color: #9aa0a6; font-size: 12px; }

.msq-section { display: flex; flex-direction: column; gap: 10px; }
.msq-section + .msq-section { padding-top: 16px; border-top: 1px solid #21252c; }
.msq-section-title { font-weight: 600; font-size: 12px; letter-spacing: .05em;
  color: #b6bdc7; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.msq-count { color: #d4b2a0; font-size: 11px; font-weight: 500; letter-spacing: 0;
  background: #1e242c; border: 1px solid #2b323c; border-radius: 999px; padding: 1px 8px; }
.msq-note { color: #9aa0a6; font-size: 12px; }

.msq-row { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  background: #13161b; border: 1px solid #20242b; border-radius: 10px;
  transition: border-color .15s ease, background .15s ease; }
.msq-row:hover { border-color: #2c333d; background: #151920; }
.msq-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.msq-label { font-weight: 500; font-size: 12.5px; color: #dfe3e8; }
.msq-figure { font-size: 20px; font-weight: 600; color: #eef2f7; white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.msq-figure-sub { color: #9aa0a6; font-size: 12px; font-weight: 400; }
.msq-row-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.msq-meta { color: #9aa0a6; font-size: 11.5px; white-space: nowrap; }

.msq-state { display: flex; align-items: center; gap: 8px; }
.msq-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; background: #ff8a4c;
  box-shadow: 0 0 0 3px rgba(255, 138, 76, .18); }
.msq-dot.msq-warn { background: #f5a623; box-shadow: 0 0 0 3px rgba(245, 166, 35, .18); }
.msq-dot.msq-bad { background: #e5534b; box-shadow: 0 0 0 3px rgba(229, 83, 75, .2); }
.msq-state-text { color: #e8eaed; }

.msq-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.msq-btn { appearance: none; border: 1px solid #333a44; background: #20242b; color: #e8eaed;
  border-radius: 8px; padding: 6px 11px; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background .15s ease, border-color .15s ease, transform .06s ease; }
.msq-btn:hover:not(:disabled) { background: #272d36; border-color: #3f4956; }
.msq-btn:active:not(:disabled) { transform: translateY(1px); }
.msq-btn:focus-visible { outline: 2px solid #ff8a4c; outline-offset: 2px; }
.msq-btn:disabled { opacity: .45; cursor: not-allowed; }
.msq-btn.msq-primary { border-color: #ea580c; background: #c2410c; color: #fff; }
.msq-btn.msq-primary:hover:not(:disabled) { background: #dc4f0d; border-color: #fb923c; }
.msq-btn.msq-dirty { border-color: #f5a623; background: #3a2c15; color: #ffd79a; }
.msq-dirty-flag { color: #f5a623; font-size: 12px; }

.msq-models { display: flex; flex-direction: column; gap: 6px; max-height: 380px; overflow: auto; }
.msq-model { display: flex; align-items: flex-start; gap: 9px; padding: 7px 10px; cursor: pointer;
  border: 1px solid #20242b; border-radius: 8px; background: #13161b;
  transition: background .15s ease, border-color .15s ease; }
.msq-model:hover { background: #161a20; border-color: #2b323c; }
.msq-model input[type=checkbox] { margin: 2px 0 0; flex: none; accent-color: #ff8a4c; }
.msq-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.msq-model-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.msq-badge { font-size: 11px; color: #9fb2c8; background: #1e242c; border: 1px solid #2f3641;
  border-radius: 999px; padding: 0 7px; }
.msq-badge.msq-rate { color: #ffc48c; background: #2a1d13; border-color: #4a3220; font-variant-numeric: tabular-nums; }
.msq-badge.msq-rate-free { color: #8ee7a8; background: #13251a; border-color: #245c34; }
.msq-model-desc { color: #9aa0a6; font-size: 11px; }
.msq-saved { color: #7fd18a; font-size: 12px; }
.msq-error { color: #ff9d99; font-size: 12px; }
.msq-input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 6px 9px;
  font: inherit; font-size: 12px; color: #e6e9ee; background: #10131a;
  border: 1px solid #2b323c; border-radius: 8px; outline: none;
  transition: border-color .15s ease; }
.msq-input:focus { border-color: #ff8a4c; }
.msq-input:disabled { color: #6b7280; cursor: not-allowed; }
.msq-diag { color: #8b929b; font-size: 11.5px; word-break: break-all; }

@media (prefers-reduced-motion: reduce) {
  .msq-btn, .msq-row, .msq-model { transition: none; }
}
`
