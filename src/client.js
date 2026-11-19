'use strict'
const React = require('react')
const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React
// 形象只有一个替换点：HRMark 里的这个组件。构建时 src/live2d-avatar.js 会内联在本文件之前，
// 与本文件共享同一作用域，因此这里直接用它的工厂，不引入任何运行时依赖。
const Live2DAvatar = hrLive2dComponent(React)
// 右屏候选人画面同样只有一个替换点：src/candidate-camera.js 的工厂（构建时按 contract → live2d → candidate → client
// 的顺序内联，同域可见）。这里只取组件、只传 paused/active，不写任何摄像头逻辑：
// 不调 getUserMedia、不建 MediaStream、不把画面发给 Host、也不新增面试 session 或模型调用。
const CandidateCamera = hrCandidateCameraComponent(React)
const NS = 'hrInterview'
const PANEL_ID = 'hr-interview'
const inject = ['slots', 'locale', 'remote']
const en = { title: 'HR Interview' }
const zh = { title: 'HR 面试攻防' }
const dictionaries = { en, zh }
const C = { text: 'var(--dsw-alias-label-primary, inherit)', muted: 'var(--dsw-alias-label-secondary, #667085)', border: 'var(--dsw-alias-border-l1, #d0d5dd)', bg: 'var(--dsw-alias-bg-primary, Canvas)', layer: 'var(--dsw-alias-bg-layer-1, #f8fafc)', accent: 'var(--dsw-alias-label-link, #175cd3)', danger: 'var(--dsw-alias-label-error, #b42318)', success: 'var(--dsw-alias-label-success, #067647)' }
const studioCss = `
.hri-studio {
  /* 工作台三个入口共用浅色画布，局部隔离 DSH 的壁纸和主题。 */
  --dsw-alias-label-primary: #181e32;
  --dsw-alias-label-secondary: #4f5970;
  --dsw-alias-border-l1: #ccd4e3;
  --dsw-alias-bg-primary: #ffffff;
  --dsw-alias-bg-layer-1: #eef1fa;
  --dsw-alias-label-link: #413cba;
  --dsw-alias-label-error: #a32443;
  --dsw-alias-label-success: #116445;
  --hri-studio-row: #fbfcff;
  --hri-studio-selected: #ebeaff;
  --hri-studio-chip: #e8edff;
  --hri-studio-selected-border: #aeb1f0;
  display: grid; gap: 20px; width: 100%; max-width: 1320px; min-width: 0;
  margin-inline: auto; padding: clamp(14px, 2.1vw, 28px); border: 1px solid #d6deee; border-radius: 18px;
  color-scheme: light; color: ${C.text}; background: #f3f5fc; container: hri-studio / inline-size;
}
.hri-studio :is(h2, h3, strong, p, button, summary) { text-shadow: none; }
.hri-studio-head { padding-bottom: 20px; border-bottom: 1px solid ${C.border}; }
.hri-studio-head h2 { margin: 0; color: ${C.text}; font-size: clamp(27px, 4.4cqi, 43px); font-weight: 800; line-height: 1.15; }
.hri-setup-head h2 { margin-bottom: 4px; }
.hri-setup-head p, .hri-setup-note { margin: 0; color: ${C.muted}; overflow-wrap: anywhere; }
.hri-setup-role { font-size: clamp(14px, 1.85cqi, 20px); }
.hri-setup-controls button, .hri-setup-link { min-height: 40px; white-space: normal; font-weight: 600; }
.hri-setup button.hri-setup-primary { padding-inline: 16px; min-height: 44px; font-weight: 700; }
.hri-setup-status { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: 8px; color: ${C.muted}; background: ${C.layer}; font-size: 13px; font-weight: 700; }
.hri-setup-status[data-state=ready] { color: ${C.success}; background: #dff5e9; }
.hri-setup-status[data-state=stale] { color: ${C.danger}; }
.hri-setup-layout { display: grid; grid-template-columns: minmax(158px, 24%) minmax(0, 1fr); gap: 16px; }
.hri-setup-layout > .hri-card { padding: clamp(13px, 2cqi, 23px); border-radius: 13px; }
.hri-setup-layout > :only-child { grid-column: 1 / -1; }
.hri-setup-aside { display: grid; align-content: start; gap: 12px; }
.hri-setup-title { margin: 0; color: ${C.text}; font-size: clamp(18px, 2.25cqi, 25px); font-weight: 750; line-height: 1.25; }
.hri-setup-duration { color: ${C.accent}; font-size: clamp(27px, 4.4cqi, 44px); line-height: 1.15; }
.hri-setup-duration small { font-size: .56em; color: ${C.text}; }
.hri-setup-summary { display: grid; gap: 8px; min-width: 0; }
.hri-setup-summary p { margin: 0; color: ${C.muted}; font-size: 13px; }
.hri-setup-aside-actions { display: grid; gap: 4px; }
.hri-setup-interviewer { grid-column: 1 / -1; display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid ${C.border}; }
.hri-interviewer-mark { display: grid; gap: 10px; min-width: 0; }
.hri-interviewer-identity { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.hri-interviewer-mark .hri-live2d { justify-self: center; }
.hri-interviewer-mark canvas { max-width: 100%; max-height: 100%; }
.hri-interviewer-toggle { display: flex; align-items: flex-start; gap: 7px; color: ${C.muted}; font-size: 12px; line-height: 1.5; cursor: pointer; }
.hri-interviewer-toggle input { flex: 0 0 auto; margin: 2px 0 0; accent-color: ${C.accent}; }
.hri-setup-material { justify-self: start; }
.hri-setup-link:focus-visible, .hri-setup-settings > summary:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
.hri-setup-settings { grid-column: 1 / -1; min-width: 0; }
.hri-setup-settings:not([open]) { display: none; }
.hri-setup-settings > summary { cursor: pointer; font-weight: 700; padding: 3px 0; }
.hri-setup-settings-grid { margin-top: 14px; }
.hri-setup-settings-grid fieldset { min-width: 0; margin: 0; padding: 12px; border: 1px solid ${C.border}; border-radius: 10px; }
.hri-setup-settings-grid legend { padding: 0 4px; font-weight: 600; }
.hri-setup-message { margin: 8px 0 0; overflow-wrap: anywhere; font-size: 13px; }
.hri-plan-list { position: relative; display: grid; gap: 9px; padding: 0 0 0 21px; margin: 14px 0 0; list-style: none; }
.hri-plan-list::before { position: absolute; top: 22px; bottom: 32px; left: 5px; width: 1px; background: #a6b0cb; content: ''; }
.hri-plan-item { position: relative; min-width: 0; border: 1px solid ${C.border}; border-radius: 10px; background: var(--hri-studio-row); }
.hri-plan-item[hidden] { display: none; }
.hri-plan-item::before { position: absolute; left: -22px; top: 22px; width: 11px; height: 11px; border-radius: 50%; border: 1px solid #7887a8; background: ${C.bg}; content: ''; }
.hri-plan-item.is-selected { border-color: var(--hri-studio-selected-border); background: var(--hri-studio-selected); }
.hri-plan-item.is-selected::before { border-color: ${C.accent}; background: ${C.accent}; }
.hri-plan-toggle { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: start; gap: 12px; width: 100%; min-height: 58px; border: 0; padding: 10px 12px; border-radius: 9px; text-align: left; color: ${C.text}; background: transparent; cursor: pointer; }
.hri-plan-number { justify-self: stretch; border-radius: 7px; padding: 3px 2px; color: ${C.accent}; background: var(--hri-studio-chip); text-align: center; font-size: clamp(18px, 2.7cqi, 27px); line-height: 1; font-weight: 800; font-variant-numeric: tabular-nums; }
.hri-plan-copy { display: grid; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
.hri-plan-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.hri-plan-title strong { font-size: clamp(15px, 1.85cqi, 19px); line-height: 1.3; }
.hri-plan-question { font-size: 14px; line-height: 1.5; }
.hri-plan-tags { display: inline-flex; gap: 4px; flex-wrap: wrap; color: ${C.muted}; font-size: 11px; }
.hri-plan-tags span { border-radius: 5px; padding: 1px 5px; background: ${C.layer}; }
.hri-plan-tags .hri-plan-changed { color: ${C.success}; background: #dcf3e8; font-weight: 650; }
.hri-plan-refresh { display: flex; gap: 6px 12px; align-items: center; flex-wrap: wrap; }
.hri-plan-refresh .hri-setup-message { margin: 0; color: ${C.muted}; }
.hri-plan-chevron { color: ${C.accent}; line-height: 1.4; }
.hri-plan-detail { margin: 0 12px 10px 72px; padding-top: 6px; border-top: 1px solid var(--hri-studio-selected-border); color: ${C.text}; font-size: 13px; overflow-wrap: anywhere; }
.hri-plan-detail p, .hri-plan-detail ul { margin: 4px 0; }
.hri-plan-detail ul { padding-left: 18px; }
.hri-plan-alternates { position: relative; padding: 0; margin: 1px 0 0; border-top: 1px solid ${C.border}; background: ${C.bg}; }
.hri-plan-alternates button { width: 100%; min-height: 40px; }
.hri-studio-meta { margin: 0; color: ${C.muted}; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.hri-studio-title { margin: 0; color: ${C.text}; font-size: clamp(18px, 2.3cqi, 25px); font-weight: 750; line-height: 1.25; }
.hri-materials > .hri-studio-head .hri-controls { min-height: 42px; }
.hri-material-role .hri-field { max-width: 38rem; }
.hri-material-grid, .hri-records-grid { display: grid; gap: 16px; align-items: start; }
.hri-material-grid { grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr); }
.hri-records-grid { grid-template-columns: minmax(0, 1.36fr) minmax(0, 1fr); }
.hri-material-role, .hri-material-grid > .hri-card, .hri-records-grid > .hri-card { padding: clamp(14px, 2cqi, 22px); }
.hri-materials :is(label.hri-field, .hri-upload) { min-width: 0; }
.hri-materials label.hri-field { gap: 7px; }
.hri-materials label.hri-field > span { font-size: 14px; font-weight: 700; color: ${C.text}; }
.hri-materials .hri-field:last-child { margin-bottom: 0; }
.hri-materials .hri-input { background: var(--hri-studio-row); line-height: 1.55; }
.hri-materials textarea { resize: vertical; min-height: 84px; }
.hri-materials .hri-upload { margin: 0 0 15px; padding: 11px 12px; border: 1px dashed #aab5cd; border-radius: 9px; background: ${C.layer}; overflow-wrap: anywhere; }
.hri-materials input[type=file] { min-width: 0; max-width: 100%; color: ${C.muted}; font-size: 13px; }
.hri-materials input[type=file]::file-selector-button { margin-inline-end: 8px; border: 1px solid ${C.border}; border-radius: 7px; padding: 7px 10px; background: ${C.bg}; color: ${C.accent}; font: inherit; font-weight: 600; cursor: pointer; }
.hri-materials .hri-controls > button { min-height: 42px; font-weight: 700; }
.hri-materials .hri-studio-head .hri-studio-meta { margin-top: 7px; }
.hri-materials .hri-studio-head > .hri-studio-meta { overflow-wrap: anywhere; }
.hri-records-title { display: flex; align-items: baseline; gap: 8px; margin-bottom: 14px; }
.hri-records-list { display: grid; gap: 9px; }
.hri-studio .hri-history, .hri-studio .hri-knowledge { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; border: 1px solid ${C.border}; border-radius: 10px; padding: 11px 12px; background: var(--hri-studio-row); }
.hri-studio .hri-history:hover { background: ${C.layer}; border-color: var(--hri-studio-selected-border); }
.hri-record-copy { display: grid; flex: 1 1 145px; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.hri-record-copy strong { font-size: 14px; line-height: 1.4; }
.hri-record-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.hri-record-badge { display: inline-block; padding: 3px 7px; border-radius: 5px; color: ${C.muted}; background: ${C.layer}; font-size: 12px; font-weight: 650; }
.hri-record-badge[data-tone=ready] { color: ${C.success}; background: #dff5e9; }
.hri-record-badge[data-tone=due] { color: #76430b; background: #fff1d8; }
.hri-record-badge[data-tone=active] { color: ${C.accent}; background: var(--hri-studio-chip); }
.hri-record-badge[data-tone=error] { color: ${C.danger}; background: #fce7ec; }
.hri-record-chevron { color: ${C.accent}; font-size: 20px; font-weight: 700; line-height: 1; }
.hri-studio .hri-knowledge button { min-height: 38px; font-weight: 600; }
.hri-review.hri-studio { display: flex; gap: clamp(14px, 2cqi, 22px); padding: clamp(14px, 2.1vw, 28px); scrollbar-gutter: stable; }
.hri-review .hri-review-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px 20px; padding-bottom: 16px; }
.hri-review .hri-review-header h2 { font-size: clamp(26px, 3.7cqi, 39px); }
.hri-review .hri-review-header p { margin: 5px 0 0; }
.hri-review .hri-review-header button, .hri-review .hri-review-actions button { min-height: 39px; }
.hri-review-overview { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr); gap: 16px; }
.hri-review-summary { border-color: var(--hri-studio-selected-border); background: var(--hri-studio-selected); }
.hri-review-summary-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.hri-review .hri-review-score { color: ${C.accent}; font-size: clamp(30px, 4cqi, 50px); font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hri-review-score small { font-size: 14px; font-weight: 600; }
.hri-review .hri-review-summary p { margin-top: 10px; white-space: pre-wrap; }
.hri-review .hri-studio-title { margin-top: 0; font-size: clamp(17px, 2.2cqi, 23px); }
.hri-review-priorities ol { display: grid; gap: 9px; margin: 12px 0 0; padding-inline-start: 24px; line-height: 1.55; }
.hri-review-priorities li::marker { color: ${C.accent}; font-weight: 750; }
.hri-review-dimensions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 11px; margin-top: 13px; }
.hri-review-dimension { min-width: 0; padding: 13px; border: 1px solid ${C.border}; border-radius: 10px; background: var(--hri-studio-row); }
.hri-review-dimension meter { display: block; width: 100%; height: 8px; margin-top: 9px; appearance: none; }
.hri-review-dimension meter::-webkit-meter-bar { background: ${C.layer}; border: 0; border-radius: 5px; }
.hri-review-dimension meter::-webkit-meter-optimum-value { background: ${C.accent}; border-radius: 5px; }
.hri-review-dimension .hri-meta { margin: 7px 0 0; }
.hri-review-question-list { display: grid; gap: 9px; margin-top: 13px; }
.hri-review-question { min-width: 0; border: 1px solid ${C.border}; border-radius: 10px; background: var(--hri-studio-row); }
.hri-review-question > summary, .hri-review-evidence > summary { cursor: pointer; color: ${C.text}; }
.hri-review-question > summary { padding: 11px 13px; line-height: 1.55; }
.hri-review-question[open] > summary { background: ${C.layer}; border-radius: 9px 9px 0 0; }
.hri-review-question > div { display: grid; gap: 9px; padding: 11px 13px; }
.hri-review .hri-review-question h4 { margin: 0; font-size: 13px; color: ${C.muted}; }
.hri-review .hri-review-question :is(p, ul) { margin: 3px 0 0; line-height: 1.55; }
.hri-review-evidence { margin-top: 8px; }
.hri-review-evidence > summary { color: ${C.accent}; font-size: 13px; }
.hri-review blockquote { margin: 7px 0 0; padding: 7px 10px; border-inline-start: 3px solid var(--hri-studio-selected-border); background: #fff; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
.hri-review-state { display: grid; gap: 8px; padding: clamp(18px, 3cqi, 30px); }
.hri-review-state[data-tone='error'] { border-color: #ebbdc8; }
.hri-review .hri-review-state p { margin: 0; }
.hri-review .hri-review-state .hri-review-actions { margin-top: 4px; }
.hri-review-status { width: fit-content; padding: 4px 8px; border-radius: 6px; color: ${C.accent}; background: var(--hri-studio-chip); font-size: 12px; font-weight: 700; }
.hri-review-state[data-tone='error'] .hri-review-status { color: ${C.danger}; background: #fff0f4; }
.hri-review-state[data-tone='neutral'] .hri-review-status { color: ${C.muted}; background: ${C.layer}; }
.hri-view-tabs { width: min(100%, 1320px); margin-inline: auto; }
@container hri-studio (max-width: 700px) { .hri-review-overview { grid-template-columns: minmax(0, 1fr); gap: 12px; } }
.hri-session.hri-room { display: flex; gap: 12px; padding: clamp(12px, 1.8vw, 23px); }
.hri-room-scroll { flex: 1 1 auto; min-height: min(110px, 22vh); display: flex; flex-direction: column; gap: 12px; overflow-y: auto; overflow-wrap: anywhere; overscroll-behavior: contain; scrollbar-gutter: stable; }
.hri-room .hri-session-head { display: grid; gap: 12px; padding: 0; border: 0; background: none; }
.hri-room-head { flex: 0 0 auto; gap: 9px 15px; padding-bottom: 11px; border-bottom: 1px solid ${C.border}; }
.hri-room-head h2 { margin: 0; color: ${C.text}; font-size: clamp(21px, 3.1cqi, 32px); font-weight: 800; line-height: 1.2; }
.hri-room-progress { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; }
.hri-room-progress progress { width: 74px; height: 7px; accent-color: ${C.accent}; }
.hri-room-status { padding: 5px 8px; border-radius: 7px; background: var(--hri-studio-chip); color: ${C.accent}; font-size: 12px; font-weight: 700; }
.hri-room-question { flex: 0 0 auto; display: grid; gap: 7px; min-width: 0; padding: 12px 14px; border: 1px solid var(--hri-studio-selected-border); border-radius: 11px; background: var(--hri-studio-selected); }
.hri-room-question h3 { margin: 0; color: ${C.accent}; font-size: 14px; font-weight: 750; }
.hri-room-question p { margin: 0; max-height: clamp(60px, 20vh, 200px); overflow: auto; overscroll-behavior: contain; overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.6; font-size: 15px; }
.hri-room .hri-stage { height: clamp(154px, 25vh, 310px); border-radius: 11px; }
.hri-room .hri-stage-note { margin: 0; }
.hri-room .hri-candidate-camera-stage { --dsw-alias-bg-primary: #eef1fa; }
.hri-room .hri-transcript { flex: 1 0 auto; gap: 9px; padding: 13px; }
.hri-room .hri-turn { padding: 8px 11px; }
.hri-room .hri-hr { background: var(--hri-studio-row); }
.hri-room .hri-candidate { background: var(--hri-studio-chip); border-color: ${C.border}; }
.hri-room-dock { flex: 0 0 auto; display: grid; gap: 8px; padding: 10px 12px; box-shadow: 0 -7px 22px -20px #343969; }
.hri-room-dock .hri-compose { margin: 0; padding: 0; border: 0; gap: 6px; }
.hri-room-dock .hri-controls button, .hri-room-dock .hri-actions button { min-height: 36px; }
.hri-room-dock [data-hri-voice-toggle] { min-height: 40px; font-weight: 700; }
.hri-room-fallback { min-width: 0; }
.hri-room-fallback > summary { width: fit-content; cursor: pointer; padding: 3px 1px; color: ${C.muted}; font-size: 13px; }
.hri-room-fallback[open] > summary { margin-bottom: 5px; }
.hri-room-text { display: grid; gap: 5px; }
.hri-room-text textarea { resize: vertical; min-height: 56px; max-height: min(26vh, 174px); }
.hri-room-dock .hri-session-foot p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
@container hri-studio (max-width: 690px) { .hri-room .hri-stage-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; } .hri-room .hri-stage { height: clamp(145px, 23vh, 240px); } .hri-room .hri-turn { max-width: 98%; } }
@media (max-height: 640px) { .hri-room .hri-stage { height: clamp(128px, 22vh, 195px); } .hri-room-dock { padding-block: 7px; } }
@container hri-studio (max-width: 740px) {
  .hri-setup-layout, .hri-material-grid, .hri-records-grid { grid-template-columns: minmax(0, 1fr); }
  .hri-setup-aside { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
}
@container hri-studio (max-width: 470px) { .hri-setup-actions { width: 100%; } .hri-setup-controls button { max-width: 100%; } .hri-setup-aside { grid-template-columns: minmax(0, 1fr); } .hri-setup-aside-actions { grid-template-columns: repeat(2, max-content); } .hri-plan-toggle { grid-template-columns: 31px minmax(0, 1fr) auto; gap: 7px; padding-inline: 8px; } .hri-plan-detail { margin-left: 46px; } }
@container hri-studio (max-width: 290px) { .hri-setup-aside-actions { grid-template-columns: minmax(0, 1fr); justify-items: start; } }
`
const css = `.dsh-hr-interview,.dsh-hr-interview *{box-sizing:border-box}.dsh-hr-interview button,.dsh-hr-interview input,.dsh-hr-interview textarea,.dsh-hr-interview select{font:inherit}.dsh-hr-interview button:focus-visible,.dsh-hr-interview textarea:focus-visible,.dsh-hr-interview input:focus-visible,.dsh-hr-interview select:focus-visible{outline:2px solid ${C.accent};outline-offset:2px}.dsh-hr-interview{display:flex;flex-direction:column;height:100%;max-height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}.dsh-hr-interview>header{flex:0 0 auto}.hri-main{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0}.hri-main--report{overflow:hidden}.hri-view-tabs{flex:0 0 auto;padding-bottom:10px}.hri-review{display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-height:0;min-width:0;overflow-y:auto;overscroll-behavior:contain;overflow-wrap:anywhere;padding-right:2px}.hri-review>*{flex:0 0 auto;min-width:0}.hri-review h2{margin:0;font-size:20px;line-height:1.35}.hri-review h3{margin:12px 0 0;font-size:15px}.hri-review p{margin:6px 0 0;line-height:1.7}.hri-review p,.hri-review li,.hri-review small,.hri-review summary{overflow-wrap:anywhere}.hri-review-top{align-items:flex-start}.hri-review-lead{flex:1 1 240px;min-width:0}.hri-review-score{flex:0 0 auto;font-size:34px;line-height:1.1;color:${C.accent}}.hri-review-hint{color:${C.muted};margin:8px 0 0}.hri-review-error{color:${C.danger};margin:8px 0 0}.hri-review-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}.hri-session{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:14px;overflow-y:auto;overscroll-behavior:contain}.hri-session-head{flex:0 0 auto;padding:12px}.hri-transcript{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}.hri-compose{display:flex;flex-direction:column;flex:0 0 auto;margin-top:16px;border-top:1px solid ${C.border};padding-top:16px}.hri-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex:0 0 auto;padding:8px 0 0;background:${C.bg};border-top:1px solid ${C.border}}.hri-session-foot{display:flex;flex-direction:column;flex:0 0 auto;gap:6px}.hri-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.hri-tabs{display:flex;gap:6px;flex-wrap:wrap}.hri-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(min(100%,250px),.7fr);gap:16px;min-width:0}.hri-grid>*{min-width:0}.hri-card{border:1px solid ${C.border};border-radius:12px;background:${C.bg};padding:16px;min-width:0}.hri-log{display:flex;flex-direction:column;gap:8px;flex:1 0 auto;min-height:0;overflow:visible}.hri-turn{max-width:88%;padding:11px 13px;border-radius:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.hri-hr{align-self:flex-start;background:${C.layer};border:1px solid ${C.border}}.hri-candidate{align-self:flex-end;background:var(--dsw-alias-bg-accent,#eff8ff);border:1px solid ${C.accent}}.hri-meta{font-size:12px;color:${C.muted};margin-bottom:4px}.hri-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.hri-field{display:grid;gap:6px;margin-bottom:12px}.hri-field>span{font-size:13px;color:${C.muted}}.hri-input{border:1px solid ${C.border};border-radius:8px;background:${C.bg};color:${C.text};padding:9px 10px;width:100%}.hri-history{width:100%;text-align:left;border:0;border-bottom:1px solid ${C.border};background:transparent;color:${C.text};padding:12px 4px;cursor:pointer}.hri-score{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:10px;min-width:0}.hri-knowledge{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid ${C.border};padding:10px 0}.hri-live2d canvas{display:block;width:100%;height:100%}.hri-upload{display:grid;gap:5px;margin:-2px 0 12px}.hri-upload input[type=file]{max-width:100%}.hri-stage-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch;flex:0 0 auto}.hri-stage{position:relative;display:flex;height:clamp(200px,min(26vw,30vh),420px);min-height:0;border:1px solid ${C.border};border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#f8fafc);flex:none}.hri-stage-candidate{display:grid;place-items:stretch}.hri-stage-candidate .hri-candidate-camera{width:100%;height:100%;border:0;border-radius:0;background:transparent}.hri-stage-candidate video,.hri-stage-candidate canvas{display:block;width:100%;height:100%;object-fit:cover}.hri-stage-panel{position:relative;width:100%;height:100%;min-height:0}.hri-hr-stage{position:absolute;inset:0}.hri-hr-backdrop{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}.hri-hr-backdrop-img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}.hri-hr-backdrop-veil{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(15,23,42,.04),rgba(15,23,42,.52)),linear-gradient(180deg,rgba(15,23,42,.18),rgba(15,23,42,.30))}.hri-stage-label{position:absolute;top:10px;left:10px;z-index:2;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:rgba(15,23,42,.55);border:1px solid rgba(255,255,255,.18);text-shadow:0 1px 2px rgba(0,0,0,.45)}.hri-stage-badge{position:absolute;left:10px;bottom:10px;z-index:2;padding:4px 10px;border-radius:8px;font-size:12px;color:#fff;background:rgba(15,23,42,.55);border:1px solid rgba(255,255,255,.18);text-shadow:0 1px 2px rgba(0,0,0,.45)}.hri-stage-note{margin:8px 0 0;font-size:12px;color:${C.muted};text-align:center}@container(max-width:760px){.hri-grid{grid-template-columns:1fr}.hri-turn{max-width:96%}.hri-stage-grid{grid-template-columns:1fr}.hri-stage{height:clamp(180px,min(52vw,24vh),320px)}}@media(max-height:640px){.hri-session{gap:10px}.hri-session-head{padding:10px}.hri-input{max-height:110px}.hri-stage{height:clamp(140px,min(26vw,22vh),260px)}}`
const button = (primary = false) => ({ border: `1px solid ${primary ? C.accent : C.border}`, borderRadius: 8, padding: '8px 13px', background: primary ? C.accent : C.bg, color: primary ? 'white' : C.text, cursor: 'pointer' })
const input = { border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, color: C.text, padding: '9px 10px', width: '100%' }
const errorText = (error) => String(error?.message || error || '未知错误').replace(/^.*hr-interview\//, 'hr-interview/')
// DeepSeek Key 只以「内存里的表单值」存在：后端只回 configured / source / writable，
// 既不回传完整 Key，也不回传掩码串，所以界面没有任何可回填的 Key 文本。
const credentialShape = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    configured: Boolean(value.configured),
    source: typeof value.source === 'string' && value.source ? value.source : null,
    writable: Boolean(value.writable),
  }
}
// DSH remote 调用一律返回 RemoteResult 信封：{ ok: true, value } / { ok: false, error }。
// 面板内部只认「拆过信封的业务值」，所以在注册 main 之前统一包一层：
// 成功取 value，失败抛 Error(error.message)；裸值只在过渡期兼容（旧 host / 旧测试）。
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const unwrapRemote = (result) => {
  if (result && typeof result === 'object' && !Array.isArray(result) && hasOwn(result, 'ok') && typeof result.ok === 'boolean') {
    if (result.ok) return result.value
    const failure = result.error
    const message = typeof failure === 'string' ? failure : String(failure?.message || failure?.code || '远程调用失败')
    throw new Error(message)
  }
  return result
}
const wrapRemoteApi = (api) => {
  if (!api || typeof api !== 'object') return api
  const wrapped = {}
  const declared = typeof HR_CLIENT_REMOTE !== 'undefined' ? HR_CLIENT_REMOTE.descriptors.map((item) => item.method) : []
  // 以契约方法为准，兼容远程代理把方法定义为 non-enumerable 的实现。
  for (const name of new Set([...declared, ...Object.keys(api)])) {
    const member = api[name]
    wrapped[name] = typeof member === 'function' ? (...args) => Promise.resolve().then(() => member.apply(api, args)).then(unwrapRemote) : member
  }
  return wrapped
}
// Host 只回 { configured, source, writable }：source 说明 Key 从哪来（env / file / project-env / user-env），
// writable 说明能不能在插件里改写。这里收紧成固定形状，后端多塞字段也不会被界面原样渲染出去。
const SOURCE_LABEL = { env: '启动环境变量（只读）', file: 'DSH 凭据存储', 'project-env': '项目 .env', 'user-env': 'DSH .env' }
const sourceLabel = (source) => (source ? SOURCE_LABEL[source] || String(source) : '未知来源')
const secretScrub = (text, secret) => {
  let out = String(text == null ? '' : text)
  if (secret) out = out.split(secret).join('***')
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***').replace(/[A-Za-z0-9_-]{40,}/g, '***')
}
const keyErrorText = (error, secret) => secretScrub(errorText(error), secret)
const statusText = { waiting_for_hr: 'HR 准备中', generating_question: 'HR 正在组织追问', waiting_for_answer: '轮到你回答', processing_answer: '正在记录回答', paused: '已暂停', error: '流程中断，可重试', review_pending: '等待复盘', evaluating: '正在生成复盘', completed: '已完成', reviewing: '复盘查看中' }
const browserTtsAvailable = () => typeof window !== 'undefined' && Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance)
// Audio.play() 被浏览器策略拦下（自动播放限制 / 平台不支持）时，云端其实没有失败：
// 这类错误不能写 60 秒冷却，否则用户手动点「播放语音」也会被降级成本机语音。
const autoplayBlocked = (error) => { const name = String(error?.name || ''); return name === 'NotAllowedError' || name === 'NotSupportedError' }
// ——— 口型表演层（lip-sync） ———
// 与渲染端的固定契约（本文件只负责「量出/造出这个数」，不碰任何模型参数）：
//   HRMark / Live2DAvatar 收 performanceState（idle / listening / thinking / speaking）
//   与 lipLevelRef（React ref，current 是 0..1 的数字）。
// 两类声音来源的能力天生不同，必须分开说实话：
//   1) DeepSeek TTS 走 HTMLAudioElement：MediaElementSource → Analyser → destination 能拿到真实时域波形，
//      改的只是多挂一个分析节点，音频仍然照常从 destination 出声（不接 gain、不改音量）。
//   2) 浏览器 speechSynthesis 拿不到任何音频流（规范里没有可分析的节点图），只能按确定性节奏写包络 ——
//      这是「简化口型」，不代表真实振幅，别把它当测量值。
const LIP_LIMITS = { fftSize: 1024, gain: 3.4, peakGain: 1.6, gate: 0.02, epsilon: 0.004,
  // 平滑用「时间常数」而不是「每帧比例」：60Hz 与 120Hz 屏幕下同一段波形必须收敛成同一个形状，
  // 否则改刷新率就等于改角色性格（120Hz 下涨得快一倍，看起来像另一个人）。
  tauAttack: 32, tauRelease: 90,
  // 第一帧没有上一帧可比，给一个名义间隔；单帧间隔封顶，避免标签页切回来时一次跳满。
  firstFrameMs: 16, maxStepMs: 120,
  // 简化口型：约 3.5 步/秒，步与步之间按 ms 线性插值（同样不按帧数走）。
  envelopeStepMs: 1000 / 3.5,
  // AudioContext 常以 suspended 起步，resume() 也可能一直不落地：最多等这么久就退回简化口型，
  // 绝不允许停在「没声音、也没口型」的空转状态。
  resumeTimeout: 250 }
// 简化口型的节奏表：短句、克制、可复现（不是从音频里量出来的振幅）。
const LIP_SPEECH_ENVELOPE = [0.14, 0.34, 0.58, 0.26, 0.72, 0.4, 0.84, 0.3, 0.52, 0.18]
// 每个 audio element 只允许 createMediaElementSource 一次；重复绑定会抛 InvalidStateError 并把声音弄哑。
const LIP_BOUND_ELEMENTS = new WeakSet()
// performanceState 映射：speaking（真的在出声）最优先，其次「HR 在想」，waiting_for_answer 是「听你说」，
// 其余一律 idle；paused 沿用原来的卸载逻辑，不再单独造一个表演状态。
function performanceStateFor(speaking, status) {
  if (speaking) return 'speaking'
  if (status === 'processing_answer' || status === 'generating_question' || status === 'evaluating') return 'thinking'
  if (status === 'waiting_for_answer') return 'listening'
  return 'idle'
}
// 时域 RMS + 峰值一起用：RMS 决定「嘴张多大」的持续量，峰值补上爆破音的瞬时起振；
// 低于门限一律归零，避免底噪把嘴一直抖着。
function lipShapeFrom(rms, peak, limits = LIP_LIMITS) {
  const shaped = Math.max(rms * limits.gain, peak * limits.peakGain)
  if (!Number.isFinite(shaped) || shaped < limits.gate) return 0
  return shaped > 1 ? 1 : shaped
}
function lipLevelFromFloat(samples, limits = LIP_LIMITS) {
  if (!samples || !samples.length) return 0
  let sum = 0; let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number(samples[index]) || 0; sum += value * value
    const magnitude = value < 0 ? -value : value; if (magnitude > peak) peak = magnitude
  }
  return lipShapeFrom(Math.sqrt(sum / samples.length), peak, limits)
}
function lipLevelFromByte(bytes, limits = LIP_LIMITS) {
  if (!bytes || !bytes.length) return 0
  let sum = 0; let peak = 0
  for (let index = 0; index < bytes.length; index += 1) {
    const value = (bytes[index] - 128) / 128; sum += value * value
    const magnitude = value < 0 ? -value : value; if (magnitude > peak) peak = magnitude
  }
  return lipShapeFrom(Math.sqrt(sum / bytes.length), peak, limits)
}
// rAF 与 AudioContext 都从 window 上取：沙箱/老浏览器缺 rAF 时退到 16ms 定时器，口型不至于整段不动。
function lipFrames() {
  const view = typeof window !== 'undefined' ? window : null
  if (view && typeof view.requestAnimationFrame === 'function') return { request: (callback) => view.requestAnimationFrame(callback), cancel: (id) => { if (typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(id) } }
  return { request: (callback) => setTimeout(callback, 16), cancel: (id) => clearTimeout(id) }
}
function lipAudioContextClass() {
  const view = typeof window !== 'undefined' ? window : null
  return (view && (view.AudioContext || view.webkitAudioContext)) || null
}
const PRESSURE_DELIVERY = Object.freeze({
  firm: { delay: 0, rate: 0.88, pitch: 0.88 },
  pause: { delay: 560, rate: 0.88, pitch: 0.89 },
  questioning: { delay: 320, rate: 0.90, pitch: 1.08 },
  sigh: { delay: 520, rate: 0.88, pitch: 0.89 },
})
function playPressureBreath() {
  const AudioContextClass = lipAudioContextClass()
  if (!AudioContextClass) return () => {}
  let context
  let source
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    if (source) {
      source.onended = null
      try { source.stop() } catch {}
    }
    try { context?.close()?.catch(() => {}) } catch {}
  }
  try {
    context = new AudioContextClass()
    const buffer = context.createBuffer(1, Math.round(context.sampleRate * 0.34), context.sampleRate)
    const samples = buffer.getChannelData(0)
    let smooth = 0
    for (let i = 0; i < samples.length; i += 1) {
      const age = i / samples.length
      smooth += ((Math.random() * 2 - 1) - smooth) * 0.1
      samples[i] = smooth * 0.11 * Math.sin(Math.PI * age) ** 2 * (1 - age * 0.6)
    }
    source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = close
    source.start()
    if (context.state === 'suspended') context.resume().catch(close)
  } catch { close() }
  return close
}
// 一个 driver 对应一次面试页的生命周期；start/stop 可以反复调，cleanup 幂等。
function createLipDriver(levelRef, options = {}) {
  const limits = { ...LIP_LIMITS, ...options }
  const frames = lipFrames()
  const write = (value) => { if (levelRef && typeof levelRef === 'object') levelRef.current = value }
  let disposed = false; let frame = 0; let token = 0; let mode = 'idle'; let phaseMs = 0; let level = 0
  let last = null; let watchdog = null
  let context = null; let analyser = null; let source = null; let element = null; let floatData = null; let byteData = null
  // 时间源：rAF 回调带的 timestamp 优先（同一套时钟，不受测试/离屏计时影响），没有就退到 performance.now / Date.now。
  const timeNow = () => {
    const view = typeof window !== 'undefined' ? window : null
    if (view && view.performance && typeof view.performance.now === 'function') return view.performance.now()
    return Date.now()
  }
  // 平滑：按 dt 做指数逼近 —— 起振快（tauAttack）、回落慢（tauRelease），与帧率无关；
  // 低于 epsilon 直接归零，别留一条永远抖的尾巴。
  const settle = (target, dt) => {
    if (!Number.isFinite(target)) { level = 0; write(0); return }
    const span = Number.isFinite(dt) && dt > 0 ? dt : 0
    const tau = target > level ? limits.tauAttack : limits.tauRelease
    const alpha = span > 0 && tau > 0 ? 1 - Math.exp(-span / tau) : 0
    const previous = level
    const next = previous + (target - previous) * alpha
    level = next > limits.epsilon ? (next > 1 ? 1 : next) : 0
    write(level)
  }
  // 简化口型的取值：把节奏表当成一条按时间走的折线（步长 envelopeStepMs），帧处在两档之间就插值，
  // 于是 60Hz 与 120Hz 看到的是同一条曲线。
  const envelopeAt = (elapsedMs) => {
    const list = LIP_SPEECH_ENVELOPE
    const step = limits.envelopeStepMs > 0 ? limits.envelopeStepMs : 1000 / 3.5
    const position = (Math.max(0, elapsedMs) / step) % list.length
    const index = Math.floor(position)
    const fraction = position - index
    const from = list[index]
    const to = list[(index + 1) % list.length]
    return from + (to - from) * fraction
  }
  // resume 看门狗：只保证「不会挂住」，谁先落地（resume 成功 / resume 失败 / 看门狗）谁说了算。
  const clearWatchdog = () => {
    if (watchdog) { try { clearTimeout(watchdog) } catch { /* 取消失败也无害：回调自己会看到 context 已经换了 */ } watchdog = null }
  }
  const armWatchdog = (pending) => {
    clearWatchdog()
    const timeout = Number.isFinite(limits.resumeTimeout) && limits.resumeTimeout > 0 ? limits.resumeTimeout : 250
    watchdog = setTimeout(() => {
      watchdog = null
      // resume 晚到也没关系：detachNodes 已经把 context 置空，晚到的 arm() 会被 context !== current 挡掉。
      if (disposed || context !== pending) return
      detachNodes(); startSynthetic()
    }, timeout)
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref()
  }
  const readAnalyser = () => {
    if (!analyser) return 0
    const size = analyser.fftSize || limits.fftSize
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      if (!floatData || floatData.length !== size) floatData = new Float32Array(size)
      analyser.getFloatTimeDomainData(floatData); return lipLevelFromFloat(floatData, limits)
    }
    if (typeof analyser.getByteTimeDomainData === 'function') {
      if (!byteData || byteData.length !== size) byteData = new Uint8Array(size)
      analyser.getByteTimeDomainData(byteData); return lipLevelFromByte(byteData, limits)
    }
    return 0
  }
  // token：每次 start/stop 自增，旧帧回调看到自己过期就直接退场 —— 上一段播放不许影响下一段。
  const loop = (mine, stamp) => {
    // 过期帧（mine !== token）连 frame 都不许碰：那个 slot 已经属于新一代播放，
    // 被旧回调清掉会让 stop() 再也取消不掉它。
    if (disposed || mine !== token || mode === 'idle') return
    const instant = Number.isFinite(stamp) ? stamp : timeNow()
    const dt = last === null ? limits.firstFrameMs : Math.min(limits.maxStepMs, Math.max(0, instant - last))
    last = instant
    if (mode === 'audio') settle(readAnalyser(), dt)
    else { phaseMs += dt; settle(envelopeAt(phaseMs), dt) }
    frame = frames.request((next) => loop(mine, next))
  }
  // 起第一帧也走调度器（不在 start 里同步跑一帧）：这样第一帧真的拿到时间戳，
  // 平滑用 nominal dt 起步，且「第一帧」与后续帧共用同一条时间线。
  const begin = () => { const mine = token; frame = frames.request((next) => loop(mine, next)) }
  const cancelFrame = () => { token += 1; if (frame) { try { frames.cancel(frame) } catch { /* 取消失败也不影响后面的归零 */ } frame = 0 } last = null }
  // 断开节点 + 关闭 AudioContext：重复调用安全；关掉上下文后这张图就作废，下次 start 重新建。
  const detachNodes = () => {
    clearWatchdog()
    const previousSource = source; const previousAnalyser = analyser; const previousContext = context
    source = null; analyser = null; element = null; floatData = null; byteData = null; context = null
    try { previousSource?.disconnect?.() } catch { /* 已断开 */ }
    try { previousAnalyser?.disconnect?.() } catch { /* 已断开 */ }
    if (previousContext && typeof previousContext.close === 'function') {
      try { const closed = previousContext.close(); if (closed && typeof closed.catch === 'function') closed.catch(() => { /* 关闭失败无需上报 */ }) } catch { /* 关闭失败无需上报 */ }
    }
  }
  // 简化口型：speechSynthesis 无音频流；或 AudioContext 不可用/被策略拒绝时的兜底。
  // 只按固定节奏写包络，不建 AudioContext、不碰 Analyser。
  const startSynthetic = () => {
    if (disposed) return false
    cancelFrame(); detachNodes()
    mode = 'synthetic'; phaseMs = 0; last = null; level = 0; write(0)
    begin()
    return true
  }
  // 真实振幅：element → MediaElementSource → Analyser → destination。
  // 建图顺序刻意让 createMediaElementSource 排在最后：它一旦成功，element 的输出就只走这张图，
  // 所以它前面失败的路径不会把声音弄哑。
  const startAudio = (nextElement) => {
    if (disposed) return false
    if (!nextElement) return startSynthetic()
    cancelFrame(); detachNodes()
    const Context = lipAudioContextClass()
    if (!Context) return startSynthetic()
    let pending = null
    try { pending = new Context() } catch { return startSynthetic() }
    context = pending
    const arm = (current) => {
      if (disposed || context !== current) return
      clearWatchdog()
      try {
        analyser = current.createAnalyser()
        if (analyser) analyser.fftSize = limits.fftSize
        analyser.connect(current.destination)
        if (LIP_BOUND_ELEMENTS.has(nextElement)) throw new Error('audio element 已经绑定过 MediaElementSource')
        source = current.createMediaElementSource(nextElement)
        if (source) LIP_BOUND_ELEMENTS.add(nextElement)
        source.connect(analyser)
        element = nextElement
        mode = 'audio'; last = null; level = 0; write(0)
        begin()
      } catch {
        // 走到这里 element 的原生出声路径还没被改，退回简化口型即可，语音照播。
        detachNodes(); startSynthetic()
      }
    }
    // 自动播放策略下 AudioContext 常以 suspended 起：先按策略 resume；拿不到 running 就不接图，
    // 直接用简化口型 —— 免得音频被一个挂住的上下文吃掉。
    if (pending.state === 'suspended' && typeof pending.resume === 'function') {
      let resumed
      try { resumed = pending.resume() } catch { resumed = null }
      if (resumed && typeof resumed.then === 'function') {
        // resume 成功前绝不 createMediaElementSource（那会把握手期的 element 输出改道）。
        resumed.then(() => arm(pending), () => { if (!disposed && context === pending) { detachNodes(); startSynthetic() } })
        // resume 可能永远 pending：等过一个阈值就自己退成简化口型，绝不留「没声音也没口型」的死状态。
        armWatchdog(pending)
        return true
      }
      if (!resumed) arm(pending)
      return true
    }
    arm(pending)
    return true
  }
  const stop = () => { cancelFrame(); detachNodes(); mode = 'idle'; phaseMs = 0; level = 0; write(0) }
  const dispose = () => { disposed = true; stop() }
  return { startAudio, startSynthetic, stop, dispose }
}
function blobToDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob) }) }
function pcm16Wave(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer)
  const text = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) { const sample = Math.max(-1, Math.min(1, samples[index])); view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true) }
  return new Blob([buffer], { type: 'audio/wav' })
}
async function canonicalAudio(blob) {
  if (!Number.isFinite(blob.size) || blob.size === 0) throw new Error('录音为空')
  const Context = window.AudioContext || window.webkitAudioContext; if (!Context || !window.OfflineAudioContext) throw new Error('浏览器不支持本地语音重采样，请使用文字降级')
  const context = new Context()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    if (!decoded.duration || decoded.duration > 120) throw new Error('单次回答需大于 0 秒且不超过 120 秒')
    const offline = new window.OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000); const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start()
    const rendered = await offline.startRendering(); return pcm16Wave(rendered.getChannelData(0))
  } finally { await context.close() }
}
function Field(label, children) { return h('label', { className: 'hri-field' }, h('span', null, label), children) }
function StudioPage({ className, rootRef, children, ...attributes }) {
  return h('div', { ...attributes, className: `hri-studio ${className}`, ref: rootRef }, h('style', null, studioCss), children)
}
// disabled 必须有可见反馈：只把 opacity/cursor 交给原生属性，读屏仍靠 disabled 本身。
function Button({ primary, children, style, disabled, ...rest }) {
  return h('button', { type: 'button', ...rest, disabled, style: { ...button(primary), ...(disabled ? { opacity: 0.55, cursor: 'not-allowed' } : null), ...style } }, children)
}
// ——— 虚拟背景（只在面试页左屏的 stage 变体画） ———
// Host 契约：capabilities.backgrounds = [{ id, label, url }]，不可用时是 []。
// 这里只做「白名单查询」：背景 id 必须能在列表里查到，url 必须是站内相对路径，
// 因此外部地址（http:、//host、data: …）无论 Host 或用户输入什么都不会进 <img src>。
const BACKGROUND_DEFAULT = 'office'
const BACKGROUND_OFF = 'off'
const BACKGROUND_URL = /^\/(?![/\\])[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]+)*$/
const backgroundLabel = (item, id) => (typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id)
function backgroundChoices(backgrounds) {
  if (!Array.isArray(backgrounds)) return []
  const seen = new Set(); const out = []
  for (const item of backgrounds) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    // 「关闭背景」是保留值，不能被某个 id 抢走；重复 id 只认第一个。
    if (!id || id === BACKGROUND_OFF || seen.has(id) || !BACKGROUND_URL.test(url)) continue
    seen.add(id); out.push({ id, label: backgroundLabel(item, id), url })
  }
  return out
}
// 查不到就是没有背景（返回 null），不会退化成「列表里随便挑一个 url」。
function backgroundChoice(backgrounds, id) {
  if (typeof id !== 'string' || !id || id === BACKGROUND_OFF) return null
  return backgroundChoices(backgrounds).find((item) => item.id === id) || null
}
function HRMark({ speaking = false, avatar = null, enabled = true, paused = false, variant = 'badge', performanceState = 'idle', lipLevelRef = null, pressureReaction = '', pressureMode = false, pressureGesture = '', background = BACKGROUND_DEFAULT, backgrounds = null }) {
  // 48px 静态标识与可访问文字始终保留：Live2D 默认由用户显式开启；暂停时卸载舞台。
  const live = enabled && !paused && Boolean(avatar) && avatar.kind === 'live2d' && avatar.available !== false
  // 表演状态的优先级由 performanceStateFor 决定；这里只做转发，不自己再推断一遍。
  // performanceState 只在 paused 时强制回落 idle（此时舞台本来就已经卸载），其余原样交给渲染端。
  const state = paused ? 'idle' : performanceState
  // 背景图加载失败只藏这一层：舞台底色/静态圆照旧，面试流程不受影响；换背景会自动重试。
  const [failedBackground, setFailedBackground] = useState(null)
  // 正式面试使用近景舞台，准备页使用全身预览和面试官标识。
  if (variant === 'stage') {
    const backdrop = backgroundChoice(backgrounds, background)
    const shown = backdrop && backdrop.url !== failedBackground ? backdrop : null
    return h('div', { className: 'hri-hr-stage' },
      // 背景层放在 DOM 最前且 z-index:0：Live2D / 静态圆 / 角标都是后绘制的定位层，自然压在它上面。
      shown && h('div', { className: 'hri-hr-backdrop', 'aria-hidden': 'true' },
        h('img', { className: 'hri-hr-backdrop-img', src: shown.url, alt: '', 'aria-hidden': 'true', draggable: false, onError: () => setFailedBackground(shown.url) }),
        h('span', { className: 'hri-hr-backdrop-veil' })),
      live && h(Live2DAvatar, { key: `${avatar.base || ''}/${avatar.model || ''}`, avatar, speaking, performanceState: state, lipLevelRef, pressureReaction, pressureMode, pressureGesture, fill: true, size: 320 }),
      !live && h('div', {
        role: 'img',
        'aria-label': `HR 面试官形象：${paused ? '已暂停' : speaking ? '正在提问' : '静态头像'}`,
        // 有背景图时这层必须是透明的，否则会把背景整块糊掉；没有背景时仍是原来的纯色兜底。
        style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', alignContent: 'center', gap: 10, color: C.muted, fontSize: 13, textAlign: 'center', padding: 16, background: shown ? 'transparent' : `radial-gradient(circle at 50% 34%, ${C.layer}, ${C.bg})` },
      },
        // 120px 静态圆：大舞台里不放大成糊图，也不假装是 Live2D。
        h('span', {
          'aria-hidden': 'true',
          style: { width: 120, height: 120, borderRadius: '50%', display: 'grid', placeItems: 'center', background: speaking ? C.accent : C.layer, color: speaking ? 'white' : C.accent, border: `1px solid ${C.border}`, fontWeight: 700, fontSize: 34 },
        }, 'HR'),
        // 只在「没开启」时提示；暂停/提问中的状态由角标与 aria-label 表达，不再重复解释。
        !enabled && h('span', { style: { fontSize: 12, color: C.muted } }, '未启用 Live2D 形象 · 可在开始面试前开启')),
    )
  }
  return h('div', { className: 'hri-interviewer-mark' },
    h('div', { className: 'hri-interviewer-identity' },
      h('div', { 'aria-hidden': 'true', style: { width: 48, height: 48, borderRadius: '50%', display: 'grid', placeItems: 'center', background: speaking ? C.accent : C.layer, color: speaking ? 'white' : C.accent, border: `1px solid ${C.border}`, fontWeight: 700 } }, 'HR'),
      h('div', null, h('strong', null, 'HR 技术面试官'), h('div', { style: { color: C.muted, fontSize: 12 } }, speaking ? '正在提问…' : '严格、专业、基于证据'))),
    live && h(Live2DAvatar, { key: `${avatar.base || ''}/${avatar.model || ''}`, avatar, speaking, performanceState: state, lipLevelRef }))
}
// ——— 简历文件上传（本地解析） ———
// 只做三件事：读 File → 分块转 base64 → 调 api.parseResume。解析在 Host 本地完成，原文件只读、
// 不上传云端、不自动保存；成功才覆盖当前未保存的简历草稿，保存仍由用户手动点。
const RESUME_ACCEPT = '.pdf,.docx,.txt,.md'
const RESUME_MAX_BYTES = 8 * 1024 * 1024
const RESUME_MIME = {
  txt: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
// 32766 = 3 * 10922：每块都是 3 的倍数，逐块 btoa 后直接拼接仍是合法 base64（补齐只出现在最后一块）。
const RESUME_BASE64_CHUNK = 32766
const RESUME_WARNING_LIMIT = 3
const resumeExtension = (name) => {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim())
  return match ? match[1].toLowerCase() : ''
}
const resumeSizeText = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
// 分块 fromCharCode：每次只把 32KB 展开成参数，8 MiB 整体 apply 会打爆调用栈。
const bytesToBase64 = (bytes) => {
  const parts = []
  for (let offset = 0; offset < bytes.length; offset += RESUME_BASE64_CHUNK) {
    const slice = bytes.subarray(offset, Math.min(offset + RESUME_BASE64_CHUNK, bytes.length))
    parts.push(btoa(String.fromCharCode.apply(null, slice)))
  }
  return parts.join('')
}
// truncated / warnings 只展示有限条：文件再长也不把提示区刷成一面墙。
const resumeNotices = (result) => {
  const notices = []
  if (result && result.truncated) notices.push('文件较长，已截断，只解析了前面部分')
  const warnings = Array.isArray(result && result.warnings) ? result.warnings.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []
  for (const warning of warnings.slice(0, RESUME_WARNING_LIMIT)) notices.push(warning)
  if (warnings.length > RESUME_WARNING_LIMIT) notices.push(`另有 ${warnings.length - RESUME_WARNING_LIMIT} 条提示`)
  return notices
}
function MaterialsView({ api, onSaved, roleDutyPreparation }) {
  const [value, setValue] = useState({ role: '', resume: '', jd: '', projectNotes: '' }); const [busy, setBusy] = useState(false)
  // 提示带显式类型（success / error）：不再用「文案里有没有『已』」猜颜色。
  const [notice, setNotice] = useState(null)
  const [materialsReady, setMaterialsReady] = useState(false)
  // 上传与保存互斥：上传中不许保存（避免把半份草稿存下去），保存中不许上传（避免覆盖正在提交的值）。
  const [uploadBusy, setUploadBusy] = useState(false); const [uploadNote, setUploadNote] = useState(''); const [uploadNotices, setUploadNotices] = useState([]); const [uploadError, setUploadError] = useState('')
  // 自动建议岗位的说明文案；用户一旦手改岗位就清空，免得提示和输入框说的不是一回事。
  const [roleHint, setRoleHint] = useState('')
  const uploading = useRef(false); const uploadSeq = useRef(0); const uploadAlive = useRef(true)
  // lastAutoRole：上一次由简历自动填进去的岗位。只有「空」或「仍等于它」才允许被新建议覆盖。
  const lastAutoRole = useRef(''); const valueRef = useRef(value)
  const filled = (text) => typeof text === 'string' && text.trim().length > 0
  const flash = (kind, text) => setNotice(text ? { kind, text } : null)
  useEffect(() => { uploadAlive.current = true; return () => { uploadAlive.current = false } }, [])
  // 解析是异步的：await 之后要按「最新草稿」判断岗位能不能被覆盖，不能读 handler 创建时的闭包快照。
  useEffect(() => { valueRef.current = value }, [value])
  useEffect(() => {
    let live = true
    api.materials().then((data) => { if (live) setValue((old) => ({ ...old, ...data })) }).catch((e) => live && flash('error', errorText(e))).finally(() => { if (live) setMaterialsReady(true) })
    return () => { live = false }
  }, [api])
  const update = (key, event) => {
    const next = event.target.value
    if (key === 'role') setRoleHint('')
    setValue((old) => ({ ...old, [key]: next }))
  }
  // role / resume / jd 是把材料交给面试官的部分；projectNotes 只是补充，所以只它非空也算有草稿。
  const missingFields = () => {
    if (roleDutyPreparation) return filled(value.role) || (filled(value.resume) && filled(value.jd)) ? [] : ['目标岗位']
    const missing = []
    if (!filled(value.role)) missing.push('目标岗位')
    if (!filled(value.resume)) missing.push('简历')
    if (!filled(value.jd)) missing.push('岗位 JD')
    return missing
  }
  const allEmpty = !filled(value.role) && !filled(value.resume) && !filled(value.jd) && !filled(value.projectNotes)
  // 缺 JD 只是「草稿」：保存按钮不再要求三个字段全非空。
  const saveDisabled = busy || uploadBusy || !materialsReady || allEmpty
  const saveHint = uploadBusy ? '正在本地解析简历，解析结束前不能保存'
    : busy ? '正在保存材料，请稍候'
    : !materialsReady ? '正在读取上次保存的材料，就绪后才能保存'
    : allEmpty ? '目标岗位、简历、岗位 JD、项目补充至少填一项才能保存'
    : ''
  const save = async () => {
    if (busy || uploading.current || !materialsReady) return
    const missing = missingFields()
    if (allEmpty) return
    setBusy(true); flash(null)
    try {
      const next = await api.saveMaterials(value)
      setValue((old) => (next && typeof next === 'object' ? { ...old, ...next } : old))
      // 按当前宿主的入场条件提示保存状态。
      flash('success', missing.length === 0 ? '材料已保存' : `草稿已保存（还缺${missing.join('、')}），开始面试前补齐即可`)
      onSaved?.()
    } catch (e) { flash('error', errorText(e)) } finally { setBusy(false) }
  }
  const pickResume = async (event) => {
    const inputEl = event && event.target ? event.target : null
    const picked = inputEl && inputEl.files && inputEl.files[0] ? inputEl.files[0] : null
    // 用户取消选择：保留原文，连状态都不动。
    if (!picked) return
    // 材料还没落地就放行上传的话，迟到的 materials 回填会把刚解析出的草稿盖掉：settle 前一律不解析。
    if (!materialsReady) { if (inputEl) inputEl.value = ''; return }
    // 防重入：正在解析或正在保存时再选文件直接丢弃，并清空 value 让下次还能重选。
    if (uploading.current || busy) { if (inputEl) inputEl.value = ''; return }
    uploading.current = true
    const request = uploadSeq.current + 1; uploadSeq.current = request
    // 卸载或后继请求会让这次结果作废：不再写任何状态。
    const stale = () => !uploadAlive.current || request !== uploadSeq.current
    setUploadBusy(true); setUploadError(''); setUploadNote(''); setUploadNotices([])
    try {
      const mimeType = RESUME_MIME[resumeExtension(picked.name)]
      if (!mimeType) { setUploadError('只支持 PDF / DOCX / TXT / MD 文件，请换一份或直接粘贴正文'); return }
      if (!Number.isFinite(picked.size) || picked.size <= 0) { setUploadError('这个文件是空的，请换一份或直接粘贴正文'); return }
      if (picked.size > RESUME_MAX_BYTES) { setUploadError(`文件 ${resumeSizeText(picked.size)} 超过 8 MiB 上限，请压缩后再试`); return }
      if (typeof api.parseResume !== 'function') { setUploadError('当前 Host 版本还不支持解析文件，请先把正文粘贴进来'); return }
      const buffer = await picked.arrayBuffer()
      if (stale()) return
      if (!buffer || !buffer.byteLength) { setUploadError('这个文件是空的，请换一份或直接粘贴正文'); return }
      if (buffer.byteLength > RESUME_MAX_BYTES) { setUploadError(`文件 ${resumeSizeText(buffer.byteLength)} 超过 8 MiB 上限，请压缩后再试`); return }
      // 只把 base64 交给 RPC：正文、base64 与文件名都不进 console。
      const result = await api.parseResume({ name: picked.name, mimeType, dataBase64: bytesToBase64(new Uint8Array(buffer)) })
      if (stale()) return
      const text = typeof (result && result.text) === 'string' ? result.text : ''
      if (!text.trim()) { setUploadError('没有解析出文字，请换一份文件或直接粘贴正文'); return }
      // 岗位建议：只填空值，或填「上一次自动建议」留下的原值。用户手填、手改过的岗位一律不动。
      const suggestedRole = typeof (result && result.suggestedRole) === 'string' ? result.suggestedRole.trim() : ''
      const suggestedSource = result && result.suggestedRoleSource === 'intent' ? '求职意向' : result && result.suggestedRoleSource === 'filename' ? '文件名' : ''
      const currentRole = typeof valueRef.current.role === 'string' ? valueRef.current.role.trim() : ''
      const mayFillRole = Boolean(suggestedRole) && (!currentRole || currentRole === lastAutoRole.current)
      if (mayFillRole) lastAutoRole.current = suggestedRole
      // 只有解析成功才覆盖草稿；不调用 saveMaterials，等用户自己确认。
      setValue((old) => ({ ...old, resume: text, ...(mayFillRole ? { role: suggestedRole } : null) }))
      if (mayFillRole) setRoleHint(`已按简历里的${suggestedSource || '内容'}填入目标岗位「${suggestedRole}」，可修改`)
      else if (suggestedRole) setRoleHint(`简历建议的岗位是「${suggestedRole}」，已保留你填写的岗位`)
      const characters = Number.isFinite(Number(result && result.characters)) ? Number(result.characters) : text.length
      const fileName = typeof (result && result.fileName) === 'string' && result.fileName.trim() ? result.fileName.trim() : picked.name
      setUploadNote(`${fileName} · ${characters} 字符 · 请检查后保存`)
      setUploadNotices(resumeNotices(result))
    } catch (e) {
      if (!stale()) setUploadError(`解析失败：${errorText(e)}`)
    } finally {
      uploading.current = false
      if (uploadAlive.current) setUploadBusy(false)
      // 每次结束都清空：同一个文件可以重新选、重新解析。
      if (inputEl) inputEl.value = ''
    }
  }
  const resumeUpload = h('div', { className: 'hri-upload' },
      h('div', { className: 'hri-controls' },
        h('span', { style: { fontSize: 13, color: C.muted } }, '上传简历文件'),
        h('input', { type: 'file', accept: RESUME_ACCEPT, 'aria-label': '上传简历文件', 'aria-describedby': 'hri-resume-upload-help', disabled: !materialsReady || busy || uploadBusy, onChange: (event) => { pickResume(event) } }),
        uploadBusy && h('span', { style: { color: C.muted, fontSize: 12 } }, '正在本地解析…')),
      h('span', { id: 'hri-resume-upload-help', style: { fontSize: 12, color: C.muted } }, 'PDF / DOCX / TXT / MD，最大 8 MiB，本地解析；原文件只读，不上传云端，也不会自动保存'),
      uploadNote && h('span', { role: 'status', style: { fontSize: 13, color: C.success } }, uploadNote),
      uploadNotices.length > 0 && h('span', { role: 'status', style: { fontSize: 12, color: C.accent } }, uploadNotices.join('；')),
      uploadError && h('span', { role: 'alert', style: { fontSize: 13, color: C.danger } }, uploadError))
  return h(StudioPage, { className: 'hri-materials' },
    h('header', { className: 'hri-studio-head' },
      h('div', { className: 'hri-top' },
        h('h2', null, '面试材料'),
        h('div', { className: 'hri-controls' },
          h(Button, { primary: true, disabled: saveDisabled, title: saveHint || undefined, 'aria-describedby': saveHint ? 'hri-save-hint' : undefined, onClick: save }, busy ? '保存中…' : '保存材料'))),
      saveHint && h('p', { id: 'hri-save-hint', role: 'status', className: 'hri-studio-meta' }, saveHint),
      notice && h('p', { role: notice.kind === 'error' ? 'alert' : 'status', className: 'hri-studio-meta', style: { color: notice.kind === 'error' ? C.danger : C.success } }, notice.text)),
    h('section', { className: 'hri-card hri-material-role' },
      Field('目标岗位', h('input', { className: 'hri-input', value: value.role, onChange: (event) => update('role', event), placeholder: '例如：Agent 应用工程师' })),
      roleHint && h('p', { role: 'status', className: 'hri-studio-meta', style: { color: C.accent } }, roleHint)),
    h('div', { className: 'hri-material-grid' },
      h('section', { className: 'hri-card', 'aria-label': '简历' },
        resumeUpload,
        Field('简历', h('textarea', { className: 'hri-input', rows: 12, value: value.resume, onChange: (event) => update('resume', event), placeholder: '粘贴简历正文，或上传文件自动填入；不要放账号、密钥等无关信息' }))),
      h('section', { className: 'hri-card', 'aria-label': '岗位要求与项目补充' },
        Field('岗位 JD', h('textarea', { className: 'hri-input', rows: 8, value: value.jd, onChange: (event) => update('jd', event), placeholder: '粘贴岗位职责与要求' })),
        !filled(value.jd) && h('p', { className: 'hri-studio-meta', style: { margin: '-6px 0 12px' } }, roleDutyPreparation ? '可选。只填目标岗位，也能检索公开面经。' : '可先保存草稿，开始面试前再补 JD'),
        Field('项目补充 / 作品链接说明', h('textarea', { className: 'hri-input', rows: 4, value: value.projectNotes, onChange: (event) => update('projectNotes', event) })))))
}
// —— 面试提纲 ——
// Host 负责本地选题和公开资料补充，准备流程不需要模型凭据，所以这里不看
// capabilities.configured；旧 Host 没有这两个 RPC 时 prepareInterview/latestPreparation 是
// undefined，整个提纲区安静消失，开始按钮照旧「进入面试」走原来的动态追问。
const PREPARATION_ID = /^prep-[a-z0-9-]{8,80}$/
const PLAN_KIND_LABEL = { project: '项目', principle: '原理', incident: '排查', evaluation: '评估', behavioral: '行为' }
const QUESTION_BASIS_LABELS = { local: '本地题库', 'public-interview': '公开面经参考', 'public-duty': '根据公开岗位职责生成', simulation: '模拟题', answer: '根据本次回答' }
const questionBasisLabel = (basis) => hasOwn(QUESTION_BASIS_LABELS, basis) ? QUESTION_BASIS_LABELS[basis] : ''
const planText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
// —— 本地 msy 题库设置（可选）——
// Host 只回 msyDir / updatedAt / configured：这里只留这三个字段。目录只用来显示与编辑，
// updatedAt 是「题库设置版本」，只用来判断现成提纲是不是按旧设置准备的；
// 路径不写 localStorage、不进 preparation 或 start options，前端也不读任何文件。
// 统计只留两个数字：题量由 Host 扫完再给，前端不认识题库文件，也不去猜。
const sourceSummaryShape = (value) => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const count = (input) => { const number = Number(input); return Number.isFinite(number) ? Math.max(0, Math.min(99999, Math.round(number))) : 0 }
  return { agentQuestions: count(raw.agentQuestions), resumeQuestions: count(raw.resumeQuestions) }
}
const SOURCE_NAME_FALLBACK = '本地题库'
const sourceShape = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const msyDir = typeof value.msyDir === 'string' ? value.msyDir.trim().slice(0, 1024) : ''
  const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt.slice(0, 64) : null
  return {
    msyDir,
    updatedAt,
    configured: value.configured === true || Boolean(msyDir),
    // 界面默认只显示名字与统计，路径收进「高级设置」：名字由 Host 给，缺了就用通用名。
    displayName: planText(value.displayName, 60) || SOURCE_NAME_FALLBACK,
    summary: sourceSummaryShape(value.sourceSummary),
  }
}
// 目录选择只有两条合法来路：宿主注入的 __DSH_DIRECTORY_PICKER__，或 ctx 上的 uiWorkspace。
// 都没有就返回哨兵值（≠ null）——「没有接口」和「用户取消」必须分得开。
const PICKER_UNAVAILABLE = { picker: 'unavailable' }
const pickDirectoryVia = async (ctx) => {
  const bridge = typeof globalThis !== 'undefined' ? globalThis.__DSH_DIRECTORY_PICKER__ : null
  if (bridge && typeof bridge.pick === 'function') return await bridge.pick()
  const workspace = typeof ctx?.get === 'function' ? ctx.get('uiWorkspace') : null
  if (workspace && typeof workspace.pickDirectory === 'function') return await workspace.pickDirectory()
  return PICKER_UNAVAILABLE
}
// Compare the displayed questions within each section. Titles and bank IDs can stay the same when wording changes.
const changedPlanKeys = (before, after) => {
  const questionInSection = (item) => `${item.alternate}:${item.question.replace(/\s+/gu, ' ')}`
  const previous = new Set(before.items.map(questionInSection))
  return new Set(after.items.filter((item) => !previous.has(questionInSection(item))).map((item) => item.key))
}
// 提纲里记的「准备时的题库设置版本」：旧 Host / rc.23 的 preparation 没有这个字段，
// 返回 undefined 表示「无从比较」，界面按匹配处理，不能凭空提示过期。
const sourceStamp = (value) => {
  if (!hasOwn(value, 'sourceSettingsUpdatedAt')) return undefined
  return typeof value.sourceSettingsUpdatedAt === 'string' ? value.sourceSettingsUpdatedAt.slice(0, 64) : ''
}
// rc.26：题目来源不进界面。sourceRefs 仍留在 Host 的 preparation / session 里做审计，
// 前端连读都不读 —— 没有 planSource，就没有 item.source，也就不可能生成 <a> 或来源文本。
// 来源只用来回答一个问题：这次准备是不是降级了。条数、目录与 warning 原文一概不进 UI 模型，
// 所以界面上既不会出现本机路径，也不会出现「精选46＋msy岗位题X＋简历深挖Y」这类来源统计。
const preparationSourceDegraded = (value) => {
  const raw = value?.sources
  const sources = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  const status = (input) => (input && typeof input === 'object' && !Array.isArray(input) ? input.status : undefined)
  const warnings = Array.isArray(value?.warnings) ? value.warnings.filter((entry) => typeof entry === 'string' && entry.trim()) : []
  return status(sources?.msyQuestions) === 'degraded' || status(sources?.msyResume) === 'degraded' || warnings.length > 0
}
// 只把「要渲染的字段」挑出来落进 state：profileKey、planKey、材料正文、本机路径、题目来源从不进来，
// 所以界面既没法显示它们，也不会把它们带进任何 DOM 属性。
const planItems = (value) => {
  const out = []
  if (!Array.isArray(value)) return out
  for (const entry of value.slice(0, 40)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const question = planText(entry.question, 400)
    if (!question) continue
    const points = Array.isArray(entry.expectedPoints)
      ? entry.expectedPoints.map((point) => planText(point, 200)).filter(Boolean).slice(0, 2)
      : []
    out.push({
      key: planText(entry.planItemId, 80) || planText(entry.bankItemId, 80) || `plan-${out.length + 1}`,
      topic: planText(entry.duty, 80) || planText(entry.topic, 80),
      kind: planText(entry.kind, 40),
      question,
      points,
      basis: planText(entry.basis, 32),
      basisLabel: questionBasisLabel(entry.basis),
      opening: entry.opening === true,
      gated: ['iteration', 'production', 'evaluation', 'project'].includes(entry.contextRequirement),
      alternate: entry.alternate === true,
    })
  }
  return out
}
const preparationShape = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const preparationId = typeof value.preparationId === 'string' && PREPARATION_ID.test(value.preparationId) ? value.preparationId : ''
  const items = planItems(value.items)
  if (!preparationId || !items.length) return null
  const budget = value.questionBudget && typeof value.questionBudget === 'object' && !Array.isArray(value.questionBudget) ? value.questionBudget : {}
  const total = items.length
  const count = (input, fallback) => {
    const number = Number(input)
    return Number.isFinite(number) ? Math.max(0, Math.min(total, Math.round(number))) : fallback
  }
  const main = count(budget.main, items.filter((item) => !item.alternate).length || Math.max(0, total - 2))
  return {
    preparationId,
    durationMinutes: Number(value.durationMinutes) === 15 ? 15 : 30,
    profileMatches: value.profileMatches === true,
    dutyPlan: value.dutyPlan === true,
    main,
    alternates: count(budget.alternates, Math.max(0, total - main)),
    items,
    roleContextMissing: value.roleContextMissing === true,
    // 旧 preparation（rc.23）没有 sources / warnings 时一律按「没有降级」处理，也就不提示。
    // sourceSettingsStamp 为 undefined 时按「匹配」处理。
    sourceDegraded: preparationSourceDegraded(value),
    sourceSettingsStamp: sourceStamp(value),
  }
}
// 题目来源留在 Host 内审计，提纲只渲染题目和通用降级状态。
function PreparationOutline({ preparation, matched, sourceStale, refreshAction, directionAction, directionNotice, changedKeys }) {
  const [expandedKey, setExpandedKey] = useState(null)
  const [alternatesOpen, setAlternatesOpen] = useState(false)
  const listRef = useRef(null)
  const panelId = React.useId()
  const items = preparation?.items || []
  const mainItems = items.filter((item) => !item.alternate)
  const alternates = items.filter((item) => item.alternate)
  const changedMain = mainItems.filter((item) => changedKeys?.has(item.key)).length
  const changedAlternates = alternates.filter((item) => changedKeys?.has(item.key)).length
  const refreshSummary = [changedMain && `${changedMain} 道主问`, changedAlternates && `${changedAlternates} 道备选`].filter(Boolean).join('、')
  const refreshNotice = directionNotice || (changedKeys && (refreshSummary ? `已换 ${refreshSummary}` : '没有更多可换的题'))
  const coreQuestions = mainItems.filter((item) => !item.opening)
  const simulationsOnly = coreQuestions.length > 0 && coreQuestions.every((item) => item.basis === 'simulation')
  const visible = alternatesOpen ? [...mainItems, ...alternates] : mainItems
  const activeKey = expandedKey === '' || visible.some((item) => item.key === expandedKey)
    ? expandedKey : visible[0]?.key
  const navigate = (event, index) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const nextIndex = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: visible.length - 1 }[event.key]
    if (!Number.isInteger(nextIndex)) return
    event.preventDefault()
    const target = Math.min(visible.length - 1, Math.max(0, nextIndex))
    setExpandedKey(visible[target].key)
    listRef.current?.querySelectorAll('.hri-plan-item:not([hidden]) .hri-plan-toggle')[target]?.focus()
  }
  const row = (item, index) => {
    const position = item.alternate ? index + mainItems.length : index
    const expanded = item.key === activeKey
    const detailId = `${panelId}-${position}`
    const title = hasOwn(HR_QUESTION_TOPIC_LABELS, item.topic) ? HR_QUESTION_TOPIC_LABELS[item.topic] : item.topic
    const kind = hasOwn(PLAN_KIND_LABEL, item.kind) ? PLAN_KIND_LABEL[item.kind] : item.kind
    const tags = [kind, item.basisLabel, item.opening && '固定开场', item.gated && '确认经历后再问', item.alternate && '备选'].filter(Boolean)
    const changed = changedKeys?.has(item.key)
    return h('li', {
      key: item.key, className: `hri-plan-item${expanded ? ' is-selected' : ''}`,
      hidden: item.alternate && !alternatesOpen,
      'data-hri-plan-item': item.key, 'data-hri-plan-index': position + 1,
    },
    h('button', {
      type: 'button', className: 'hri-plan-toggle', 'aria-expanded': expanded, 'aria-controls': detailId,
      onClick: () => setExpandedKey(expanded ? '' : item.key), onKeyDown: (event) => navigate(event, position),
    },
    h('span', { className: 'hri-plan-number', 'aria-hidden': true }, item.alternate ? `A${index + 1}` : String(index + 1).padStart(2, '0')),
    h('span', { className: 'hri-plan-copy' },
      (title || tags.length > 0 || changed) && h('span', { className: 'hri-plan-title' },
        title && h('strong', null, title),
        (tags.length > 0 || changed) && h('span', { className: 'hri-plan-tags' },
          tags.map((tag) => h('span', { key: tag }, tag)),
          changed && h('span', { className: 'hri-plan-changed' }, '已更换'))),
      h('span', { className: 'hri-plan-question' }, item.question)),
    h('span', { className: 'hri-plan-chevron', 'aria-hidden': true }, expanded ? '⌃' : '⌄')),
    h('div', { id: detailId, className: 'hri-plan-detail', hidden: !expanded },
      item.points.length
        ? h(React.Fragment, null, h('strong', null, '考察点'), h('ul', null, item.points.map((point, i) => h('li', { key: i }, point))))
        : h('p', null, '这道题没有额外的考察要点。')))
  }
  return h('section', { className: 'hri-card', 'data-hri-preparation': preparation ? 'true' : undefined, 'aria-label': '面试提纲' },
    h('div', { className: 'hri-top hri-setup-controls' }, h('h3', { className: 'hri-setup-title' }, '面试提纲'),
      refreshAction && h('div', { className: 'hri-plan-refresh' },
        refreshNotice && h('p', { className: 'hri-setup-message', role: 'status', 'data-hri-prep-notice': 'true' }, refreshNotice),
        refreshAction, directionAction)),
    !preparation && h('p', { className: 'hri-setup-message', style: { color: C.muted } }, '准备后可查看本场的主问和备选题。'),
    preparation && !matched && h('p', { className: 'hri-setup-message', role: 'status', style: { color: C.danger } },
      sourceStale ? '题库设置已变化，请重新准备' : '旧提纲不会用于本场，请重新准备'),
    preparation?.sourceDegraded && h('p', { className: 'hri-setup-message', 'data-hri-sources-degraded': 'true', role: 'status', style: { color: C.muted } }, '本地题库降级：部分内容没有载入，本次用通用题库继续'),
    matched && simulationsOnly && h('p', { className: 'hri-setup-message', 'data-hri-simulation-notice': 'true' },
      preparation.roleContextMissing ? '本场使用通用模拟情景。填写具体岗位方向或 JD 可以细化题目。' : '本场主问按岗位职责生成，均为模拟题。'),
    preparation && h('ol', { ref: listRef, className: 'hri-plan-list' },
      mainItems.map(row),
      alternates.length > 0 && h('li', { className: 'hri-plan-alternates' },
        h(Button, { 'aria-expanded': alternatesOpen, onClick: () => setAlternatesOpen(!alternatesOpen) },
          alternatesOpen ? '收起备选题' : `查看 ${alternates.length} 道备选${changedAlternates ? ` · ${changedAlternates} 道已更换` : ''}`)),
      alternates.map(row)))
}
function SetupView({ api, capabilities, onStarted, onMaterials, onRefresh, avatarEnabled, onAvatarEnabledChange, background = BACKGROUND_DEFAULT, onBackgroundChange = null, ctx = null }) {
  const [role, setRole] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef(null)
  const settingsTrigger = useRef(null)
  const settingsId = React.useId()
  useEffect(() => {
    let active = true
    api.materials?.().then((materials) => {
      if (active) setRole(planText(materials?.role, 100))
    }).catch(() => { if (active) setRole('') })
    return () => { active = false }
  }, [api])
  const openSettings = () => {
    const settings = settingsRef.current
    if (!settings) return
    settings.open = !settings.open
    if (!settings.open) return
    settings.scrollIntoView?.({ block: 'nearest' })
    settings.querySelector('summary')?.focus({ preventScroll: true })
  }
  const [options, setOptions] = useState({ mode: 'standard', persona: 'professional', durationMinutes: 30, inputMode: 'voice', asrProvider: 'auto', ttsProvider: 'auto', voice: capabilities?.ttsVoice || 'stella' }); const [busy, setBusy] = useState(false); const [previewBusy, setPreviewBusy] = useState(false); const [error, setError] = useState('')
  // —— DeepSeek API Key ——
  // apiKey 只是这一次渲染里的内存值：不写 localStorage、不进日志、不预填后端返回的任何 Key 文本。
  // 三条操作的 busy / error 各自独立，避免「保存中」把试听、引擎选择或页签一起锁死。
  const [apiKey, setApiKey] = useState(''); const [savedCredential, setSavedCredential] = useState(null)
  const [saveBusy, setSaveBusy] = useState(false); const [clearBusy, setClearBusy] = useState(false); const [testBusy, setTestBusy] = useState(false)
  const [keyError, setKeyError] = useState(''); const [keyNotice, setKeyNotice] = useState('')
  useEffect(() => { setSavedCredential(null) }, [capabilities?.deepSeekCredential])
  const previewAudio = useRef(null)
  const stopPreview = useCallback(() => {
    const element = previewAudio.current; previewAudio.current = null
    element?.pause?.(); if (element?.src?.startsWith('blob:')) URL.revokeObjectURL(element.src)
  }, [])
  useEffect(() => () => stopPreview(), [stopPreview])
  const update = (key, value) => setOptions((old) => ({ ...old, [key]: value }))
  // —— 面试提纲（本地准备）——
  // 旧 Host 没有这两个 RPC 时，包装后的方法是 undefined，于是准备按钮和提纲区整体不出现；
  // 开始按钮保持原来的「进入面试」，Host 继续按旧动态模式追问，不报错、不空转。
  const canPrepare = typeof api?.prepareInterview === 'function'
  const canRecall = typeof api?.latestPreparation === 'function'
  const [preparation, setPreparation] = useState(null)
  const [prepBusy, setPrepBusy] = useState(false)
  const [prepError, setPrepError] = useState('')
  const [changedQuestionKeys, setChangedQuestionKeys] = useState(null)
  const [directionNotice, setDirectionNotice] = useState('')
  // prepSeq 是「提纲代际」：初挂载、时长切换、重新准备共用一条序号，只有最后一次发起的结果能落地，
  // 所以 A=30 的迟到响应不会盖掉用户正在看的 B=15；卸载时代际 +1，任何迟到结果都不回写。
  const prepSeq = useRef(0)
  const prepLive = useRef(true)
  const prepInFlight = useRef(false)
  const prepToken = useRef(0)
  // start 同理：同步锁挡双击，startSeq 挡迟到结果，卸载后不再 onStarted。
  const startSeq = useRef(0)
  const startInFlight = useRef(false)
  const startLive = useRef(true)
  // —— 本地 msy 题库目录（可选）——
  // 只有 Host 真的提供了这两个 RPC 时才显示设置卡；旧 Host 缺 RPC 时整块安静消失，
  // 准备与开始照旧。目录只在输入框里出现，不写 localStorage、不进 preparation / start options。
  const canSourceLoad = typeof api?.sourceSettings === 'function'
  const canSourceSave = typeof api?.saveSourceSettings === 'function'
  // 自动识别是 rc.25 才有的 RPC：旧 Host 没有它，这两颗按钮就不出现，其余控件照旧。
  const canSourceDetect = typeof api?.detectMsySource === 'function'
  const sourceReady = canSourceLoad || canSourceSave
  const [sourceSettings, setSourceSettings] = useState(null)
  const [sourceDir, setSourceDir] = useState('')
  // 路径收进高级设置：默认只给名字、启停和统计，避免新手面对一个裸路径输入框。
  const [sourceAdvanced, setSourceAdvanced] = useState(false)
  // '' / 'save' / 'clear' / 'detect' / 'pick'：同一时刻只允许一个动作，按钮文案跟着它走。
  const [sourceBusy, setSourceBusy] = useState('')
  const [sourceNotice, setSourceNotice] = useState('')
  const [sourceError, setSourceError] = useState('')
  // 用户动过输入框之后，迟到的读取结果不许把正在敲的路径覆盖掉。
  const sourceTouched = useRef(false)
  const sourceSeq = useRef(0)
  const sourceToken = useRef(0)
  const sourceInFlight = useRef(false)
  // 选目录是一次异步等待（人可能在对话框里待很久）：单独一把锁，别把保存/识别也一起卡住。
  const pickInFlight = useRef(false)
  const sourceLive = useRef(true)
  useEffect(() => () => {
    prepLive.current = false; startLive.current = false
    prepSeq.current += 1; startSeq.current += 1
    sourceLive.current = false; sourceSeq.current += 1
  }, [])
  const loadSourceSettings = useCallback(async () => {
    if (typeof api?.sourceSettings !== 'function') return
    const seq = (sourceSeq.current += 1)
    try {
      const value = await api.sourceSettings()
      if (!sourceLive.current || seq !== sourceSeq.current) return
      const next = sourceShape(value)
      setSourceSettings(next)
      if (!sourceTouched.current) setSourceDir(next ? next.msyDir : '')
    } catch {
      // 读不到设置就只是「这页不显示题库开关状态」：不弹错，也不挡准备和开始。
      if (!sourceLive.current || seq !== sourceSeq.current) return
      setSourceSettings(null)
    }
  }, [api])
  useEffect(() => { if (canSourceLoad) loadSourceSettings() }, [canSourceLoad, loadSourceSettings])
  // 保存与清除走同一个 RPC：同步锁挡双击，seq/token 挡迟到结果，卸载后不再回写。
  const saveSource = async (msyDir, action) => {
    if (!canSourceSave || sourceInFlight.current) return
    sourceInFlight.current = true
    const token = (sourceToken.current += 1)
    const seq = (sourceSeq.current += 1)
    setSourceBusy(action); setSourceError(''); setSourceNotice('')
    try {
      const next = sourceShape(await api.saveSourceSettings({ msyDir }))
      if (!sourceLive.current || seq !== sourceSeq.current) return
      setSourceSettings(next)
      sourceTouched.current = false
      setSourceDir(next ? next.msyDir : '')
      setSourceNotice(action === 'disable'
        ? '已停用本地题库，本场只用内置精选题'
        : action === 'clear' ? '已清除本地题库目录' : next?.configured ? '已保存本地题库目录' : '已关闭本地题库')
    } catch (e) {
      if (!sourceLive.current || seq !== sourceSeq.current) return
      setSourceError(`题库设置保存失败：${errorText(e)}`)
    } finally {
      if (sourceLive.current && token === sourceToken.current) { sourceInFlight.current = false; setSourceBusy('') }
    }
  }
  // 自动识别 / 重新扫描：都由用户点按钮触发，绝不在挂载或输入时偷偷扫盘。
  // Host 扫完会自己保存，这里只把结果搬进界面（题量统计一起刷新）。
  const detectSource = async (label) => {
    if (!canSourceDetect || sourceInFlight.current) return
    sourceInFlight.current = true
    const token = (sourceToken.current += 1)
    const seq = (sourceSeq.current += 1)
    setSourceBusy('detect'); setSourceError(''); setSourceNotice('')
    try {
      const next = sourceShape(await api.detectMsySource())
      if (!sourceLive.current || seq !== sourceSeq.current) return
      setSourceSettings(next)
      sourceTouched.current = false
      setSourceDir(next ? next.msyDir : '')
      setSourceNotice(next?.configured ? `${label}完成：已启用本地题库` : `没有找到可用的本地题库，仍只用内置精选题`)
    } catch (e) {
      if (!sourceLive.current || seq !== sourceSeq.current) return
      // 底层错误（路径、EACCES、栈）一律不进界面：只说哪个动作失败了、下一步怎么办。
      setSourceError(`${label}失败：没能读到可用的题库，请确认目录可读，或更换题库目录后重试`)
    } finally {
      if (sourceLive.current && token === sourceToken.current) { sourceInFlight.current = false; setSourceBusy('') }
    }
  }
  // 「选择题库」：先问宿主注入的选择器，再退到 uiWorkspace.pickDirectory。
  // 取消（null）什么都不改；两处都没有接口就明说去高级设置手填，不静默失败。
  const chooseSourceDir = async () => {
    if (!canSourceSave || sourceInFlight.current || pickInFlight.current) return
    pickInFlight.current = true
    setSourceBusy('pick'); setSourceError(''); setSourceNotice('')
    let picked
    try {
      picked = await pickDirectoryVia(ctx)
    } catch (e) {
      if (sourceLive.current) { setSourceError(`打开目录选择失败：${errorText(e)}`); setSourceBusy('') }
      pickInFlight.current = false
      return
    }
    pickInFlight.current = false
    if (!sourceLive.current) return
    setSourceBusy('')
    if (picked === PICKER_UNAVAILABLE) {
      setSourceAdvanced(true)
      setSourceError('当前环境不支持目录选择，请在下面的高级设置里填写题库目录')
      return
    }
    if (picked === null || picked === undefined) return
    const dir = typeof picked === 'string' ? picked : typeof picked?.path === 'string' ? picked.path : ''
    if (!String(dir).trim()) return
    await saveSource(String(dir).trim(), 'save')
  }
  const recallPreparation = useCallback(async (durationMinutes) => {
    if (typeof api?.latestPreparation !== 'function') return
    const seq = (prepSeq.current += 1)
    setChangedQuestionKeys(null)
    setDirectionNotice('')
    try {
      const value = await api.latestPreparation({ durationMinutes })
      if (!prepLive.current || seq !== prepSeq.current) return
      setPreparation(preparationShape(value))
    } catch {
      // 旧 Host / RPC 不可用 / 读取失败都只是「这一场没有现成提纲」：不弹错，也不挡开始。
      if (!prepLive.current || seq !== prepSeq.current) return
      setPreparation(null)
    }
  }, [api])
  // 初挂载读一次；时长一变按新时长再读，旧时长的迟到结果由 prepSeq 丢弃。
  useEffect(() => { if (canRecall) recallPreparation(options.durationMinutes) }, [canRecall, options.durationMinutes, recallPreparation])
  const prepare = async (action) => {
    if (!canPrepare || prepInFlight.current) return
    prepInFlight.current = true
    const token = (prepToken.current += 1)
    const seq = (prepSeq.current += 1)
    const durationMinutes = options.durationMinutes
    // 点下去那一刻的「这批题」：只有当前这份是匹配状态时，才按「换一批」比对题目是否真的变了。
    const previous = preparation
    const refreshing = action === 'questions' && matchedPreparation
    const changingDirections = action === 'directions' && matchedPreparation
    setPrepBusy(true); setPrepError(''); setChangedQuestionKeys(null); setDirectionNotice('')
    try {
      const value = await api.prepareInterview({ durationMinutes, refresh: !changingDirections && Boolean(preparation),
        ...(changingDirections ? { changeDirections: true } : {}) })
      if (!prepLive.current || seq !== prepSeq.current) return
      const next = preparationShape(value)
      const changes = refreshing && previous && next ? changedPlanKeys(previous, next) : null
      setPreparation(changes?.size === 0 ? previous : next)
      setChangedQuestionKeys(changes)
      if (changingDirections && value?.directionRefresh) {
        const changed = value.directionRefresh.changed
        setDirectionNotice(changed > 0 ? `已换 ${changed} 个考察方向` : '当前岗位和 JD 没有可替换的考察方向，已保留提纲')
      }
    } catch (e) {
      if (!prepLive.current || seq !== prepSeq.current) return
      setPrepError(errorText(e))
    } finally {
      // busy 只由最近一次点击释放；重渲染不会让按钮卡在「准备中」。
      if (prepLive.current && token === prepToken.current) { prepInFlight.current = false; setPrepBusy(false) }
    }
  }
  // 只有 Host 说资料匹配、且提纲时长与本场一致时才认这份提纲。
  // 题库设置变过（preparation 记的版本 != 当前设置版本）也不认：那份提纲里的 msy 题目已经不是现在的题库。
  // 旧 preparation 没有 sourceSettingsUpdatedAt（rc.23）时按匹配处理 —— 没有版本可比，不能凭空判过期。
  const settingsStamp = sourceSettings ? sourceSettings.updatedAt || '' : null
  const sourceStale = Boolean(preparation && settingsStamp !== null && preparation.sourceSettingsStamp !== undefined && preparation.sourceSettingsStamp !== settingsStamp)
  const matchedPreparation = Boolean(!sourceStale && preparation && preparation.profileMatches === true && preparation.durationMinutes === options.durationMinutes)
  const start = async (usePreparation) => {
    if (startInFlight.current) return
    startInFlight.current = true
    const seq = (startSeq.current += 1)
    // 不匹配就明确不携带 preparationId（不是传 null）：Host 收到才继续旧动态模式。
    const payload = usePreparation && matchedPreparation ? { ...options, preparationId: preparation.preparationId } : { ...options }
    setBusy(true); setError('')
    try {
      const next = await api.start(payload)
      // 卸载或已被新的 start 取代：旧结果既不 onStarted，也不会覆盖场上那一场。
      if (!startLive.current || seq !== startSeq.current) return
      onStarted(next)
    } catch (e) {
      if (startLive.current && seq === startSeq.current) setError(errorText(e))
    } finally {
      if (startLive.current && seq === startSeq.current) { startInFlight.current = false; setBusy(false) }
    }
  }
  const playPreviewBlob = useCallback(async (result) => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0))], { type: result.mimeType || 'audio/wav' }))
    const element = new Audio(url); previewAudio.current = element
    element.onended = () => { URL.revokeObjectURL(url); if (previewAudio.current === element) previewAudio.current = null }
    try {
      await element.play()
    } catch (e) {
      // 播放被拒（无音频设备 / 自动播放策略）时立刻释放 blob URL，别把引用挂着。
      URL.revokeObjectURL(url)
      if (previewAudio.current === element) previewAudio.current = null
      throw e
    }
  }, [])
  const preview = async () => {
    setPreviewBusy(true); setError('')
    try {
      stopPreview()
      if (options.ttsProvider === 'browser' || (options.ttsProvider === 'auto' && !capabilities?.ttsConfigured)) {
        if (!browserTtsAvailable()) throw new Error('当前浏览器没有可用中文朗读')
        window.speechSynthesis.cancel(); const utterance = new window.SpeechSynthesisUtterance('你好，我是你的模拟面试官。请放松，我们会根据你的回答继续追问。'); utterance.lang = 'zh-CN'; utterance.rate = 0.95; window.speechSynthesis.speak(utterance)
      } else {
        await playPreviewBlob(await api.previewVoice(options.voice, options.ttsProvider))
      }
    } catch (e) { setError(errorText(e)) } finally { setPreviewBusy(false) }
  }
  const credentialApiReady = typeof api?.saveApiKey === 'function' || typeof api?.clearApiKey === 'function' || Boolean(capabilities?.deepSeekCredential)
  const credential = savedCredential || credentialShape(capabilities?.deepSeekCredential) || (credentialApiReady ? { configured: false, source: null, writable: false } : null)
  const keyStatus = !credential ? '' : credential.configured ? `已配置（${sourceLabel(credential.source)}）` : '未配置'
  // 只有「已配置 + 可写」才允许清除；启动环境变量里的 Key 属于运行环境，插件里既不改也不抹。
  const canClear = Boolean(credential && credential.configured && credential.writable)
  const keyReadOnly = Boolean(credential && credential.source === 'env')
  const keyReadOnlyHint = '启动环境变量只读，请在启动 DSH 的环境中修改'
  const credentialUnavailable = Boolean(credential && !credential.configured && credential.source === null && !credential.writable)
  const refreshCapabilities = async () => { try { await onRefresh?.() } catch { /* 状态刷新失败不该盖掉刚拿到的结果 */ } }
  const saveKey = async () => {
    if (saveBusy) return
    const value = apiKey.trim()
    setKeyNotice(''); setKeyError('')
    if (!value) { setKeyError('请输入 API Key'); return }
    if (keyReadOnly) { setKeyError(keyReadOnlyHint); return }
    setSaveBusy(true)
    try {
      const next = credentialShape(await api.saveApiKey(value))
      if (next) setSavedCredential(next)
      setApiKey('')
      setKeyNotice('Key 已保存')
      await refreshCapabilities()
    } catch (e) {
      // 失败时保留输入框里的 Key，并且不刷新 capabilities —— 状态不能假装已经变了。
      setKeyError(`保存失败：${keyErrorText(e, value)}`)
    } finally { setSaveBusy(false) }
  }
  const clearKey = async () => {
    if (clearBusy) return
    setKeyNotice(''); setKeyError(''); setClearBusy(true)
    try {
      const next = credentialShape(await api.clearApiKey())
      if (next) setSavedCredential(next)
      setApiKey('')
      setKeyNotice('已清除保存的 Key')
      await refreshCapabilities()
    } catch (e) { setKeyError(`清除失败：${keyErrorText(e)}`) } finally { setClearBusy(false) }
  }
  // 只由「测试连接」的点击触发：一次点击调一次 previewVoice(voice,'deepseek')，不做任何自动试听。
  const testKey = async () => {
    if (testBusy) return
    setTestBusy(true); setKeyNotice(''); setKeyError('')
    try {
      stopPreview()
      const result = await api.previewVoice(options.voice, 'deepseek')
      setKeyNotice('连接成功，正在播放试听音频')
      await playPreviewBlob(result)
    } catch (e) { setKeyError(`连接失败：${keyErrorText(e, apiKey.trim())}`) } finally { setTestBusy(false) }
  }
  const ready = capabilities?.configured
  // 「HR 虚拟背景」只在 Host 真的给了合法背景列表时才出现，不能凭空多出一项设置。
  const backgroundOptions = backgroundChoices(capabilities?.backgrounds)
  // 下拉显示的就是「实际会画的那一个」：当前值不在白名单里（没给 office / 非法 id）就显示「关闭背景」，
  // 与 stage 上「查不到 id 就不画背景」的行为保持一致。
  const backgroundValue = backgroundOptions.some((item) => item.id === background) ? background : BACKGROUND_OFF
  const preparationState = prepBusy ? 'busy' : matchedPreparation ? 'ready' : preparation ? 'stale' : 'empty'
  const preparationStatus = { busy: '正在核对岗位题库与公开资料', ready: '提纲已就绪', stale: '提纲待更新', empty: '提纲未准备' }[preparationState]
  const prepareButton = (label, primary = false, action) => h(Button, {
    primary, className: primary ? 'hri-setup-primary' : undefined,
    disabled: prepBusy || busy, onClick: () => prepare(action), 'data-hri-prepare': 'true',
  }, prepBusy ? '准备中…' : label)
  const startButton = (withOutline, primary) => h(Button, {
    primary, className: primary ? 'hri-setup-primary' : undefined,
    disabled: busy || !ready || (withOutline && prepBusy),
    'data-hri-start': withOutline ? 'prepared' : 'dynamic',
    onClick: () => start(withOutline),
    'aria-label': !withOutline && canPrepare ? '直接进入面试，不使用提纲' : undefined,
  }, busy ? '正在入场…' : withOutline ? '使用提纲进入面试' : '进入面试')
  const mainAction = matchedPreparation ? startButton(true, true)
    : canPrepare ? prepareButton(preparation ? '重新准备' : '准备面试', true)
      : startButton(false, true)
  const showDynamicStart = canPrepare && !matchedPreparation && !capabilities?.roleDutyPreparation
  const interviewSettings = h('fieldset', null, h('legend', null, '面试与语音'),
    backgroundOptions.length > 0 && Field('HR 虚拟背景', h('select', { className: 'hri-input', value: backgroundValue, onChange: (event) => onBackgroundChange?.(event.target.value) }, backgroundOptions.map((item) => h('option', { key: item.id, value: item.id }, item.label)), h('option', { value: BACKGROUND_OFF }, '关闭背景'))),
    Field('面试方式', h('select', { className: 'hri-input', value: options.mode, onChange: (e) => update('mode', e.target.value) }, h('option', { value: 'standard' }, '标准模拟'), h('option', { value: 'pressure' }, '压力面'))),
    Field('回答方式', h('select', { className: 'hri-input', value: options.inputMode, onChange: (e) => update('inputMode', e.target.value) }, h('option', { value: 'voice' }, '语音回答（识别后自动提交）'), h('option', { value: 'text' }, '文字回答'))),
    Field('语音识别', h('select', { className: 'hri-input', value: options.asrProvider, onChange: (e) => update('asrProvider', e.target.value) }, h('option', { value: 'auto' }, '自动选择'), h('option', { value: 'deepseek', disabled: !capabilities?.deepSeekAsrConfigured }, 'DeepSeek ASR'), h('option', { value: 'local', disabled: !capabilities?.localAsrReady }, 'DSH 本地 SenseVoice'), h('option', { value: 'http', disabled: !capabilities?.httpAsrConfigured }, '通用 HTTP ASR'))),
    Field('HR 朗读', h('select', { className: 'hri-input', value: options.ttsProvider, onChange: (e) => update('ttsProvider', e.target.value) }, h('option', { value: 'auto' }, '自动选择'), h('option', { value: 'deepseek', disabled: !capabilities?.deepSeekTtsConfigured }, 'DeepSeek 中文语音'), h('option', { value: 'browser', disabled: !browserTtsAvailable() }, '浏览器中文语音'), h('option', { value: 'http', disabled: !capabilities?.httpTtsConfigured }, '通用 HTTP TTS'))),
    Field('HR 音色（DeepSeek）', h('select', { className: 'hri-input', value: options.voice, onChange: (e) => update('voice', e.target.value) }, h('option', { value: 'stella' }, '海星 · 女声'), h('option', { value: 'tide' }, '暗潮 · 男声'))),
    h('div', { className: 'hri-controls', style: { marginBottom: 14 } }, h(Button, { disabled: previewBusy, onClick: preview }, previewBusy ? '正在合成试听…' : '试听 HR 声音'), h('span', { style: { color: C.muted, fontSize: 12 } }, '使用当前选择的朗读引擎；海星/暗潮音色用于 DeepSeek')), 
    Field('时长', h('select', { className: 'hri-input', value: options.durationMinutes, onChange: (e) => update('durationMinutes', Number(e.target.value)) }, h('option', { value: 15 }, '15 分钟 · 4 个主问题'), h('option', { value: 30 }, '30 分钟 · 6 个主问题'))))
  const serviceSettings = h('fieldset', null, h('legend', null, '运行条件'), h('p', null, `模型：${ready ? '已配置' : '未配置'}`), h('p', null, `DeepSeek ASR：${capabilities?.deepSeekAsrConfigured ? '已就绪' : '缺少 API Key'}`), h('p', null, `DeepSeek TTS：${capabilities?.deepSeekTtsConfigured ? '已就绪' : '缺少 API Key'}`), credential && h('div', { style: { borderTop: `1px solid ${C.border}`, margin: '10px 0 12px', paddingTop: 12 } },
      h('div', { className: 'hri-top', style: { marginBottom: 6 } }, h('strong', null, 'DeepSeek API Key 设置'), h('span', { style: { color: credential.configured ? C.success : C.muted, fontSize: 12 } }, keyStatus)),
      Field('DeepSeek API Key', h('input', { className: 'hri-input', type: 'password', value: apiKey, autoComplete: 'off', spellCheck: false, maxLength: 512, readOnly: keyReadOnly, placeholder: '由 DSH 凭据服务保存，不会显示或回填完整 Key', onChange: (event) => setApiKey(event.target.value) })),
      h('div', { className: 'hri-controls', style: { marginBottom: 8 } }, h(Button, { primary: true, disabled: saveBusy || keyReadOnly, onClick: saveKey }, saveBusy ? '保存中…' : '保存 Key'), h(Button, { disabled: clearBusy || !canClear, onClick: clearKey }, clearBusy ? '清除中…' : '清除已保存 Key'), h(Button, { disabled: testBusy, onClick: testKey }, testBusy ? '正在测试…' : '测试连接')),
      keyReadOnly && h('p', { style: { margin: '0 0 6px', color: C.muted, fontSize: 12 } }, keyReadOnlyHint),
      credentialUnavailable && h('p', { style: { margin: '0 0 6px', color: C.muted, fontSize: 12 } }, '凭据服务未连接或状态尚未读取；可重试保存，或刷新页面重试'),
      keyNotice && h('p', { role: 'status', style: { margin: '0 0 6px', color: C.success, fontSize: 12 } }, keyNotice), keyError && h('p', { role: 'alert', style: { margin: '0 0 6px', color: C.danger, fontSize: 12 } }, keyError)), h('p', null, `本地 ASR：${capabilities?.localAsrReady ? '已就绪' : capabilities?.asrPreparation ? `待准备（${capabilities.asrPreparation}）` : '未就绪'}`), h('p', null, `浏览器朗读：${browserTtsAvailable() ? '可用' : '不可用'}`), h('p', { style: { color: C.muted, fontSize: 13 } }, '选择 DeepSeek 识别时，录音会上传至 DeepSeek；默认不保存原始音频。TTS 失败会自动尝试浏览器朗读。'))
  const bankSettings = sourceReady && h('fieldset', { 'data-hri-source-settings': 'true', 'aria-label': '本地题库设置', style: { gridColumn: '1 / -1' } },
      h('legend', null, '本地题库'),
      h('div', { className: 'hri-top' },
        h('strong', null, sourceSettings?.displayName || SOURCE_NAME_FALLBACK),
        h('span', { role: 'status', 'data-hri-source-status': 'true', style: { color: C.muted, fontSize: 12 } }, !sourceSettings ? '状态未读取' : sourceSettings.configured ? '已启用' : '未启用')),
      h('p', { style: { margin: '6px 0 10px', color: C.muted, fontSize: 12 } }, '只读取本机已下载的题库，不上传、不联网；停用后只用内置精选题。'),
      sourceSettings?.configured && h('p', { 'data-hri-source-stats': 'true', style: { margin: '0 0 10px', color: C.muted, fontSize: 12 } },
        `题量：岗位题 ${sourceSettings.summary.agentQuestions} · 简历深挖 ${sourceSettings.summary.resumeQuestions}`),
      h('div', { className: 'hri-controls', style: { marginBottom: 8 } },
        h(Button, { disabled: !canSourceSave || Boolean(sourceBusy), 'data-hri-source-pick': 'true', onClick: chooseSourceDir }, sourceBusy === 'pick' ? '正在选择…' : '选择题库'),
        canSourceDetect && !sourceSettings?.configured && h(Button, { primary: true, disabled: Boolean(sourceBusy), 'data-hri-source-detect': 'true', onClick: () => detectSource('自动识别') }, sourceBusy === 'detect' ? '识别中…' : '自动识别'),
        canSourceDetect && sourceSettings?.configured && h(Button, { primary: true, disabled: Boolean(sourceBusy), 'data-hri-source-detect': 'true', onClick: () => detectSource('重新扫描') }, sourceBusy === 'detect' ? '扫描中…' : '重新扫描'),
        sourceSettings?.configured && h(Button, { disabled: !canSourceSave || Boolean(sourceBusy), 'data-hri-source-disable': 'true', onClick: () => saveSource('', 'disable') }, sourceBusy === 'clear' ? '停用中…' : '停用')),
      h('div', { className: 'hri-controls', style: { marginBottom: 8 } },
        h(Button, { 'data-hri-source-advanced': 'true', onClick: () => setSourceAdvanced((value) => !value) }, sourceAdvanced ? '收起高级设置' : '高级设置')),
      sourceAdvanced && h('div', { 'data-hri-source-advanced-body': 'true' },
        Field('题库目录', h('input', { className: 'hri-input', type: 'text', 'data-hri-source-dir': 'true', value: sourceDir, placeholder: '本地题库根目录，例如 D:/work/msy（留空=关闭）', autoComplete: 'off', spellCheck: false, maxLength: 1024, onChange: (event) => { sourceTouched.current = true; setSourceDir(event.target.value) } })),
        h('div', { className: 'hri-controls', style: { marginBottom: 6 } },
          h(Button, { primary: true, disabled: !canSourceSave || Boolean(sourceBusy), onClick: () => saveSource(sourceDir.trim(), 'save') }, sourceBusy === 'save' ? '保存中…' : '保存目录'),
          h(Button, { disabled: !canSourceSave || Boolean(sourceBusy), onClick: () => saveSource('', 'clear') }, sourceBusy === 'clear' ? '清除中…' : '清除'))),
      sourceNotice && h('p', { role: 'status', style: { margin: '0 0 6px', color: C.success, fontSize: 12 } }, sourceNotice),
      sourceError && h('p', { role: 'alert', style: { margin: '0 0 6px', color: C.danger, fontSize: 12 } }, sourceError))
  const summary = h('section', { className: 'hri-card hri-setup-aside' },
    h('div', { className: 'hri-setup-summary' },
      h('h3', { className: 'hri-setup-title' }, '本场安排'),
      h('strong', { className: 'hri-setup-duration' }, options.durationMinutes, h('small', null, ' 分钟')),
      matchedPreparation && h('p', null, `${preparation.main} 道主问 · ${preparation.alternates} 道备选`),
      h('p', null, `${options.inputMode === 'voice' ? '语音回答' : '文字回答'} · ${options.mode === 'pressure' ? '压力面' : '标准模拟'}`)),
    h('div', { className: 'hri-setup-aside-actions' },
      h('button', {
        type: 'button', style: button(), className: 'hri-setup-link', ref: settingsTrigger,
        'aria-expanded': settingsOpen, 'aria-controls': settingsId, onClick: openSettings,
      }, '本场设置'),
      h(Button, { className: 'hri-setup-material', onClick: onMaterials,
        style: { background: 'transparent', color: C.accent, borderColor: 'transparent' } }, '先检查材料')),
    h('section', { className: 'hri-setup-interviewer', 'aria-label': '面试官预览' },
      h(HRMark, { avatar: capabilities?.avatar, enabled: Boolean(avatarEnabled) }),
      capabilities?.avatar?.kind === 'live2d' && h('label', { className: 'hri-interviewer-toggle' },
        h('input', { type: 'checkbox', checked: Boolean(avatarEnabled), onChange: (event) => onAvatarEnabledChange?.(event.target.checked) }),
        h('span', null, '启用 Live2D 面试官（实验，首次加载约 60 MB）'))))
  return h(StudioPage, { className: 'hri-setup' },
    h('header', { className: 'hri-studio-head hri-setup-head' },
      h('div', { className: 'hri-top' },
        h('div', null, h('h2', null, '面试准备'), h('p', { className: 'hri-setup-role' }, role || '请先检查岗位与材料')),
        h('div', { className: 'hri-controls hri-setup-controls hri-setup-actions' },
          (canPrepare || preparation) && h('span', { className: 'hri-setup-status', 'data-state': preparationState, role: 'status' },
            matchedPreparation && !prepBusy && h('span', { 'aria-hidden': true }, '✓'), preparationStatus),
          mainAction)),
      (showDynamicStart || (capabilities && !ready)) && h('div', { className: 'hri-controls hri-setup-controls', style: { marginTop: 10 } },
        showDynamicStart && startButton(false, false),
        capabilities && !ready && h('span', { className: 'hri-setup-note' }, '配置模型后可进入面试。')),
      prepError && h('p', { className: 'hri-setup-message', role: 'alert', style: { color: C.danger } }, prepError),
      error && h('p', { className: 'hri-setup-message', role: 'alert', style: { color: C.danger } }, error)),
    h('div', { className: 'hri-setup-layout' },
      summary,
      (canPrepare || preparation) && h(PreparationOutline, { preparation, matched: matchedPreparation, sourceStale,
        changedKeys: matchedPreparation ? changedQuestionKeys : null,
        directionNotice: matchedPreparation ? directionNotice : '',
        refreshAction: canPrepare && matchedPreparation ? prepareButton('换一批题', false, 'questions') : null,
        directionAction: canPrepare && matchedPreparation && preparation.dutyPlan ? prepareButton('换考察方向', false, 'directions') : null })),
    h('details', { className: 'hri-card hri-setup-settings', id: settingsId, ref: settingsRef, 'data-hri-setup-settings': 'true',
      onToggle: (event) => setSettingsOpen(event.currentTarget.open) },
      h('summary', { onClick: () => settingsTrigger.current?.focus() }, '设置与运行条件'),
      h('div', { className: 'hri-grid hri-setup-settings-grid' }, interviewSettings, serviceSettings, bankSettings)))
}
function InterviewView({ api, bundle, capabilities, onBundle, onExit, avatarEnabled, background = BACKGROUND_DEFAULT, backgrounds = null }) {
  const { session, turns } = bundle; const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [recording, setRecording] = useState(false); const [seconds, setSeconds] = useState(0); const [recognizing, setRecognizing] = useState(false); const [speaking, setSpeaking] = useState(false); const [ttsDegraded, setTtsDegraded] = useState(false); const [autoplayNotice, setAutoplayNotice] = useState(false)
  const recorder = useRef(null); const chunks = useRef([]); const stream = useRef(null); const audio = useRef(null); const spokenTurn = useRef(null); const startedAt = useRef(0); const ttsFallback = useRef(0); const playRequest = useRef(0)
  const [pressureReaction, setPressureReaction] = useState('')
  const [pressureGesture, setPressureGesture] = useState('')
  const pressureMode = isPressureInterview(session)
  const cancelPressureBeat = useRef(null)
  // 录音相位（同步 ref，不是 state）：idle → starting（等授权）→ recording → submitting（识别 + 提交）。
  // 空格、按钮、110 秒收尾、暂停、退出、卸载全都排在这一个相位上，所以一次录音最多 stop 一次、最多提交一次；
  // cycle 每开始/中止一次 +1，旧的 getUserMedia / transcribe / onstop 回调凭 cycle 判定自己过期 —— 过期只关轨道，不提交。
  const phase = useRef('idle'); const cycle = useRef(0); const cycleSession = useRef(session.sessionId); const activeSession = useRef(session.sessionId)
  const submitting = useRef(false); const live = useRef(true); const spaceHeld = useRef(false); const canRecordRef = useRef(false)
  const roomRef = useRef(null)
  const roomScrollRef = useRef(null)
  useEffect(() => {
    // 从准备页或其他场次进来时，宿主面板可能还保留旧页面的滚动位置。
    const room = roomRef.current
    if (!room) return
    room.scrollTop = 0
    const panel = room.closest('.dsh-hr-interview')
    if (panel) panel.scrollTop = 0
    if (roomScrollRef.current) roomScrollRef.current.scrollTop = 0
  }, [session.sessionId])
  // 左屏口型：lipLevelRef 由 InterviewView 持有并递给 HRMark（渲染端只读 current，不走 setState）。
  // driver 本身不建 AudioContext，真正接线发生在 TTS 播放那一刻；卸载时 dispose 一次性收干净。
  const lipLevelRef = useRef(0)
  const lipDriver = useMemo(() => createLipDriver(lipLevelRef), [])
  const waiting = session.status === 'waiting_for_answer'
  const active = ['waiting_for_answer', 'generating_question', 'processing_answer', 'error', 'paused'].includes(session.status)
  const stagePressureGesture = pressureMode && active && session.pressureBlackFace === true ? 'black-face' : pressureGesture
  const desktopLocation = typeof window === 'undefined' ? null : window.location
  const windowsCamera = capabilities?.windowsCamera === true && desktopLocation?.protocol === 'dsh-app:' && desktopLocation.hostname === 'app'
    && typeof api.openWindowsCamera === 'function'
  const localCamera = windowsCamera && capabilities?.localCamera === true
    && typeof api.startLocalCamera === 'function' && typeof api.stopLocalCamera === 'function'
  const asrReady = session.asrProvider === 'deepseek' ? capabilities?.deepSeekAsrConfigured : session.asrProvider === 'local' ? capabilities?.localAsrReady : session.asrProvider === 'http' ? capabilities?.httpAsrConfigured : capabilities?.asrConfigured
  const asrUnavailable = Boolean(capabilities && !asrReady)
  // 停止录音并释放轨道：卸载、暂停、退出、取消授权都走这一个出口，重复调用安全（cycle 一变，旧回调全部作废）。
  const releaseMedia = useCallback(() => { cycle.current += 1; phase.current = 'idle'; try { if (recorder.current?.state === 'recording') recorder.current.stop() } catch {} recorder.current = null; stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; chunks.current = []; if (live.current) { setRecording(false); setRecognizing(false); setSeconds(0) } }, [])
  useEffect(() => () => { live.current = false; playRequest.current += 1; cancelPressureBeat.current?.(); releaseMedia(); audio.current?.pause?.(); window.speechSynthesis?.cancel(); if (audio.current?.src?.startsWith('blob:')) URL.revokeObjectURL(audio.current.src); lipDriver.dispose() }, [releaseMedia, lipDriver])
  useEffect(() => { activeSession.current = session.sessionId }, [session.sessionId])
  // 兜底：只要这一题已经不再等回答（Host 侧换题 / 进入处理中 / 暂停 / 出错 / 完成），
  // 正在录的这一段必须立刻停轨作废，不给任何 Host 状态路径留下把旧音频提交到下一题的机会。
  useEffect(() => { if (!waiting) releaseMedia() }, [waiting, releaseMedia])
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 500); return () => clearInterval(timer) }, [recording])
  const ttsReady = capabilities?.ttsConfigured || capabilities?.deepSeekTtsConfigured || capabilities?.httpTtsConfigured || browserTtsAvailable()
  // 停止/退出/切题都走这里：口型与语音必须一起停，且重复调用安全（stop 幂等）。
  const endDelivery = useCallback(() => { lipDriver.stop(); setSpeaking(false); setPressureReaction(''); setPressureGesture('') }, [lipDriver])
  const stopPlayback = useCallback(() => { playRequest.current += 1; cancelPressureBeat.current?.(); audio.current?.pause?.(); if (audio.current?.src?.startsWith('blob:')) URL.revokeObjectURL(audio.current.src); audio.current = null; window.speechSynthesis?.cancel(); endDelivery() }, [endDelivery])
  const playBrowser = useCallback((value, request = playRequest.current, delivery = null) => {
    if (!browserTtsAvailable()) { endDelivery(); setError('HR 语音不可用，可继续文字阅读'); return }
    window.speechSynthesis.cancel(); const utterance = new window.SpeechSynthesisUtterance(String(value)); utterance.lang = 'zh-CN'; utterance.rate = delivery?.rate ?? 0.95
    if (delivery) utterance.pitch = delivery.pitch
    // speechSynthesis 没有可分析的音频流：这里写的是确定性节奏包络（简化口型），不是真实振幅。
    // 只有「这次仍然是当前播放请求」时才允许收口型/改状态 —— 旧 utterance 的回调（A 播到一半 B 开始、
    // stopPlayback 自己 cancel）一律不许碰新播放的 driver 与 speaking。
    const current = () => request === playRequest.current
    utterance.onend = () => { if (current()) endDelivery() }
    utterance.onerror = (event) => {
      if (!current()) return
      endDelivery()
      // interrupted / canceled 是「我们主动停的」或浏览器正常换代：不是故障，不该弹错误。
      const reason = String(event?.error || '').toLowerCase()
      if (reason === 'interrupted' || reason === 'canceled') return
      setError('浏览器 HR 语音播放失败，可继续文字阅读')
    }
    lipDriver.startSynthetic(); window.speechSynthesis.speak(utterance)
  }, [lipDriver, endDelivery])
  const play = useCallback(async (turn, force = false) => {
    const { text: value, id: turnId, pressureCue: cue, pressureFocus } = turn
    if (!ttsReady || (speaking && !force) || !turnId) return
    const request = ++playRequest.current; const provider = session.ttsProvider || 'auto'
    const hostRequested = provider === 'deepseek' || provider === 'http' || (provider === 'auto' && capabilities?.ttsConfigured)
    const coolingDown = Date.now() < ttsFallback.current
    const useHost = hostRequested && !coolingDown
    const delivery = pressureMode && hasOwn(PRESSURE_DELIVERY, cue) ? PRESSURE_DELIVERY[cue] : null
    let beatPlayed = false
    const stagePressureBeat = () => {
      if (request !== playRequest.current) return false
      setPressureReaction(cue)
      setPressureGesture(pressureFocus === 'evidence' ? 'doubt' : '')
      if (beatPlayed || !delivery.delay) return true
      beatPlayed = true
      return new Promise((resolve) => {
        const endBreath = cue === 'sigh' ? playPressureBreath() : null
        const finish = (continuePlayback) => {
          clearTimeout(timer)
          endBreath?.()
          if (cancelPressureBeat.current === cancel) cancelPressureBeat.current = null
          resolve(continuePlayback && request === playRequest.current)
        }
        const cancel = () => finish(false)
        const timer = setTimeout(() => finish(true), delivery.delay)
        cancelPressureBeat.current = cancel
      })
    }
    if (!hostRequested || !coolingDown) { ttsFallback.current = 0; setTtsDegraded(false) }
    setSpeaking(true); setError('')
    try {
      if (useHost) {
        const result = await api.speak(session.sessionId, turnId)
        if (request !== playRequest.current) return
        if (delivery && !(await stagePressureBeat())) return
        ttsFallback.current = 0; setTtsDegraded(false); setAutoplayNotice(false)
        audio.current?.pause?.(); if (audio.current?.src?.startsWith('blob:')) URL.revokeObjectURL(audio.current.src)
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0))], { type: result.mimeType })); const element = new Audio(url); audio.current = element
        if (delivery) element.playbackRate = delivery.rate
        // element 的回调也要认「自己还是不是当前请求」：旧元素晚到的 ended/error 不许停掉新播放的
        // 口型、也不许把新播放的 speaking 改回 false；但自己的 blob URL 无论新旧都必须释放。
        const mine = () => request === playRequest.current
        element.onended = () => { if (mine()) endDelivery(); URL.revokeObjectURL(url) }
        element.onerror = () => { if (mine()) { endDelivery(); setError('HR 语音播放失败，可继续文字阅读') } URL.revokeObjectURL(url) }
        // 真实振幅只在这条路径上拿得到：MediaElementSource → Analyser → destination，音频照旧出声。
        // 接线失败（无 AudioContext / 建图异常）时 driver 自己退成简化口型，不阻断下面的 play()。
        lipDriver.startAudio(element)
        await element.play()
      } else if (!delivery || (await stagePressureBeat())) playBrowser(value, request, delivery)
    } catch (e) {
      if (request !== playRequest.current) return
      const failedAudio = audio.current
      failedAudio?.pause?.(); if (failedAudio?.src?.startsWith('blob:')) URL.revokeObjectURL(failedAudio.src)
      if (failedAudio) audio.current = null
      // 自动播放被拒/云端失败都不许留下 RAF 与 AudioContext；旧请求的口型也在这里一起收掉。
      lipDriver.stop()
      if (autoplayBlocked(e)) {
        setTtsDegraded(false); setAutoplayNotice(true)
        if (browserTtsAvailable()) { setError('浏览器阻止自动播放，已改用本机语音'); if (!delivery || (await stagePressureBeat())) playBrowser(value, request, delivery) }
        else { endDelivery(); setError('浏览器阻止自动播放，可点击「播放语音」重试') }
      } else if (browserTtsAvailable()) { ttsFallback.current = Date.now() + 60000; setTtsDegraded(true); setAutoplayNotice(false); setError(`云端 HR 朗读失败，已切换浏览器语音：${errorText(e)}`); if (!delivery || (await stagePressureBeat())) playBrowser(value, request, delivery) }
      else { endDelivery(); setError(errorText(e)) }
    }
  }, [api, capabilities?.ttsConfigured, ttsReady, speaking, session.sessionId, session.ttsProvider, pressureMode, playBrowser, ttsDegraded, lipDriver, endDelivery])
  const lastHr = [...turns].reverse().find((turn) => turn.speaker === 'hr' && ['main_question', 'followup'].includes(turn.kind))
  // 只有「轮到你回答」的活场次才自动开口：打开 completed / evaluating / reviewing / paused 等
  // 历史复盘页时既不该突然出声，也不该为此产生云端 TTS 费用。逐条的「播放语音」按钮不受影响。
  const autoReadable = session.status === 'waiting_for_answer'
  useEffect(() => { if (!autoReadable) return; if (lastHr && spokenTurn.current !== lastHr.id) { spokenTurn.current = lastHr.id; stopPlayback(); play(lastHr, true) } }, [autoReadable, lastHr?.id, play, stopPlayback])
  const refreshAfterError = useCallback(async () => { try { onBundle(await api.get(session.sessionId)) } catch {} }, [api, session.sessionId, onBundle])
  // 一次回答只提交一次：submitting 是同步锁，busy 只是给按钮与文案的镜像。
  const submitAnswer = useCallback(async (value, delivery) => {
    const answer = String(value || '').trim()
    if (!answer) { setError('回答是空的，请再说一次，或用下方文字输入'); return false }
    if (submitting.current) return false
    submitting.current = true; setBusy(true); setError('')
    try {
      const next = await api.submitText(session.sessionId, answer, delivery)
      if (live.current) { onBundle(next); setText((current) => (current.trim() === answer ? '' : current)) }
      return true
    } catch (e) {
      if (live.current) { setError(errorText(e)); await refreshAfterError() }
      return false
    } finally { submitting.current = false; if (live.current) setBusy(false) }
  }, [api, session.sessionId, onBundle, refreshAfterError])
  // 文字兜底：语音场用文字提交与原来一致，会让本场不再算「全程口头」。
  // 录音（starting/recording）、识别中、提交中一律不执行文字提交：一题只能有一个来源的回答，
  // 否则「语音草稿 + 文字草稿」会双答。识别失败回到 idle 后文字自然恢复。
  const submitTypedText = () => {
    if (phase.current !== 'idle' || recognizing || busy || submitting.current) return Promise.resolve(false)
    return submitAnswer(text, { usedFallback: session.inputMode === 'voice' })
  }
  // 切换式录音的唯一终点：相位先同步推到 submitting / idle，再停 MediaRecorder。
  // 之后重复的空格、按钮、暂停、退出、110 秒收尾都只会命中 return false —— 一次录音最多识别一次、提交一次。
  const stopRecording = useCallback(() => {
    if (phase.current === 'starting') { cycle.current += 1; phase.current = 'idle'; if (live.current) { setRecording(false); setSeconds(0) }; return true }
    if (phase.current !== 'recording') return false
    phase.current = 'submitting'
    if (live.current) setRecording(false)
    const instance = recorder.current
    // MediaRecorder 已经不在了 / 已经 inactive：不会再有 onstop，直接作废这一段，别把相位卡死在 submitting。
    if (!instance || instance.state === 'inactive') { releaseMedia(); if (live.current) setError('录音已停止，请再按一次空格重说'); return true }
    try { instance.stop() } catch { releaseMedia(); if (live.current) setError('录音已停止，请再按一次空格重说') }
    return true
  }, [releaseMedia])
  useEffect(() => { if (recording && seconds >= 110) stopRecording() }, [recording, seconds, stopRecording])
  useEffect(() => () => stopPlayback(), [stopPlayback])
  // 失焦 / 切窗口：正在录的这一段不留半空中（切换式录音已不依赖 pointer capture），直接释放轨道并作废这段，
  // 不把半截音频送识别；用户回来再按一次空格即可重说。
  useEffect(() => { const onBlur = () => { if (phase.current !== 'starting' && phase.current !== 'recording') return; releaseMedia(); if (live.current) setError('窗口失焦，本次录音已取消，请再按一次空格重说') }; window.addEventListener('blur', onBlur); return () => window.removeEventListener('blur', onBlur) }, [releaseMedia])
  // 开始录音：一次按键就够 —— getUserMedia 授权一完成自动进录音，不再要求按第二次。
  // 入口同时同步检查 submitting / busy：文字提交刚置忙、canRecordRef 的 effect 还没跑的那一瞬间也不许起录。
  const startRecording = async () => {
    if (!live.current || phase.current !== 'idle' || !canRecordRef.current || submitting.current || busy) return false
    cycle.current += 1; const tick = cycle.current; cycleSession.current = session.sessionId
    phase.current = 'starting'; startedAt.current = Date.now()
    setError(''); setRecognizing(false); setRecording(true); setSeconds(0); stopPlayback()
    let media = null
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      // 这一段在等授权时已被取消（再按一次空格 / 暂停 / 退出 / 卸载）：只关轨道，不进录音、不提交。
      if (tick !== cycle.current || !live.current) { media.getTracks().forEach((track) => track.stop()); return false }
      stream.current = media
      const recorderInstance = new MediaRecorder(media); recorder.current = recorderInstance; chunks.current = []
      recorderInstance.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data) }
      recorderInstance.onstop = async () => {
        const answerDurationMs = Math.max(0, Date.now() - startedAt.current)
        const parts = chunks.current; chunks.current = []
        const blob = parts.length ? new Blob(parts, { type: recorderInstance.mimeType || 'audio/webm' }) : null
        recorder.current = null; media.getTracks().forEach((track) => track.stop()); if (stream.current === media) stream.current = null
        // 过期回合（暂停 / 退出 / 卸载 / 已换场次）只清资源，绝不识别、绝不提交。
        const stale = () => tick !== cycle.current || !live.current || cycleSession.current !== activeSession.current
        if (stale()) return
        if (!blob || !blob.size) { phase.current = 'idle'; setRecording(false); setRecognizing(false); setError('没有录到声音，请再按一次空格重说'); return }
        setRecording(false); setRecognizing(true)
        try {
          const outgoing = session.asrProvider !== 'http' ? await canonicalAudio(blob) : blob
          if (stale()) return
          const dataUrl = await blobToDataUrl(outgoing)
          const transcript = await api.transcribe(session.sessionId, { audioBase64: String(dataUrl).split(',')[1], mimeType: outgoing.type || 'audio/wav', durationMs: answerDurationMs })
          if (stale()) return
          // 识别成功就当场提交一次（带 asr 元数据，Host 侧算口头回答）；正文只进 Host，面试页不回显。
          const ok = await submitAnswer(transcript.text, { asrModel: transcript.model, asrRequestId: transcript.requestId, asrDurationMs: transcript.durationMs, answerDurationMs, usedFallback: false })
          if (!ok && live.current) setError((current) => current || '识别结果为空，请再说一次，或用下方文字输入')
        } catch (e) { if (!stale()) { setError(`${errorText(e)}；请再说一次，或用下方文字继续`); await refreshAfterError() } }
        finally { if (tick === cycle.current) phase.current = 'idle'; if (live.current) setRecognizing(false) }
      }
      startedAt.current = Date.now(); recorderInstance.start(250)
      phase.current = 'recording'; setSeconds(0); setRecording(true)
      return true
    } catch (e) {
      media?.getTracks().forEach((track) => track.stop()); if (stream.current === media) stream.current = null
      if (live.current) { phase.current = 'idle'; setRecording(false); setRecognizing(false); setSeconds(0); setError(`麦克风不可用：${errorText(e)}；可用文字降级`) }
      return false
    }
  }
  // 切换：按一下开始，再按一下结束（识别 + 自动提交在 onstop 里）。
  const toggleRecording = () => (phase.current === 'idle' ? startRecording() : stopRecording())
  // 空格监听只挂一次（下面 deps 为空），所以走 ref 拿最新的 toggle，避免闭包读到旧一轮的 session / api。
  const toggleRef = useRef(toggleRecording)
  useEffect(() => { toggleRef.current = toggleRecording })
  // 能不能起录只有这一个判定：语音场 + 正在等回答 + ASR 可用 + 不忙。空格和页面按钮共用它。
  const canRecord = session.inputMode === 'voice' && waiting && !asrUnavailable
  useEffect(() => { canRecordRef.current = Boolean(canRecord) && !busy }, [canRecord, busy])
  // 空格：切换式（按一下开始、再按一下结束），不要求按住。
  // - keydown.repeat / isComposing / keyCode 229（IME 组字）一律忽略，长按与中文输入不会重复触发；
  // - 焦点在 input / textarea / select / contenteditable 里时完全不碰空格，文字回答里的空格照旧输入；
  // - 用 spaceHeld 兜一次「keyup 丢了」的重复 keydown；真正的重复提交由 phase 状态机挡住。
  useEffect(() => {
    const editable = (target) => {
      if (!target || target.nodeType !== 1) return false
      const tag = String(target.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'summary') return true
      // 已聚焦的其他按钮保留原生空格点击，尤其是摄像头和会话控制。
      if (tag === 'button' && !target.hasAttribute('data-hri-voice-toggle')) return true
      if (target.isContentEditable) return true
      return Boolean(target.closest?.('[contenteditable=""],[contenteditable="true"]'))
    }
    const isSpace = (event) => event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar'
    const onKeyDown = (event) => {
      if (!isSpace(event)) return
      if (event.repeat || event.isComposing || event.keyCode === 229) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (editable(event.target)) return
      // 既没在录音、也没法起录：空格交还给页面（滚动/按钮默认行为）
      if (phase.current === 'idle' && !canRecordRef.current) return
      event.preventDefault()
      if (spaceHeld.current) return
      spaceHeld.current = true
      void toggleRef.current?.()
    }
    const onKeyUp = (event) => {
      if (!isSpace(event)) return
      spaceHeld.current = false
      if (editable(event.target)) return
      if (phase.current !== 'idle') event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); spaceHeld.current = false }
  }, [])
  // 任何「这一题不再等回答 / 换题 / 重试」的控制路径都必须先作废正在录的这一段：
  // 暂停、结束复盘、跳过本题、重试都停轨并清相位，避免旧音频被识别后提交到下一题。
  const control = async (action) => {
    setBusy(true); setError('')
    if (['pause', 'finish', 'end'].includes(action)) { stopPlayback(); releaseMedia() }
    else if (['skip', 'retry'].includes(action)) { if (pressureMode) stopPlayback(); releaseMedia() }
    try { onBundle(await api.control(session.sessionId, action)) }
    catch (e) { setError(errorText(e)); await refreshAfterError() }
    finally { setBusy(false) }
  }
  const exit = async () => { releaseMedia(); stopPlayback(); try { await api.control(session.sessionId, 'cancel') } catch {} onExit() }
  const retryEvaluation = async () => { setBusy(true); try { onBundle(await api.evaluate(session.sessionId)) } catch (e) { setError(errorText(e)); await refreshAfterError() } finally { setBusy(false) } }
  const voiceMode = session.inputMode === 'voice'
  const currentQuestion = waiting && turns.at(-1) === lastHr ? lastHr : null
  const currentBasisLabel = questionBasisLabel(currentQuestion?.questionBasis)
  const recordedTurns = currentQuestion ? turns.slice(0, -1) : turns
  const questionCount = Number(session.mainQuestionCount) || 0
  const questionBudget = Number(session.questionBudget) || 0
  const modeLabel = session.mode === 'drill' ? '专项回炉' : pressureMode ? '压力面' : '标准模拟'
  const turnLabels = { main_question: '主问', followup: '追问', wrap_up: '面试结束' }
  const replay = (turn) => ttsReady && h(Button, {
    style: { padding: '4px 8px', fontSize: 12 }, disabled: speaking, onClick: () => play(turn),
  }, '播放语音')
  const typedAnswer = h('textarea', {
    className: 'hri-input', rows: 2, value: text, 'data-hri-input': 'true', 'aria-label': '文字回答',
    disabled: !waiting || busy || recording || recognizing, onChange: (e) => setText(e.target.value),
    placeholder: voiceMode ? '可在这里继续用文字作答' : '输入你的回答',
  })
  const submitTextButton = h(Button, {
    primary: !voiceMode || asrUnavailable, disabled: !waiting || busy || !text.trim() || recording || recognizing,
    onClick: () => submitTypedText(), 'data-hri-submit-text': 'true',
  }, busy ? '处理中…' : voiceMode ? '用文字继续' : '提交回答')
  const voiceControls = voiceMode && h('div', { className: 'hri-controls' },
    h(Button, {
      primary: true, 'data-hri-voice-toggle': 'true', 'aria-pressed': recording ? 'true' : 'false',
      'aria-label': recording ? '结束并提交（空格）' : '开始回答（空格）',
      title: '按一下开始，再按一下结束；空格同样切换',
      disabled: (!canRecord && !recording) || recognizing || busy, onClick: () => { void toggleRecording() },
      onKeyDown: (e) => { if (e.code === 'Space' || e.key === ' ') e.preventDefault() },
      onKeyUp: (e) => { if (e.code === 'Space' || e.key === ' ') e.preventDefault() },
      style: { userSelect: 'none', ...(recording ? { background: C.danger, border: `1px solid ${C.danger}` } : null) },
    }, recording ? `结束并提交（空格） · ${seconds}s` : '开始回答（空格）'),
    recognizing && h('span', { className: 'hri-studio-meta', role: 'status', 'data-hri-voice-status': 'true' }, '正在识别并提交…'),
    h('span', { className: 'hri-studio-meta', style: seconds >= 100 ? { color: C.danger } : undefined },
      asrUnavailable ? capabilities?.asrPreparation ? '本地语音识别待准备，可先用文字作答' : '语音识别未配置，可用文字作答'
        : session.asrProvider === 'deepseek' ? '录音发送至 DeepSeek 转写，默认不落盘 · 110 秒自动收尾' : '录音仅用于转写，默认不落盘 · 110 秒自动收尾'))
  const voiceFallback = voiceMode && h('div', { className: 'hri-room-text' },
    h('p', { className: 'hri-studio-meta' }, '本场使用文字后，将标记为包含文字回答。'),
    typedAnswer, h('div', { className: 'hri-controls' }, submitTextButton))
  return h(StudioPage, { className: 'hri-session hri-room', rootRef: roomRef },
    h('header', { className: 'hri-top hri-room-head' },
      h('div', null,
        h('h2', null, active ? '面试进行中' : '面试记录'),
        h('p', { className: 'hri-studio-meta' }, modeLabel)),
      h('div', { className: 'hri-room-progress' },
        questionBudget > 0 && h(React.Fragment, null,
          h('span', { className: 'hri-studio-meta' }, `主问 ${questionCount} / ${questionBudget}`),
          h('progress', { 'aria-label': '主问题进度', value: questionCount, max: questionBudget })),
        h('span', { className: 'hri-room-status', role: 'status' }, statusText[session.status] || session.status))),
    currentQuestion && h('section', { className: 'hri-room-question', 'aria-label': '当前问题', 'aria-live': 'polite' },
      h('div', { className: 'hri-top' },
        h('h3', null, (currentQuestion.kind === 'followup' ? '当前追问' : '当前问题') + (currentBasisLabel ? ` · ${currentBasisLabel}` : '')), replay(currentQuestion)),
      h('p', null, currentQuestion.text)),
    h('div', { className: 'hri-room-scroll', ref: roomScrollRef },
      h('section', { className: 'hri-card hri-session-head' },
        h('div', { className: 'hri-stage-grid' },
          h('div', { className: 'hri-stage hri-stage-hr' },
            h(HRMark, { variant: 'stage', speaking, performanceState: performanceStateFor(speaking, session.status), lipLevelRef, pressureReaction, pressureMode, pressureGesture: stagePressureGesture, avatar: capabilities?.avatar, enabled: avatarEnabled, paused: session.status === 'paused', background, backgrounds }),
            h('span', { className: 'hri-stage-label' }, 'HR 面试官'),
            h('span', { className: 'hri-stage-badge' }, session.status === 'paused' ? '已暂停' : speaking ? '正在提问' : '待机中')),
          h('div', { className: 'hri-stage hri-stage-candidate' },
            h('div', { className: 'hri-stage-panel' }, h(CandidateCamera, {
              paused: session.status === 'paused', active, framed: false,
              openWindowsCamera: windowsCamera ? () => api.openWindowsCamera(session.sessionId) : null,
              startLocalCamera: localCamera ? () => api.startLocalCamera(session.sessionId) : null,
              stopLocalCamera: localCamera ? (token) => api.stopLocalCamera(session.sessionId, token) : null,
            })))),
        h('p', { className: 'hri-stage-note' }, '视频不上传 · 不做表情评分')),
      h('section', { className: 'hri-card hri-transcript' },
        h('h3', { className: 'hri-studio-title' }, '面试记录'),
        h('div', { className: 'hri-log', role: 'log', 'aria-live': 'polite' },
          recordedTurns.length === 0 && h('p', { className: 'hri-studio-meta' }, '回答后，本场记录会显示在这里。'),
          recordedTurns.map((turn) => {
            const isHr = turn.speaker === 'hr'
            const asrTurn = !isHr && Boolean(turn.asrMeta)
            return h('div', { key: turn.id, className: `hri-turn ${isHr ? 'hri-hr' : 'hri-candidate'}`,
              'data-hri-speaker': isHr ? 'hr' : 'candidate', 'data-hri-asr': asrTurn ? 'true' : 'false' },
              h('div', { className: 'hri-meta' }, isHr ? ['HR', turnLabels[turn.kind] || '面试官', questionBasisLabel(turn.questionBasis)].filter(Boolean).join(' · ') : asrTurn ? '你 · 语音' : `你 · ${turn.deliveryMeta?.transcriptCharCount || 0} 字`),
              asrTurn ? h('span', { className: 'hri-asr-done', style: { color: C.muted } }, '语音回答 · 已提交') : turn.text,
              isHr && ttsReady && h('div', { style: { marginTop: 6 } }, replay(turn)))
          })))),
    h('section', { className: 'hri-card hri-room-dock', 'aria-label': '作答与面试操作' },
      active && h('div', { className: 'hri-compose' },
        voiceControls,
        voiceMode ? (asrUnavailable ? voiceFallback : h('details', { className: 'hri-room-fallback' },
          h('summary', null, '改用文字回答'), voiceFallback)) : typedAnswer),
      h('div', { className: 'hri-actions', role: 'toolbar', 'aria-label': '面试操作' },
        active && !voiceMode && submitTextButton,
        speaking && h(Button, { onClick: stopPlayback }, '停止朗读'),
        active && h(Button, { disabled: !waiting || busy, onClick: () => control('skip') }, '跳过本题'),
        active && (session.status === 'paused' ? h(Button, { onClick: () => control('resume') }, '继续') : h(Button, { disabled: busy, onClick: () => control('pause') }, '暂停')),
        ['error', 'generating_question', 'processing_answer'].includes(session.status) && h(Button, { onClick: () => control('retry') }, '重试 HR 响应'),
        ['review_pending', 'evaluating'].includes(session.status) && h(Button, { primary: true, onClick: retryEvaluation }, '重试复盘'),
        active && h(Button, { disabled: busy, onClick: () => control('end') }, '直接结束'),
        active && h(Button, { disabled: busy, onClick: () => control('finish') }, '结束并复盘'),
        h(Button, { onClick: exit }, '返回场次列表')),
      h('div', { className: 'hri-session-foot' },
        ttsDegraded && h('p', { style: { color: C.accent } }, '所选云端语音暂时不可用，已临时改用浏览器朗读；冷却结束后自动重试。'),
        autoplayNotice && h('p', { style: { color: C.accent } }, '浏览器阻止了自动朗读，已改用本机语音；点「播放语音」可再试所选云端语音。'),
        error && h('p', { role: 'alert', 'data-hri-error': 'true', style: { color: C.danger } }, error))))
}
const REVIEW_DIMENSIONS = { relevance: '岗位相关性', accuracy: '回答准确性', evidence: '事实与案例', structure: '回答结构', expression: '表达清晰度', consistency: '口径一致性', presence: '临场表现' }
const reviewList = (value) => Array.isArray(value) ? value : []
const reviewAnswer = (turn) => turn?.speaker === 'candidate' && turn.kind !== 'no_answer' && typeof turn.text === 'string' && Boolean(turn.text.trim())
function ReviewEvidence({ turns, label }) {
  if (!turns.length) return null
  return h('details', { className: 'hri-review-evidence' }, h('summary', null, `${label}（${turns.length}）`),
    turns.map((turn, index) => h('blockquote', { key: turn.id || index },
      h('small', { className: 'hri-meta' }, turn.speaker === 'candidate' ? '你的回答' : turn.kind === 'followup' ? '面试官追问' : '面试官提问'),
      h('div', null, turn.text))))
}

function EvaluationView({ evaluation, turns }) {
  const priorities = reviewList(evaluation.priorities)
  const dimensions = reviewList(evaluation.dimensions)
  const consistencyIssues = reviewList(evaluation.consistencyIssues)
  const byTurnId = new Map(turns.map((turn) => [turn.id, turn]))
  const questionGroups = new Map()
  for (const turn of turns) {
    if (!turn.questionId || turn.speaker !== 'hr' || !['main_question', 'followup'].includes(turn.kind)) continue
    const group = questionGroups.get(turn.questionId) || { prompt: '', followups: [] }
    if (turn.kind === 'main_question') group.prompt = turn.text
    else group.followups.push(turn)
    questionGroups.set(turn.questionId, group)
  }
  const reviews = new Map()
  for (const item of reviewList(evaluation.questionReviews)) {
    if (!item || !item.questionId || reviews.has(item.questionId)) continue
    reviews.set(item.questionId, item)
  }
  const questionIds = [...new Set([...questionGroups.keys(), ...reviews.keys()])]
  const score = evaluation.overallScore
  const performance = evaluation.performance
  const latency = performance?.latencyCount > 0 ? `回答处理耗时 P75 ${performance.latencyP75Ms} ms · P95 ${performance.latencyP95Ms} ms` : ''
  return h(React.Fragment, null,
    h('div', { className: priorities.length ? 'hri-review-overview' : undefined },
      h('section', { className: 'hri-card hri-review-summary' },
        h('div', { className: 'hri-review-summary-head' }, h('h3', { className: 'hri-studio-title' }, '本场结论'),
          Number.isFinite(score) && h('strong', { className: 'hri-review-score', 'aria-label': `综合得分 ${score} 分，满分 100 分` }, score, h('small', { 'aria-hidden': 'true' }, ' / 100'))),
        h('p', null, evaluation.summary || '本场已生成复盘。'),
        latency && h('p', { className: 'hri-studio-meta' }, latency)),
      priorities.length > 0 && h('section', { className: 'hri-card hri-review-priorities' },
        h('h3', { className: 'hri-studio-title' }, '下次优先练习'),
        h('ol', null, priorities.map((item, index) => h('li', { key: index }, item))))),
    dimensions.length > 0 && h('section', { className: 'hri-card' },
      h('h3', { className: 'hri-studio-title' }, '分项表现'),
      h('div', { className: 'hri-score hri-review-dimensions' }, dimensions.map((item) => {
        const label = REVIEW_DIMENSIONS[item.key] || item.key
        const scored = item.evaluated && Number.isFinite(item.score)
        const evidence = reviewList(item.evidenceTurnIds).map((id) => byTurnId.get(id)).filter((turn) => turn?.text)
        return h('article', { className: 'hri-review-dimension', key: item.key },
          h('div', { className: 'hri-top' }, h('strong', null, label), h('b', null, scored ? `${item.score} 分` : '未评估')),
          scored && h('meter', { min: 0, max: 100, value: item.score, 'aria-label': `${label}得分` }),
          item.diagnosis && h('p', null, item.diagnosis),
          item.improvement && h('p', { className: 'hri-studio-meta' }, item.improvement),
          h(ReviewEvidence, { turns: evidence, label: '查看评估依据' }))
      }))),
    questionIds.length > 0 && h('section', { className: 'hri-card' },
      h('h3', { className: 'hri-studio-title' }, '逐题复盘'),
      h('div', { className: 'hri-review-question-list' }, questionIds.map((id, index) => {
        const item = reviews.get(id) || {}
        const group = questionGroups.get(id)
        const answers = turns.filter((turn) => turn.questionId === id && reviewAnswer(turn))
        const recorded = new Set([...answers, ...(group?.followups || [])])
        const evidence = turns.filter((turn) => recorded.has(turn))
        const issues = reviewList(item.issues)
        return h('details', { key: id, className: 'hri-review-question' },
          h('summary', null, h('strong', null, `第 ${index + 1} 题`), group?.prompt ? `　${group.prompt}` : ''),
          h('div', null,
            issues.length > 0 && h('section', null, h('h4', null, '改进要点'), h('ul', null, issues.map((issue, issueIndex) => h('li', { key: issueIndex }, issue)))),
            item.rewrite && h('section', null, h('h4', null, '参考回答'), h('p', null, item.rewrite)),
            item.drill && h('section', null, h('h4', null, '再练一次'), h('p', null, item.drill)),
            h(ReviewEvidence, { turns: evidence, label: '查看原回答与追问' }),
            !evidence.length && !issues.length && !item.rewrite && !item.drill && h('p', { className: 'hri-studio-meta' }, '本题暂无回答与评语。')))
      }))),
    consistencyIssues.length > 0 && h('section', { className: 'hri-card' },
      h('h3', { className: 'hri-studio-title' }, '口径一致性'),
      consistencyIssues.map((item, index) => h('div', { key: index }, item.claim && h('p', null, h('strong', null, item.claim)),
        item.recommendation && h('p', null, item.recommendation)))))
}
// —— 复盘独立视图（rc.22）——
// 复盘不再追加在面试页下面，而是与「面试记录」并列的第二个视图。判定只用 bundle 上已有的信息
// （evaluation 是否到位 + session.status / session.evaluationStatus），不新增任何 RPC 或 Host 语义。
const REVIEW_TERMINAL = ['review_pending', 'evaluating', 'reviewing', 'completed']
const reviewState = (bundle) => {
  if (!bundle || !bundle.session) return 'none'
  if (bundle.evaluation) return 'ready'
  const session = bundle.session
  if (session.evaluationStatus === 'no_content') return 'no_content'
  if (session.status === 'review_pending') return 'review_pending'
  if (session.status === 'evaluating') return 'evaluating'
  if (session.status === 'reviewing') return 'reviewing'
  if (session.status === 'completed' && session.evaluationStatus === 'not_requested') return 'not_requested'
  // completed 但仍 evaluationStatus=pending 是中间态：继续按「正在生成」处理，绝不把用户弹回记录页。
  // 只有连 evaluationStatus 都没有的旧场次（'lost'）才默认看记录。
  if (session.status === 'completed') return session.evaluationStatus === 'pending' ? 'evaluating' : 'lost'
  return 'none'
}
const hasReviewView = (bundle) => reviewState(bundle) !== 'none'
const opensOnReview = (bundle) => !['none', 'lost', 'not_requested'].includes(reviewState(bundle))
function ReviewView({ api, bundle, busy, error, onRetry, onRecord, onExit }) {
  const state = reviewState(bundle)
  const session = bundle?.session || {}
  const rootRef = useRef(null)
  // 每次切进报告（或复盘状态变化）都把滚动位置归零：首屏第一眼必须是「面试复盘」。
  useEffect(() => { const node = rootRef.current; if (!node) return; node.scrollTop = 0; node.setAttribute('data-hri-scroll', 'top') }, [state])
  const turns = reviewList(bundle?.turns)
  const answered = new Set(turns.filter(reviewAnswer).map((turn) => turn.questionId || turn.id)).size
  const canRetry = Boolean(api && typeof api.evaluate === 'function') && state !== 'ready' && state !== 'no_content'
    && (state !== 'not_requested' || answered > 0)
  const role = session.materialsSnapshot?.role || session.config?.role
  const meta = [role, answered > 0 ? `${answered} 道已答题` : '', bundle?.evaluation?.performance?.oralAcceptanceEligible === true ? '全程口头' : bundle?.evaluation?.performance?.oralAcceptanceEligible === false ? '含文字回答' : ''].filter(Boolean).join(' · ')
  const links = h('div', { className: 'hri-controls' },
    onRecord && h(Button, { onClick: onRecord }, '查看面试记录'),
    onExit && h(Button, { onClick: onExit }, '返回场次列表'))
  const failure = !busy && (error || (state === 'review_pending' ? session.lastError : ''))
  const status = failure ? ['error', '可重试', '复盘生成失败', '可以重新生成复盘，或先查看面试记录。']
    : busy || ['evaluating', 'reviewing'].includes(state) ? ['active', '生成中', '正在生成复盘', '正在分析本场问答，报告就绪后会在这里显示。']
      : state === 'no_content' ? ['neutral', '无有效回答', '没有有效回答，未生成复盘', '本场记录仍可查看。']
        : state === 'not_requested' ? ['neutral', '未生成', '本场尚未生成复盘', answered ? '可以按需生成本场报告。' : '本场暂无可用于复盘的回答。']
        : state === 'lost' ? ['neutral', '报告不可用', '这个场次没有可用的复盘文件', '可以重新生成，或先查看面试记录。']
          : ['neutral', '等待生成', '复盘等待生成', '点击重试复盘发起生成。']
  const [tone, label, headline, detail] = status
  return h(StudioPage, { className: 'hri-review', rootRef, 'data-hri-review': state },
    h('header', { className: 'hri-studio-head hri-review-header' },
      h('div', null, h('h2', null, '面试复盘'), meta && h('p', { className: 'hri-studio-meta' }, meta)), links),
    state === 'ready' ? h(EvaluationView, { evaluation: bundle.evaluation, turns }) : h('section', { className: 'hri-card hri-review-state', 'data-tone': tone, 'aria-label': '报告状态' },
      h('span', { className: 'hri-review-status', role: 'status' }, label), h('h3', { className: 'hri-studio-title' }, headline),
      h('p', { className: 'hri-studio-meta' }, detail),
      failure && h('p', { role: 'alert', className: 'hri-review-error' }, failure),
      canRetry && h('div', { className: 'hri-review-actions' },
        h(Button, { primary: true, disabled: busy, onClick: onRetry, 'data-hri-review-retry': 'true' },
          state === 'not_requested' && !failure ? (busy ? '正在生成…' : '生成复盘') : (busy ? '正在重试…' : '重试复盘')))))
}
const historyTones = {
  completed: 'ready', review_pending: 'due', evaluating: 'due', error: 'error',
  waiting_for_hr: 'active', generating_question: 'active', waiting_for_answer: 'active',
  processing_answer: 'active', reviewing: 'active',
}
function HistoryView({ data, onOpen, onDrill }) {
  const sessions = data?.sessions || []
  const knowledge = data?.knowledge || []
  const nowMs = Date.parse(data?.now || new Date().toISOString())
  return h(StudioPage, { className: 'hri-records' },
    h('header', { className: 'hri-studio-head' }, h('h2', null, '历史与回炉')),
    h('div', { className: 'hri-records-grid' },
      h('section', { className: 'hri-card' },
        h('div', { className: 'hri-records-title' },
          h('h3', { className: 'hri-studio-title' }, '历史场次'),
          sessions.length > 0 && h('span', { className: 'hri-studio-meta' }, `${sessions.length} 场`)),
        sessions.length === 0
          ? h('p', { className: 'hri-studio-meta' }, '还没有面试记录')
          : h('div', { className: 'hri-records-list' }, sessions.map((item) => {
            const inputMode = item.inputMode === 'voice' ? '语音' : item.inputMode === 'text' ? '文字' : item.inputMode
            const metadata = [`${item.mainQuestionCount} 道主问`, inputMode, new Date(item.createdAt).toLocaleString()].filter(Boolean).join(' · ')
            return h('button', { type: 'button', className: 'hri-history', key: item.sessionId, onClick: () => onOpen(item.sessionId) },
              h('span', { className: 'hri-record-copy' },
                h('strong', null, item.config?.role || item.role || '未命名岗位'),
                h('small', { className: 'hri-studio-meta' }, metadata)),
              h('span', { className: 'hri-record-actions' },
                h('span', { className: 'hri-record-badge', 'data-tone': historyTones[item.status] }, statusText[item.status] || item.status),
                h('span', { className: 'hri-record-chevron', 'aria-hidden': true }, '›')))
          }))),
      h('section', { className: 'hri-card' },
        h('div', { className: 'hri-records-title' }, h('h3', { className: 'hri-studio-title' }, '知识点回炉')),
        knowledge.length === 0
          ? h('p', { className: 'hri-studio-meta' }, '复盘后生成知识点与复查时间')
          : h('div', { className: 'hri-records-list' }, knowledge.slice(0, 30).map((item) => {
            const due = item.nextReviewAt && Date.parse(item.nextReviewAt) <= nowMs
            return h('div', { className: 'hri-knowledge', key: item.id },
              h('div', { className: 'hri-record-copy' },
                h('strong', null, item.title),
                h('small', { className: 'hri-studio-meta' }, `掌握度 ${item.mastery}/4 · ${item.nextReviewAt ? new Date(item.nextReviewAt).toLocaleString() : '暂不排程'}`)),
              (due || item.originSessionId) && h('div', { className: 'hri-record-actions' },
                due && h('span', { className: 'hri-record-badge', 'data-tone': 'due' }, '待回炉'),
                item.originSessionId && h(Button, { onClick: () => onDrill(item.originSessionId, item.id) }, '回炉')))
          })))))
}
function Panel({ api, startupError = '', ctx = null }) {
  const [tab, setTab] = useState('interview'); const [capabilities, setCapabilities] = useState(null); const [bundle, setBundle] = useState(null); const [history, setHistory] = useState(null); const [error, setError] = useState(startupError); const [avatarEnabled, setAvatarEnabled] = useState(false)
  // 虚拟背景是纯本地偏好：默认现代办公室，不落盘、不走 Host RPC；可选项始终取自 capabilities.backgrounds。
  const [background, setBackground] = useState(BACKGROUND_DEFAULT)
  // 视图（rc.22）：'record' = 面试记录，'report' = 复盘报告。两个视图互斥，不再同屏堆叠。
  const [view, setView] = useState('record')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState('')
  // 用户手动点过视图切换后，后续 refresh / onBundle 一律不再自动跳视图；换场次时复位。
  const viewPinned = useRef(false)
  // 用于判断「本次 onBundle 之前有没有复盘」：只有从无到有才自动进报告页。
  const bundleRef = useRef(null)
  // 每个 session 只自动展示一次复盘（Host 侧把 pending 刷成 ready 时不要反复抢用户的视图）。
  const autoShownRef = useRef('')
  // 打开场次的请求序号：快速连点 A→B 时，A 的迟到响应必须丢掉，不能覆盖 B。
  const openSeq = useRef(0)
  // 复盘重试的代际：换场次/退出会让上一代 attempt 的结果与 busy 清理一起作废。
  const reviewSeq = useRef(0)
  const refresh = useCallback(async () => { if (!api) return; try { const [caps, list] = await Promise.all([api.capabilities(), api.list()]); setCapabilities(caps); setHistory(list) } catch (e) { setError(errorText(e)) } }, [api])
  useEffect(() => { refresh() }, [refresh])
  // 打开历史场次：ready（已有复盘）默认落在报告视图；review_pending / evaluating / no_content 也默认落在
  // 报告视图，好让「等待中」和「没有有效回答」有明确说明，而不是一片空白。旧 completed 场次默认看记录。
  const open = async (id) => {
    const seq = openSeq.current + 1
    openSeq.current = seq
    setError(''); setReviewError('')
    // 换场次就把上一场次的「重试中」作废：increase 代际后，旧 evaluate 的 finally 不再碰 busy。
    reviewSeq.current += 1
    setReviewBusy(false)
    try {
      const next = await api.get(id)
      // 乱序保护：只有最后一次发起的 open 能落地（A→B 快速点击时 A 的响应到这里被丢弃）。
      if (seq !== openSeq.current) return
      viewPinned.current = false
      bundleRef.current = next
      autoShownRef.current = opensOnReview(next) ? String(next.session?.sessionId || '') : ''
      setBundle(next)
      setView(opensOnReview(next) ? 'report' : 'record')
      setTab('interview')
    } catch (e) { if (seq === openSeq.current) setError(errorText(e)) }
  }
  // 组件内部推上来的新 bundle（提交回答、重试复盘、结束面试……）：只认当前场次，且只有
  // 「同一场次 evaluation 从 null 变非 null」这一种情况才自动进报告页；每个场次只自动一次。
  const acceptBundle = useCallback((next) => {
    const previous = bundleRef.current
    const previousId = previous?.session?.sessionId
    // 只认当前场次：没有当前场次（用户已退出）或 id 不符（迟到响应）一律丢弃，
    // 否则「A 重试中退出」会把已经关掉的 A 重新拉回来。
    if (!previousId || previousId !== next?.session?.sessionId) return
    const arrivedReady = Boolean(next.evaluation)
    if (!viewPinned.current && !previous.evaluation && arrivedReady && autoShownRef.current !== String(next.session.sessionId)) {
      // 只有已经结束的场次才切视图：进行中切走会把还在跑的录音/摄像头组件直接卸载。
      if (REVIEW_TERMINAL.includes(next.session.status)) { autoShownRef.current = String(next.session.sessionId); setView('report') }
    }
    bundleRef.current = next
    setBundle(next)
  }, [])
  const reportState = reviewState(bundle)
  const pollingId = tab === 'interview' && view === 'report' && ['evaluating', 'reviewing'].includes(reportState) ? bundle.session.sessionId : null
  useEffect(() => {
    if (!pollingId || typeof api?.get !== 'function') return
    const seq = openSeq.current
    let stopped = false
    let timer
    const poll = async () => {
      try {
        const next = await api.get(pollingId)
        if (stopped || seq !== openSeq.current || !['evaluating', 'reviewing'].includes(reviewState(bundleRef.current))) return
        if (next?.session?.sessionId === pollingId && reviewState(next) !== reportState) {
          acceptBundle(next)
          return
        }
      } catch { /* A status read failing does not change the persisted report state. */ }
      if (!stopped && seq === openSeq.current) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 2500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [api, acceptBundle, pollingId, reportState])
  const chooseView = (next) => { viewPinned.current = true; setView(next) }
  // 复盘视图自己的重试入口：busy/disabled 由报告视图自己持有（InterviewView 此时可能都没挂载）。
  // 每次重试带 attempt 代际 + openSeq 快照：换场次/退出/新重试都会让旧 attempt 的结果整体作废。
  const retryReview = async () => {
    if (!api || !bundle || reviewBusy) return
    const requestedSessionId = bundle.session.sessionId
    const seq = openSeq.current
    const attempt = reviewSeq.current + 1
    reviewSeq.current = attempt
    setReviewBusy(true); setReviewError('')
    const stale = () => attempt !== reviewSeq.current || seq !== openSeq.current || bundleRef.current?.session?.sessionId !== requestedSessionId
    try {
      const next = await api.evaluate(requestedSessionId)
      // 等待期间用户可能退出或 open 了别的场次：这份结果属于旧场次，直接丢弃，
      // 不能 acceptBundle、不能 setView、也不能 refresh 去抢新场次的视图与列表。
      if (stale()) return
      acceptBundle(next)
      if (!viewPinned.current) setView('report')
      refresh()
    } catch (e) {
      if (!stale()) setReviewError(errorText(e))
    } finally {
      // 只有当前代际才释放 busy：A 的 finally 不许清掉 B 正在跑的重试。
      if (attempt === reviewSeq.current) setReviewBusy(false)
    }
  }
  const resetSessionView = () => {
    openSeq.current += 1
    reviewSeq.current += 1
    viewPinned.current = false
    autoShownRef.current = ''
    setReviewBusy(false); setReviewError(''); setView('record')
  }
  const exitSession = () => { resetSessionView(); bundleRef.current = null; setBundle(null); refresh() }
  const started = (next) => { resetSessionView(); bundleRef.current = next; setBundle(next); setTab('interview'); refresh() }
  const drill = async (id, knowledgePointId) => { try { started(await api.createDrill(id, knowledgePointId)) } catch (e) { setError(errorText(e)) } }
  const tabButton = (key, label) => h(Button, { key, primary: tab === key, onClick: () => { setTab(key); if (key === 'history') refresh() } }, label)
  return h('main', { className: 'dsh-hr-interview', style: { width: '100%', padding: 20, color: C.text, containerType: 'inline-size' } }, h('style', null, css), h('header', { className: 'hri-top', style: { marginBottom: 16 } }, h('div', null, h('h1', { style: { margin: 0, fontSize: 24 } }, 'HR 面试攻防'), h('p', { style: { color: C.muted, margin: '5px 0 0' } }, '模拟真实表达，复盘定位问题，隔场换问法回炉')), h('nav', { className: 'hri-tabs' }, tabButton('interview', '面试'), tabButton('materials', '材料'), tabButton('history', '历史与回炉'))), error && !bundle && h('p', { role: 'alert', style: { color: C.danger } }, error),
    // 内容容器：flex 列的伸缩项，锚在根容器剩余高度里；各页在它内部各自滚动/伸缩。
    // 复盘是独立视图：.hri-main 里要么是面试记录，要么是复盘报告；--report 只由当前 view 决定，
    // 不看 evaluation 是否存在（复盘数据到位但用户停在记录页时，容器仍按面试页布局）。
    h('div', { className: view === 'report' && hasReviewView(bundle) ? 'hri-main hri-main--report' : 'hri-main' }, !api ? h('section', { className: 'hri-card' }, 'Host 服务尚未连接，请检查插件加载日志。') : tab === 'materials' ? h(MaterialsView, { api, onSaved: refresh, roleDutyPreparation: capabilities?.roleDutyPreparation }) : tab === 'history' ? h(HistoryView, { api, data: history, onOpen: open, onDrill: drill }) : bundle ? h(React.Fragment, null,
      hasReviewView(bundle) && h('nav', { className: 'hri-tabs hri-view-tabs', 'aria-label': '面试视图' },
        h(Button, { primary: view === 'record', onClick: () => chooseView('record'), 'data-hri-view': 'record', 'aria-pressed': view === 'record' }, '面试记录'),
        h(Button, { primary: view === 'report', onClick: () => chooseView('report'), 'data-hri-view': 'report', 'aria-pressed': view === 'report' }, '复盘报告')),
      view === 'report' && hasReviewView(bundle)
        ? h(ReviewView, { api, bundle, busy: reviewBusy, error: reviewError, onRetry: retryReview, onRecord: () => chooseView('record'), onExit: () => { exitSession(); setTab('history') } })
        : h(InterviewView, { api, bundle, capabilities, avatarEnabled, background, backgrounds: capabilities?.backgrounds, onBundle: (next) => { acceptBundle(next); refresh() }, onExit: exitSession })) : h(SetupView, { api, capabilities, avatarEnabled, background, onBackgroundChange: setBackground, onAvatarEnabledChange: setAvatarEnabled, onStarted: started, onMaterials: () => setTab('materials'), onRefresh: refresh, ctx })))
}
function SidebarIcon(props) { return h('svg', { viewBox: '0 0 16 16', width: props?.size || 16, height: props?.size || 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, h('circle', { cx: 5, cy: 5, r: 2 }), h('path', { d: 'M2 12c0-2 1.2-3 3-3s3 1 3 3M9 4h5M9 7h5M10 10h4M10 13h4' })) }
function registerUi(ctx, api, startupError = '') {
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) => h(Panel, { ...props, api, startupError, ctx }))), 'hr-interview: main panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 45, locale: NS, label: () => ctx.locale.bind(NS)('title') }, SidebarIcon)), 'hr-interview: sidebar entry')
}
async function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'hr-interview: locale')
  try {
    if (!ctx.remote || typeof ctx.remote.$mount !== 'function') throw new TypeError('Remote service unavailable')
    await ctx.remote.$mount(HR_CLIENT_REMOTE)
    await ctx.inject(['remote.hrInterview'], (remoteCtx) => { const api = wrapRemoteApi(remoteCtx.remote.hrInterview); registerUi(remoteCtx, api); return () => {} })
  } catch (error) { console.error('[dsh-hr-interview] remote mount failed', error); registerUi(ctx, null, errorText(error)) }
}
module.exports = { apply, inject }
