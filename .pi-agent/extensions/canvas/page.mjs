// Session canvas page. Served by daemon.mjs at / (index) and /s/<id>.
// Re-fetches state on each server-sent "changed" event and re-renders only the
// sections whose timestamp moved, so iframes and scroll position survive.

import { readPair, prettyName, swatch, themeMode, themeVars } from "/assets/theme.mjs";
import { matchKeys, nextSeen, orderSessions, rankItems, VIM_KEYS, waitingSessions } from "/assets/nav.mjs";

const CSS = `
:root { color-scheme: light dark; --bg:#f7f5f0; --card:#fff; --ink:#1c1b19; --dim:#8a8578; --line:#e6e1d6; --soft:#f0ece3; --accent:#b4541f; --ok:#1f7a52; --warn:#a86a00; --bad:#c0392b; --code:#f3f0e8; --tint:#fbf3ec; --hl-kw:#285880; --hl-str:#42632a; --hl-num:#805424; --hl-com:#5b6a7f; --hl-title:#68448b; --c1:#3b7dd8; --c2:#e0703a; --c3:#2f9e72; --c4:#c4475b; --c5:#8a63c9; --c6:#b8901c; --c7:#2e9bb0; --c8:#8c8577; }
@media (prefers-color-scheme: dark) { :root { --bg:#1f1e1c; --card:#282725; --ink:#ecebe7; --dim:#9a958a; --line:#3a3834; --soft:#312f2c; --accent:#e08a5a; --ok:#5cc495; --warn:#e2b257; --bad:#ef6f5e; --code:#211f1d; --tint:#33291f; --hl-kw:#8fc4e2; --hl-str:#bed59d; --hl-num:#e5c29b; --hl-com:#a5b4c6; --hl-title:#d6b9ed; --c1:#6ea3ec; --c2:#f08f5c; --c3:#4fc493; --c4:#e36a7c; --c5:#a888e0; --c6:#e0bd4a; --c7:#5cc3d3; --c8:#a8a194; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
#app { max-width: 1100px; margin: 0 auto; padding: 18px 20px 60px; }
a { color: var(--accent); }
header.top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
header.top h1 { font-size: 20px; margin: 0; }
header.top .cwd { color: var(--dim); font-size: 13px; }
header.top .back { font-size: 13px; }
header.top .tools { margin-left: auto; display: flex; gap: 2px; align-items: baseline; }
header.top .tools .back { margin-left: 8px; }
.card > h2 { cursor: pointer; user-select: none; }
.chev { flex: none; width: 18px; height: 18px; margin: 0 -4px 0 -4px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dim); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.chev::before { content: ""; width: 5px; height: 5px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: translateY(-1px) rotate(45deg); transition: transform .15s; }
.chev:hover, .card > h2:hover .chev { color: var(--ink); }
.card.collapsed .chev::before { transform: translateX(-1px) rotate(-45deg); }
.card.collapsed > :not(h2) { display: none; }
.card.collapsed > h2 { border-bottom: 0; }
.card.unseen > h2 .title::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 7px; border-radius: 50%; background: var(--accent); vertical-align: 2px; }
.state { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; font-weight: 600; white-space: nowrap; }
.state.working { color: var(--ok); } .state.done { color: var(--warn); } .state.blocked { color: var(--accent); } .state.error { color: var(--bad); } .state.idle, .state.ended { color: var(--dim); font-weight: 400; }
.state .msg { font-weight: 400; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; overflow: hidden; scroll-margin-top: 14px; }
@media (min-width: 1200px) {
  #app.session { max-width: 1460px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
  .side { position: sticky; top: 14px; max-height: calc(100vh - 28px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
}
.side .card > h2 .tag, .side .card > h2 .meta button.btn { display: none; }
.side .card > .bd { padding: 10px 12px; }
.side .md table { font-size: 12px; }
.side .md th, .side .md td { padding: 3px 6px; }
.side .md td code { font-size: 11.5px; overflow-wrap: anywhere; }
.side .md td:last-child, .side .md th { white-space: nowrap; }
.side .gallery { grid-template-columns: 1fr 1fr; gap: 8px; }
.side .gallery img { height: 96px; }
.side .gallery figcaption { font-size: 11px; }
.toc { list-style: none; margin: 0; padding: 4px 0; }
dialog.modal { padding: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--ink); width: min(1180px, 94vw); max-width: 94vw; max-height: 92vh; box-shadow: 0 24px 70px rgba(0, 0, 0, .35); overflow: hidden; }
dialog.modal[open] { display: flex; flex-direction: column; }
dialog.modal.image { width: auto; }
dialog.modal.diff { height: min(92vh, 960px); }
dialog.modal:focus, dialog.modal:focus-visible { outline: none; }
dialog.modal::backdrop { background: rgba(24, 20, 16, .58); }
dialog.modal > header { display: flex; gap: 10px; align-items: center; padding: 6px 8px 6px 14px; min-height: 40px; box-sizing: border-box; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--soft) 40%, var(--card)); font-size: 13px; }
dialog.modal > header .title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
dialog.modal.diff > header .title { font: 600 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
dialog.modal > header .sub { color: var(--dim); font-size: 12px; white-space: nowrap; }
dialog.modal > header .tools { margin-left: auto; display: flex; gap: 2px; align-items: center; flex: none; }
dialog.modal > header .pos { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; padding: 0 4px; }
dialog.modal .mbody { overflow: auto; min-height: 0; flex: 1; }
dialog.modal .mbody > .empty, dialog.modal .mbody > .err { padding: 18px; }
dialog.modal.image .mbody { background: var(--soft); display: flex; align-items: center; justify-content: center; }
dialog.modal img.lightbox { display: block; max-width: 94vw; max-height: calc(92vh - 42px); object-fit: contain; }
.gallery a, img.shot { cursor: zoom-in; }
table.diff { border-collapse: collapse; width: 100%; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
table.diff td { padding: 0 10px; vertical-align: top; }
table.diff td.ln { width: 1%; min-width: 2.6em; text-align: right; color: var(--dim); user-select: none; white-space: nowrap; padding: 0 6px; }
table.diff td.ln + td.ln { border-right: 1px solid var(--line); }
table.diff td.code { white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
table.diff td.code::before { display: inline-block; width: 1.2em; color: var(--dim); user-select: none; }
table.diff tr.add td.code::before { content: "+"; color: var(--ok); }
table.diff tr.del td.code::before { content: "−"; color: var(--bad); }
table.diff:not(.split) tr.ctx td.code::before { content: " "; }
table.diff tr.add td { background: color-mix(in srgb, var(--ok) 13%, transparent); }
table.diff tr.del td { background: color-mix(in srgb, var(--bad) 12%, transparent); }
table.diff tr.hunk td { background: color-mix(in srgb, var(--accent) 7%, var(--soft)); color: var(--dim); padding-top: 3px; padding-bottom: 3px; }
table.diff tr.hunk:not(:first-child) td { border-top: 1px solid var(--line); }
table.diff tr.note td { color: var(--dim); font-style: italic; }
table.diff.split { table-layout: fixed; }
table.diff.split col.c-ln { width: 3.4em; }
table.diff.split td.ln { min-width: 0; }
table.diff.split td.ln + td.code + td.ln { border-left: 1px solid var(--line); }
table.diff.split td.ln + td.ln { border-right: 0; }
table.diff.split td.code { border-right: 0; }
table.diff.split td.add { background: color-mix(in srgb, var(--ok) 13%, transparent); }
table.diff.split td.del { background: color-mix(in srgb, var(--bad) 12%, transparent); }
table.diff.split td.code::before { content: none; }
table.diff td.blank { background: repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--line) 45%, transparent) 5px 6px); }
table.diff mark { color: inherit; border-radius: 2px; padding: 0; }
table.diff tr.add mark, table.diff td.add mark { background: color-mix(in srgb, var(--ok) 34%, transparent); }
table.diff tr.del mark, table.diff td.del mark { background: color-mix(in srgb, var(--bad) 30%, transparent); }
.diffview { display: flex; flex-direction: column; gap: 10px; }
.diffview.in-modal { padding: 10px 12px 12px; }
.diffview.in-modal .dv-file.bare { margin: 0 -12px -12px; border-top: 1px solid var(--line); border-radius: 0; }
.dv-bar { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.dv-sum { color: var(--dim); }
.n-add { color: var(--ok); font-weight: 600; }
.n-del { color: var(--bad); font-weight: 600; }
.dv-bar .tools { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.segs { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg { font: 500 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 5px 9px; border: 0; background: transparent; color: var(--dim); cursor: pointer; }
.seg + .seg { border-left: 1px solid var(--line); }
.seg.on { background: var(--soft); color: var(--ink); }
.dv-files { list-style: none; margin: 0; padding: 5px 0; border: 1px solid var(--line); border-radius: 8px; font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; }
.dv-files li { display: flex; gap: 10px; align-items: baseline; padding: 0 12px; }
.dv-files a { color: var(--ink); text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-files a:hover { text-decoration: underline; }
.dv-file { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; scroll-margin-top: 14px; }
.dv-file > header { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: color-mix(in srgb, var(--soft) 50%, var(--card)); border-bottom: 1px solid var(--line); cursor: pointer; font: 600 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.dv-file > header:hover .chev { color: var(--ink); }
.dv-file.shut > header { border-bottom: 0; }
.dv-file.shut .dv-body { display: none; }
.dv-file.shut .chev::before { transform: translateX(-1px) rotate(-45deg); }
.dv-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-n { margin-left: auto; font-weight: 500; white-space: nowrap; }
.dv-status { font: 500 10.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 3px 6px; border-radius: 4px; background: var(--soft); color: var(--dim); }
.dv-status.added { color: var(--ok); } .dv-status.deleted { color: var(--bad); }
.dv-body { overflow-x: auto; }
.dv-body > .empty { padding: 10px 12px; }
.dv-load { margin: 10px 12px; }
.chart { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.chart-plot { width: 100%; min-height: 40px; }
.chart svg { display: block; overflow: visible; font: 11px/1 -apple-system, BlinkMacSystemFont, sans-serif; }
.chart .grid line { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }
.chart .grid line.minor { stroke-dasharray: 2 3; }
.chart .grid line.zero { stroke: var(--dim); stroke-opacity: 0.55; }
.chart text { fill: var(--dim); }
.chart text.al { font-weight: 600; }
.chart text.total { fill: var(--ink); font-size: 18px; font-weight: 600; }
.chart .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart .area { fill-opacity: 0.2; stroke: none; }
.chart .pt { stroke: var(--card); stroke-width: 1.5; }
.chart .slice { stroke: var(--card); stroke-width: 2; }
.chart .hole { fill: var(--card); }
.chart :is(.bar, .pt, .slice):hover { filter: brightness(1.12); }
.chart-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px; color: var(--ink); }
.chart-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.chart-legend em { font-style: normal; color: var(--dim); }
.chart-cap { font-size: 12.5px; color: var(--dim); }
.term { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--code); }
.term-head { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--line); }
.term-cmd { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); white-space: pre-wrap; word-break: break-all; background: none; padding: 0; }
.term-ps { color: var(--dim); user-select: none; }
.term-meta { display: flex; gap: 12px; align-items: center; font-size: 12px; color: var(--dim); white-space: nowrap; }
.term-meta .btn { margin: -4px -6px -4px 0; }
.term-exit { font-weight: 600; }
.term-exit.ok { color: var(--ok); } .term-exit.bad { color: var(--bad); }
.term-tools { display: flex; gap: 10px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--line); }
.term-tools .btn { margin-left: auto; }
.term-filter, .tbl-filter { font: 12.5px/1.2 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; width: min(260px, 50%); }
.term-count, .tbl-count { font-size: 12px; color: var(--dim); }
.term-body { max-height: 640px; overflow: auto; padding: 6px 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.tl { display: flex; min-height: 1.5em; padding: 0 12px 0 0; }
.tl .ln { flex: none; width: 4.2em; padding-right: 12px; text-align: right; color: var(--dim); opacity: 0.6; user-select: none; }
.tl .tx { white-space: pre-wrap; word-break: break-word; min-width: 0; }
.tl.bad .tx { color: var(--bad); } .tl.warn .tx { color: var(--warn); } .tl.ok .tx { color: var(--ok); }
.tl mark { background: color-mix(in srgb, var(--warn) 35%, transparent); color: inherit; border-radius: 2px; }
.term-fold { display: block; margin: 4px 12px 4px 4.2em; font: 500 12px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--accent); background: none; border: 1px dashed var(--line); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.term-fold:hover { background: var(--soft); }
.term-none { padding: 6px 12px; color: var(--dim); font-style: italic; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px; }
.stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.stat-label { font-size: 12px; color: var(--dim); }
.stat-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.stat-value { font-size: 24px; line-height: 1.15; font-weight: 650; font-variant-numeric: tabular-nums; }
.stat-delta { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat-delta.ok { color: var(--ok); } .stat-delta.bad { color: var(--bad); } .stat-delta.flat { color: var(--dim); }
.stat-note { font-size: 11.5px; color: var(--dim); }
svg.spark { display: block; overflow: visible; margin-top: 2px; max-width: 100%; height: auto; }
svg.spark path { fill: none; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.tbl-tools { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.tbl-scroll { max-height: 70vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
table.ktable { width: 100%; border-collapse: collapse; font-size: 13px; margin: 0; }
table.ktable th, table.ktable td { padding: 5px 10px; border-bottom: 1px solid var(--soft); text-align: left; vertical-align: middle; white-space: nowrap; }
table.ktable td { white-space: normal; }
table.ktable thead th { position: sticky; top: 0; background: var(--card); border-bottom: 1px solid var(--line); z-index: 1; padding: 0; }
table.ktable tbody tr:hover { background: var(--soft); }
table.ktable .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.ktable th.num .tbl-sort { justify-content: flex-end; }
table.ktable td.nil { color: var(--dim); }
.tbl-sort { all: unset; box-sizing: border-box; display: flex; gap: 5px; align-items: center; width: 100%; padding: 7px 10px; font-weight: 600; font-size: 12.5px; cursor: pointer; }
.tbl-sort .arrow { font-size: 9px; color: var(--dim); opacity: 0.5; }
.tbl-sort.on .arrow { opacity: 1; color: var(--accent); }
.tbl-sort:hover .arrow { opacity: 1; }
.tbl-sort:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
td.barc > div { display: flex; align-items: center; gap: 8px; min-width: 140px; }
.cbar { flex: 1; height: 8px; background: var(--soft); border-radius: 999px; overflow: hidden; min-width: 60px; }
.cbar i { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
td.barc .num { min-width: 4em; }
.ctag { display: inline-block; font-size: 11.5px; line-height: 1; padding: 3px 7px; border-radius: 999px; background: var(--soft); color: var(--dim); white-space: nowrap; }
.ctag.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.ctag.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); }
.ctag.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }
.tbl-more { margin-top: 6px; }
.tbl-more .term-fold { margin-left: 0; }
.cmp-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
.cmp-fade { width: 200px; accent-color: var(--accent); }
.cmp-stack { position: relative; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; line-height: 0; user-select: none; touch-action: none; }
.cmp-stack img { display: block; width: 100%; height: auto; }
.cmp-stack img.top { position: absolute; inset: 0; height: 100%; object-fit: contain; object-position: left top; }
.cmp-stack.slide { cursor: ew-resize; }
.cmp-stack.slide:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cmp-handle { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent); pointer-events: none; }
.cmp-handle span { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: #fff; font: 600 15px/30px -apple-system, sans-serif; text-align: center; box-shadow: 0 1px 4px rgb(0 0 0 / 0.3); }
.cmp-tag { position: absolute; top: 8px; font: 600 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 4px 8px; border-radius: 999px; background: rgb(0 0 0 / 0.6); color: #fff; pointer-events: none; }
.cmp-tag.l { left: 8px; } .cmp-tag.r { right: 8px; }
.cmp-side { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cmp-side figure { margin: 0; min-width: 0; }
.cmp-side figcaption { font-size: 12px; font-weight: 600; color: var(--dim); margin-bottom: 4px; }
.cmp-side img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
.steps-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-bottom: 10px; }
.steps-count { font-size: 12.5px; color: var(--dim); }
.steps-count .bad { color: var(--bad); } .steps-count .warn { color: var(--warn); }
.steps-bar { flex: 1 1 160px; height: 6px; background: var(--soft); border-radius: 999px; overflow: hidden; }
.steps-bar i { display: block; height: 100%; background: var(--ok); border-radius: inherit; transition: width 0.3s; }
ol.steps-list { list-style: none; margin: 0; padding: 0; }
.step { position: relative; display: flex; gap: 10px; padding: 0 0 12px; }
.step:not(:last-child)::before { content: ""; position: absolute; left: 10px; top: 22px; bottom: 0; width: 2px; background: var(--line); }
.step.s-done:not(:last-child)::before { background: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.smark { flex: none; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--line); box-sizing: border-box; display: grid; place-items: center; font: 700 11px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--card); background: var(--card); }
.s-done .smark { background: var(--ok); border-color: var(--ok); }
.s-failed .smark { background: var(--bad); border-color: var(--bad); }
.s-blocked .smark { background: var(--warn); border-color: var(--warn); }
.s-skipped .smark { color: var(--dim); }
.s-active .smark { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
.s-active .smark::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.sbody { min-width: 0; padding-top: 2px; }
.slabel { font-size: 13.5px; line-height: 1.35; }
.s-active .slabel { font-weight: 600; }
.s-skipped .slabel { color: var(--dim); text-decoration: line-through; }
.s-failed .slabel { color: var(--bad); }
.snote { font-size: 12.5px; color: var(--dim); margin-top: 1px; }
.sdetail { margin: 4px 0 0; font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); background: var(--code); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
.jtools { margin-left: auto; display: flex; gap: 4px; }
.jt { font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; max-height: 70vh; overflow: auto; }
.jc { display: none; padding-left: 18px; border-left: 1px solid var(--soft); margin-left: 6px; }
.jn.open > .jc { display: block; }
.jrow { cursor: pointer; border-radius: 4px; }
.jrow:hover { background: var(--soft); }
.jn.leaf { padding-left: 0; }
.jtog { display: inline-block; width: 14px; color: var(--dim); font-size: 10px; user-select: none; }
.jk { all: unset; cursor: copy; color: var(--t4); }
.jk.idx { color: var(--dim); }
.jk:hover { text-decoration: underline; }
.jk.copied { color: var(--ok); }
.jp { color: var(--dim); }
.jprev { color: var(--dim); font-size: 11.5px; }
.jn.open > .jrow > .jprev { opacity: 0.6; }
.jv { white-space: pre-wrap; word-break: break-word; }
.j-string { color: var(--t2); } .j-number { color: var(--t3); } .j-boolean { color: var(--t5); } .j-null { color: var(--dim); font-style: italic; }
.jt mark { background: color-mix(in srgb, var(--warn) 35%, transparent); color: inherit; border-radius: 2px; }
.jmore { margin: 2px 0; }
ol.tline { list-style: none; margin: 0; padding: 0; }
.tday { font-size: 12px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em; padding: 10px 0 6px 92px; }
.tday:first-child { padding-top: 0; }
.tev { position: relative; display: grid; grid-template-columns: 76px 16px 1fr; gap: 0 8px; padding-bottom: 12px; }
.tev::before { content: ""; position: absolute; left: 91px; top: 14px; bottom: -2px; width: 2px; background: var(--line); }
.tev:last-child::before, .tev:has(+ .tday)::before { display: none; }
.twhen { text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--dim); padding-top: 1px; display: flex; flex-direction: column; }
.tgap { font-size: 11px; opacity: 0.75; }
.tdot { width: 12px; height: 12px; margin: 4px 0 0 1px; border-radius: 50%; background: var(--card); border: 2px solid var(--line); box-sizing: border-box; z-index: 1; }
.tev.toned .tdot { background: var(--tone); border-color: var(--tone); }
.ttitle { font-size: 13.5px; line-height: 1.4; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tnote { font-size: 12.5px; color: var(--dim); margin-top: 2px; white-space: pre-wrap; }
:root { --t0:#1c1b19; --t1:#c0392b; --t2:#1f7a52; --t3:#a86a00; --t4:#285880; --t5:#8a3f9e; --t6:#1f7a8a; --t7:#6b675e; --t8:#8a8578; --t9:#e0533f; --t10:#2f9e72; --t11:#b8901c; --t12:#3b7dd8; --t13:#a35bc0; --t14:#2e9bb0; --t15:#3a3834; }
@media (prefers-color-scheme: dark) { :root { --t0:#6b675e; --t1:#ef6f5e; --t2:#5cc495; --t3:#e2b257; --t4:#6ea3ec; --t5:#c792ea; --t6:#5cc3d3; --t7:#d6d3cc; --t8:#8a8578; --t9:#ff8a7a; --t10:#7ad9ab; --t11:#f0cc70; --t12:#8fbaf2; --t13:#d8aaf2; --t14:#7ad4e2; --t15:#ffffff; } }
.fileview { display: flex; align-items: stretch; min-height: 100%; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.fileview pre { margin: 0; padding: 8px 0; font: inherit; white-space: pre; }
.fileview .gutter { flex: none; position: sticky; left: 0; padding: 8px 10px 8px 14px; text-align: right; color: var(--dim); user-select: none; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--soft) 40%, var(--card)); }
.fileview .src { flex: 1; min-width: 0; overflow-x: auto; padding: 8px 14px; tab-size: 4; }
.fileview .src code { font: inherit; background: none; padding: 0; }
.mbody > .md.doc { padding: 18px 26px 26px; max-width: 920px; font-size: 14.5px; line-height: 1.6; }
.md li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.3em; }
.md li > input[type="checkbox"] { margin: 0 0.45em 0 0; vertical-align: -1px; }
.toc a { display: flex; gap: 10px; align-items: baseline; padding: 4px 12px; color: var(--ink); text-decoration: none; font-size: 13px; }
.toc a:hover { background: color-mix(in srgb, var(--soft) 45%, transparent); }
.toc a .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc a time { flex: none; color: var(--dim); font-size: 11.5px; }
.toc a.shut .t { color: var(--dim); }
.toc li.more { padding: 2px 8px 2px; }
.toc li.more .btn { margin: 0; }
.toc a.unseen .t::after { content: ""; display: inline-block; width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--accent); vertical-align: 1px; }
.card > h2 { margin: 0; padding: 6px 8px 6px 12px; min-height: 34px; font-size: 13px; font-weight: 600; letter-spacing: -.005em; background: color-mix(in srgb, var(--soft) 40%, var(--card)); border-bottom: 1px solid var(--line); display: flex; gap: 8px; align-items: center; }
.card > h2 .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card > h2 .meta { margin-left: auto; color: var(--dim); font-weight: 400; font-size: 12px; display: flex; gap: 6px; align-items: center; flex: none; padding-right: 4px; }
.card > .bd { padding: 12px 14px; }
.card > .bd.flush { padding: 0; }
.tag { font: 500 10.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 6px; border-radius: 4px; background: var(--soft); color: var(--dim); }
.n { font-size: 11px; font-weight: 500; color: var(--dim); background: var(--soft); border-radius: 9px; padding: 0 6px; }
time[data-at] { font-variant-numeric: tabular-nums; }
.btn { font: 500 11.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--dim); background: transparent; border: 1px solid transparent; border-radius: 5px; padding: 4px 7px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
.btn:hover { color: var(--ink); background: var(--soft); border-color: var(--line); }
.btn.ok { color: var(--ok); }
.btn.bad { color: #c0392b; }
.status .goal { font-size: 17px; font-weight: 600; line-height: 1.35; letter-spacing: -.01em; }
.eyebrow { display: block; color: var(--dim); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 2px; }
.status .now { margin: 12px 0 16px; padding: 9px 12px; background: var(--tint); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; display: flex; gap: 10px; align-items: baseline; }
.status .now .eyebrow { color: var(--accent); margin: 0; flex: none; }
.pulse { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); align-self: center; }
.pulse.working { background: var(--ok); animation: pulse 2s infinite; }
.pulse.done { background: var(--warn); }
.pulse.blocked { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
.pulse.error { background: var(--bad); }
.pulse.idle { background: transparent; border: 1.5px solid var(--dim); }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); } 70%, 100% { box-shadow: 0 0 0 7px transparent; } }
.status .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 22px; }
.status .col h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; display: flex; gap: 6px; align-items: center; color: var(--ink); }
.status .col ul { list-style: none; margin: 0; padding: 0; }
.status .col li { position: relative; padding: 3px 0 3px 20px; font-size: 13.5px; line-height: 1.4; }
.status .col li::before { position: absolute; left: 0; top: 3px; width: 14px; text-align: center; font-weight: 700; }
.status .col.done li { color: var(--dim); }
.status .col.done li::before { content: "✓"; color: var(--ok); }
.status .col.open li::before { content: "?"; color: var(--warn); }
.status .col.next li::before { content: "→"; color: var(--accent); }
.status .col .none { color: var(--dim); font-size: 13px; padding-left: 20px; }
.card.fresh { animation: fresh 1.6s ease-out; }
@keyframes fresh { from { box-shadow: 0 0 0 2px var(--accent); } to { box-shadow: 0 0 0 2px transparent; } }
.empty { color: var(--dim); font-style: italic; }
.md :first-child { margin-top: 0; } .md :last-child { margin-bottom: 0; }
.md table { border-collapse: collapse; width: 100%; font-size: 13.5px; display: block; overflow-x: auto; }
.md th, .md td { border-bottom: 1px solid var(--soft); padding: 4px 8px; text-align: left; vertical-align: top; }
.md th { border-bottom-color: var(--line); }
.md code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 12.5px; }
.md pre { background: var(--code); padding: 10px 12px; border-radius: 8px; overflow-x: auto; margin: 0; font-size: 12.5px; line-height: 1.5; }
.md pre code { background: none; padding: 0; }
/* Prose in a fence (a prompt, a message) wraps; code keeps its lines and scrolls. */
.md pre code:is(.language-text, .language-txt, .language-plain, .language-plaintext, .language-prompt, .language-markdown, .language-md) { white-space: pre-wrap; overflow-wrap: anywhere; }
.hljs-keyword, .hljs-selector-tag, .hljs-meta, .hljs-section, .hljs-name, .hljs-tag { color: var(--hl-kw); }
.hljs-keyword, .hljs-section { font-weight: 600; }
.hljs-string, .hljs-regexp, .hljs-quote, .hljs-addition { color: var(--hl-str); }
.hljs-number, .hljs-literal, .hljs-symbol, .hljs-attr, .hljs-attribute, .hljs-bullet, .hljs-variable, .hljs-template-variable { color: var(--hl-num); }
.hljs-comment, .hljs-doctag { color: var(--hl-com); font-style: italic; }
.hljs-title, .hljs-built_in, .hljs-type, .hljs-selector-class, .hljs-selector-id { color: var(--hl-title); }
.hljs-deletion { color: var(--bad); }
.hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 600; }
.codeblock { position: relative; margin: 10px 0; border: 1px solid var(--line); border-radius: 8px; }
.codeblock:first-child { margin-top: 0; } .codeblock:last-child { margin-bottom: 0; }
.codeblock .lang { position: absolute; top: 6px; left: 10px; font: 500 10px/1 ui-monospace, Menlo, monospace; color: var(--dim); text-transform: lowercase; pointer-events: none; }
.codeblock .lang + pre { padding-top: 24px; }
.codeblock .btn { position: absolute; top: 4px; right: 4px; background: var(--card); border-color: var(--line); opacity: 0; transition: opacity .12s; }
.codeblock:hover .btn, .codeblock .btn:focus-visible, .codeblock .btn.ok { opacity: 1; }
@media (hover: none) { .codeblock .btn { opacity: 1; } }
.md blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--line); color: var(--dim); }
.mmd { overflow-x: auto; text-align: center; }
.mmd svg { max-width: 100%; height: auto; }
iframe { display: block; width: 100%; border: 0; background: #fff; }
iframe.fit { background: var(--card); }
iframe.plan { height: 82vh; }
img.shot { display: block; max-width: 100%; margin: 0 auto; border-radius: 6px; }
.findings { margin: 0; padding: 0; list-style: none; }
.findings li { display: grid; grid-template-columns: 76px 1fr auto; gap: 0 12px; align-items: start; padding: 7px 14px; border-top: 1px solid var(--soft); font-size: 13.5px; line-height: 1.45; }
.findings li:first-child, .findings li.day + li { border-top: 0; }
.findings li:hover { background: color-mix(in srgb, var(--soft) 45%, transparent); }
.findings li time { color: var(--dim); font-size: 12px; text-align: right; padding-top: 1px; }
.findings li .when { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.tag.auto { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.gallery figure { margin: 0; min-width: 0; }
.gallery img { display: block; width: 100%; height: 150px; object-fit: cover; object-position: top left; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); }
.gallery a:hover img { border-color: var(--accent); }
.gallery figcaption { margin-top: 4px; font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.findings li .btn { opacity: 0; margin: -3px -6px -3px 0; }
.findings li:hover .btn, .findings li .btn:focus-visible, .findings li .btn.ok { opacity: 1; }
@media (hover: none) { .findings li .btn { opacity: 1; } }
.findings li.day { display: block; padding: 10px 14px 4px; border-top: 0; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
.findings li.day:hover { background: none; }
.findings li.more { display: block; padding: 4px 10px 8px; }
.findings li.more .btn { opacity: 1; margin: 0; }
.findings li.more:hover { background: none; }
.sessions .row { display: grid; grid-template-columns: 1fr auto; gap: 0 16px; padding: 10px 14px 11px; border-top: 1px solid var(--soft); color: inherit; text-decoration: none; }
.sessions .row:first-child { border-top: 0; }
.sessions .row:hover { background: color-mix(in srgb, var(--soft) 45%, transparent); }
.sessions .row .main { min-width: 0; }
.sessions .row .line1 { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.sessions .row .name { font-weight: 600; font-size: 14px; white-space: nowrap; }
.sessions .row .cwd { color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sessions .row .goal { margin-top: 2px; font-size: 13.5px; line-height: 1.4; }
.sessions .row .goal.none { color: var(--dim); font-style: italic; }
.sessions .row .nowline { margin-top: 3px; color: var(--dim); font-size: 12.5px; line-height: 1.4; display: flex; gap: 7px; align-items: baseline; }
.sessions .row .nowline .eyebrow { margin: 0; flex: none; font-size: 9.5px; }
.sessions .row .chips { margin-top: 6px; display: flex; gap: 5px; flex-wrap: wrap; }
.chip { font-size: 11px; line-height: 1.6; padding: 0 7px; border-radius: 9px; background: var(--soft); color: var(--dim); white-space: nowrap; }
.chip.open { background: color-mix(in srgb, var(--warn) 16%, var(--card)); color: var(--warn); font-weight: 600; }
.chip.next { color: var(--accent); }
.sessions .row .side { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; text-align: right; }
.sessions .row .side time { color: var(--dim); font-size: 12px; }
.sessions .row.ended .name, .sessions .row.ended .goal { color: color-mix(in srgb, var(--ink) 75%, var(--dim)); }
.err { color: #c0392b; font-size: 13px; white-space: pre-wrap; }

/* Other sessions waiting on you, above the header. */
.waitbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: -4px 0 12px; }
.waitbar:empty { display: none; }
.waitbar .lbl { color: var(--dim); font-size: 12px; margin-right: 2px; }
.waitchip { display: inline-flex; align-items: center; gap: 6px; max-width: 360px; padding: 3px 10px 3px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--ink); font-size: 12.5px; text-decoration: none; }
.waitchip:hover { border-color: var(--accent); }
.waitchip.blocked { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); }
.waitchip.error { border-color: color-mix(in srgb, var(--bad) 55%, var(--line)); }
.waitchip .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.waitchip .st { color: var(--dim); white-space: nowrap; }

/* Cmd-K picker */
.cmdk-back { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; background: color-mix(in srgb, #000 35%, transparent); }
.cmdk { width: min(620px, calc(100vw - 32px)); max-height: 72vh; display: flex; flex-direction: column; overflow: hidden; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 20px 60px rgba(0, 0, 0, .35); }
.cmdk .q { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--line); }
.cmdk .q .crumb { flex: none; padding: 2px 8px; border-radius: 6px; background: var(--soft); color: var(--dim); font-size: 12px; }
.cmdk .q input { flex: 1; min-width: 0; padding: 13px 0; border: 0; outline: none; background: transparent; color: var(--ink); font: inherit; font-size: 15px; }
.cmdk ul { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
.cmdk li.grp { padding: 8px 10px 4px; color: var(--dim); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.cmdk li.it { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }
.cmdk li.it.on { background: var(--soft); }
.cmdk li.it .lb { flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.cmdk li.it .sub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); font-size: 12.5px; }
.cmdk li.it .end { flex: none; margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--dim); font-size: 12px; white-space: nowrap; }
.cmdk li.it .end .state { font-size: 11.5px; }
.cmdk .sw { display: inline-flex; gap: 2px; }
.cmdk .sw i { width: 10px; height: 10px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(127, 127, 127, .35); }
.cmdk .in-use { color: var(--accent); font-weight: 600; }
.cmdk .none { padding: 16px; color: var(--dim); text-align: center; }
.cmdk .foot { display: flex; flex-wrap: wrap; gap: 14px; padding: 6px 12px; border-top: 1px solid var(--line); color: var(--dim); font-size: 11.5px; }
kbd { padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--soft); font: 11px ui-monospace, Menlo, monospace; }
.toast { position: fixed; bottom: 18px; left: 50%; z-index: 60; transform: translateX(-50%); padding: 8px 14px; border-radius: 8px; background: var(--ink); color: var(--card); font-size: 13px; box-shadow: 0 6px 20px rgba(0, 0, 0, .25); opacity: 0; transition: opacity .15s; pointer-events: none; }
.toast.show { opacity: 1; }

/* vim keys: the current section, a pending key, the ? overlay */
.card.current { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 2px; }
.keyhint { position: fixed; right: 16px; bottom: 16px; z-index: 55; padding: 4px 10px; border-radius: 6px; background: var(--ink); color: var(--card); font: 600 13px ui-monospace, Menlo, monospace; opacity: .9; }
.cmdk.keys { width: min(760px, calc(100vw - 32px)); padding: 14px 18px 16px; }
.keys .keys-hd { font-weight: 600; }
.keys .keys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 4px 28px; overflow-y: auto; }
.keys h3 { margin: 12px 0 4px; color: var(--dim); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.keys table { border-collapse: collapse; font-size: 13px; }
.keys td { padding: 3px 12px 3px 0; vertical-align: top; }
.keys td:first-child { white-space: nowrap; }
`;

const $app = document.getElementById("app");
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};

const tilde = (p) => String(p || "").replace(/^\/Users\/[^/]+/, "~").replace("~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault", "~/Documents/Wiki");

function ago(t) {
  const ms = Date.now() - (typeof t === "number" ? t : Date.parse(t));
  if (!(ms >= 0)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const clock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fullDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

function dayLabel(d) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** A relative time that the ticker below keeps current. */
const agoEl = (iso) => h("time", { "data-at": iso, datetime: iso, title: fullDate(iso) }, ago(iso));
setInterval(() => {
  for (const t of document.querySelectorAll("time[data-at]")) t.textContent = ago(t.dataset.at);
}, 15_000);

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text);
  } catch {}
  // Older path: works when the async API is missing or refuses (no focus).
  const ta = h("textarea", { style: "position:fixed;opacity:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

function copyButton(getText, label = "Copy") {
  const b = h("button", { class: "btn", type: "button", title: "Copy to clipboard" }, label);
  let timer;
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    try {
      await copyText(await getText());
      b.textContent = "Copied";
      b.className = "btn ok";
    } catch {
      b.textContent = "Failed";
      b.className = "btn bad";
    }
    timer = setTimeout(() => ((b.textContent = label), (b.className = "btn")), 1400);
  });
  return b;
}

/** /s/<id>/f/<name> as [id, name], or null. */
function sessionFile(href) {
  const m = new URL(href, location.href).pathname.match(/^\/s\/([^/]+)\/f\/([^/]+)$/);
  return m ? [decodeURIComponent(m[1]), decodeURIComponent(m[2])] : null;
}

/**
 * Put the file itself on the clipboard (the daemon runs clippy), to paste into
 * Slack, Mail or Finder as a file. getHref names the session file; for a
 * changed file's copy that means the real file.
 */
function clipButton(getHref, label = "Clippy") {
  const b = h("button", { class: "btn clip", type: "button", title: "Copy the file itself (clippy), to paste as a file" }, label);
  let timer;
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(timer);
    try {
      const at = sessionFile(getHref());
      if (!at) throw new Error("not a session file");
      const r = await fetch(`/s/${encodeURIComponent(at[0])}/clip`, { method: "POST", headers: { "Content-Type": "application/json", "X-Canvas-Clip": "1" }, body: JSON.stringify({ file: at[1] }) });
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const { name } = await r.json();
      b.textContent = "Copied file";
      b.title = `On the clipboard: ${name}`;
      b.className = "btn clip ok";
    } catch (err) {
      b.textContent = "Failed";
      b.title = String(err.message || err);
      b.className = "btn clip bad";
    }
    timer = setTimeout(() => ((b.textContent = label), (b.className = "btn clip")), 1600);
  });
  return b;
}

// ── renderers ────────────────────────────────────────────────────────────────

let mermaidReady;
let mermaidSeq = 0;
let hljsReady;

/** highlight.js, loaded on first use; null when it can't load (code stays plain). */
function loadHighlight() {
  hljsReady ??= new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/assets/vendor/highlight.js";
    s.onload = () => resolve(window.hljs || null);
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return hljsReady;
}

/** What a highlighter's output may keep: <span class> and nothing else. */
const HL_CLEAN = { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false };
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "output", "console", "log"]);

/**
 * Colour a code element in place. Only a named language (no guessing), only
 * blocks up to 16 KB, and the result is cut down to <span class> before use.
 */
async function highlightInto(code, lang) {
  const name = String(lang || "").trim().split(/\s/, 1)[0].toLowerCase();
  const text = code.textContent;
  if (!name || PLAIN.has(name) || text.length > 16000 || !/^[a-z0-9_+#.-]{1,40}$/.test(name)) return;
  const hl = await loadHighlight();
  if (!hl?.getLanguage(name) || !window.DOMPurify) return;
  try {
    const html = hl.highlight(text, { language: name, ignoreIllegals: true }).value;
    if (code.textContent === text) code.innerHTML = window.DOMPurify.sanitize(html, HL_CLEAN);
  } catch {}
}

function loadMermaid() {
  mermaidReady ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/assets/vendor/mermaid.js";
    s.onload = () => {
      window.mermaid.initialize(mermaidConfig());
      resolve(window.mermaid);
    };
    s.onerror = () => reject(new Error("mermaid failed to load"));
    document.head.append(s);
  });
  return mermaidReady;
}

async function renderMermaid(el, source) {
  // Not "mermaid": mermaid's own startOnLoad scans for that class when its
  // script loads and would empty this box before render() fills it.
  el.classList.add("mmd");
  el._src = source; // kept so a theme change can draw it again
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, source);
    el.innerHTML = svg;
  } catch (e) {
    el.replaceChildren(h("div", { class: "err" }, `mermaid: ${e.message || e}`), h("pre", {}, source));
  }
}

function renderMarkdown(text) {
  const el = h("div", { class: "md" });
  if (!window.marked || !window.DOMPurify) {
    el.append(h("pre", {}, text));
    return el;
  }
  el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true }));
  for (const a of el.querySelectorAll("a[href]")) a.target = "_blank";
  for (const code of el.querySelectorAll("pre > code.language-mermaid")) {
    const box = h("div");
    code.parentElement.replaceWith(box);
    renderMermaid(box, code.textContent);
  }
  // Paths in table cells may wrap at their slashes, not mid-name.
  for (const code of el.querySelectorAll("td code")) {
    const parts = code.textContent.split(/(?<=\/)/);
    if (parts.length > 1) code.replaceChildren(...parts.flatMap((p, i) => (i ? [document.createElement("wbr"), p] : [p])));
  }
  for (const pre of el.querySelectorAll("pre")) {
    const code = pre.querySelector("code") || pre;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
    const wrap = h("div", { class: "codeblock" });
    pre.replaceWith(wrap);
    wrap.append(lang ? h("span", { class: "lang" }, lang) : "", pre, copyButton(() => code.textContent.replace(/\n$/, "")));
    if (lang) highlightInto(code, lang);
  }
  return el;
}

function fitFrame(frame) {
  frame.classList.add("fit");
}

// html frames are cross-origin to this page (no allow-same-origin), so the
// kit's frame script reports its content height and this sizes the frame.
window.addEventListener("message", (e) => {
  const height = e.data?.canvasFrame?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return;
  for (const f of document.querySelectorAll("iframe.fit")) if (f.contentWindow === e.source) f.style.height = `${Math.min(Math.max(Math.ceil(height), 40), 4000)}px`;
});

async function sectionBody(id, sec) {
  const url = `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(sec.file)}?v=${encodeURIComponent(sec.at || "")}`;
  switch (sec.kind) {
    case "markdown":
      return renderMarkdown(await (await fetch(url)).text());
    case "mermaid": {
      const box = h("div");
      renderMermaid(box, await (await fetch(url)).text());
      return box;
    }
    case "html": {
      // No allow-same-origin: the page's script can't reach this page or the daemon.
      const f = h("iframe", { src: url, sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads", allow: "clipboard-write", loading: "lazy" });
      fitFrame(f);
      return f;
    }
    case "html-plan":
      return h("iframe", { class: "plan", src: url, sandbox: "allow-scripts allow-same-origin allow-popups allow-modals allow-downloads", allow: "clipboard-write" });
    case "image":
      return h("img", { class: "shot", src: url, alt: sec.title });
    case "diff":
      return renderDiffView(await (await fetch(url)).text(), { title: sec.title || sec.id, href: rawUrl(id, sec, false) });
    case "chart":
      return renderChart(JSON.parse(await (await fetch(url)).text()));
    case "terminal":
      return renderTerminal(JSON.parse(await (await fetch(url)).text()));
    case "stats":
      return renderStats(JSON.parse(await (await fetch(url)).text()));
    case "table":
      return renderTable(JSON.parse(await (await fetch(url)).text()));
    case "steps":
      return renderSteps(JSON.parse(await (await fetch(url)).text()));
    case "json":
      return renderJson(await (await fetch(url)).text());
    case "timeline":
      return renderTimeline(JSON.parse(await (await fetch(url)).text()));
    case "compare":
      return renderCompare(JSON.parse(await (await fetch(url)).text()), (f) => `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(f)}?v=${encodeURIComponent(sec.at || "")}`);
    default:
      return h("div", { class: "empty" }, `unknown kind ${sec.kind}`);
  }
}

/** pi's program state (OSC 7501) as the extension mirrored it, or ended. */
function stateOf(s) {
  return s.activity || (s.live ? "done" : "ended");
}

const STATE_LABEL = { working: "working", blocked: "needs input", done: "your turn", error: "failed", idle: "idle" };
const STATE_TIP = {
  working: "The agent is running a turn",
  blocked: "A dialog in pi is waiting for you",
  done: "The turn finished; pi is waiting for your reply",
  error: "The run ended with an error",
  idle: "Started or cancelled; nothing running",
};
/** States where the next move is yours. */
const NEEDS_YOU = new Set(["blocked", "error", "done"]);

function stateBadge(s) {
  const st = stateOf(s);
  if (st === "ended") {
    const at = s.ended || s.meta?.ended;
    return h("span", { class: "state ended" }, at ? `ended ${ago(at)}` : "not running");
  }
  const msg = s.activityMessage || "";
  return h(
    "span",
    { class: `state ${st}`, title: [STATE_TIP[st], msg].filter(Boolean).join(": ") },
    h("span", { class: `pulse ${st}` }),
    STATE_LABEL[st] || st,
    msg && (st === "blocked" || st === "error") ? h("span", { class: "msg" }, `· ${msg}`) : null,
  );
}

const statusBy = (status) => `${status.model || "?"} · ${ago(status.at)}`;

// ── collapsing ───────────────────────────────────────────────────────────────
// Opening or collapsing a card is a choice remembered per session in
// localStorage. Without one, a section last changed over an hour ago starts
// collapsed. That is decided when the card renders, so nothing folds up while
// it is being read. A collapsed section's body is not rendered until it is
// opened, so mermaid and frames lay out at their real size.

const FOLD_AFTER_MS = 60 * 60 * 1000;
let choices = {}; // card key → "open" | "shut"
let choicesKey = "";

function loadChoices(sid) {
  choicesKey = `canvas:fold:${sid}`;
  try {
    const saved = JSON.parse(localStorage.getItem(choicesKey) || "null");
    // Before choices there was only a list of collapsed keys.
    const legacy = JSON.parse(localStorage.getItem(`canvas:collapsed:${sid}`) || "[]");
    choices = saved && typeof saved === "object" ? saved : Object.fromEntries(legacy.map((k) => [k, "shut"]));
  } catch {
    choices = {};
  }
}

function saveChoices() {
  try {
    localStorage.setItem(choicesKey, JSON.stringify(choices));
  } catch {}
}

/** Runs after the reader opens or collapses a card (the Contents list). */
let onFold = null;

/** Shut by the reader's choice, else by age when the card has one. */
function startsShut(key, at) {
  if (choices[key]) return choices[key] === "shut";
  const t = Date.parse(at || "");
  return Number.isFinite(t) && Date.now() - t > FOLD_AFTER_MS;
}

/** Make a card's header toggle it. onOpen runs the first time its body shows;
 *  at, when given, lets an old card start collapsed. */
function collapsible(card, key, onOpen, at) {
  const head = card.querySelector(":scope > h2");
  const chev = h("button", { class: "chev", type: "button" });
  head.prepend(chev);
  card.dataset.key = key;
  let opened = false;
  card.setCollapsed = (shut, remember = true) => {
    card.classList.toggle("collapsed", shut);
    chev.setAttribute("aria-expanded", String(!shut));
    chev.setAttribute("aria-label", shut ? "Expand" : "Collapse");
    chev.title = shut ? "Expand" : "Collapse";
    if (remember) {
      choices[key] = shut ? "shut" : "open";
      saveChoices();
      queueMicrotask(() => onFold?.()); // after the classes below settle
    }
    if (shut) return;
    card.classList.remove("unseen");
    if (!opened) {
      opened = true;
      onOpen?.();
    }
  };
  head.addEventListener("click", (e) => {
    if (e.target.closest("a, button, input") && !e.target.closest(".chev")) return;
    if (String(getSelection?.() || "")) return; // selecting title text, not toggling
    card.setCollapsed(!card.classList.contains("collapsed"));
  });
  card.setCollapsed(startsShut(key, at), false);
  return card;
}

/** Automatic widgets: the sidebar on wide screens, in time order otherwise. */
const WIDGETS = ["auto-files", "auto-screenshots"];
const WIDE = "(min-width: 1200px)";

/** Status and Findings stay on top. Sections follow, newest change first. */
function sortSections(list) {
  return [...list].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function statusCard(status, state) {
  const title = h("h2", {}, h("span", { class: "title" }, "Status"));
  const card = h("section", { class: "card" }, title);
  const bd = h("div", { class: "bd status" });
  card.append(bd);
  if (!status) {
    bd.append(h("div", { class: "empty" }, "No status yet. It appears after the next turn with tool calls."));
    return collapsible(card, "_status");
  }
  title.append(h("span", { class: "meta" }, h("span", { class: "by" }, statusBy(status))));
  bd.append(h("div", { class: "goal" }, h("span", { class: "eyebrow" }, "Goal"), status.goal || "—"));
  bd.append(h("div", { class: "now" }, h("span", { class: `pulse ${state}` }), h("span", { class: "eyebrow" }, "Now"), h("span", {}, status.now || "—")));
  const col = (kind, label, items) =>
    h(
      "div",
      { class: `col ${kind}` },
      h("h3", {}, label, h("span", { class: "n" }, String(items?.length || 0))),
      items?.length ? h("ul", {}, items.map((i) => h("li", {}, i))) : h("div", { class: "none" }, "—"),
    );
  bd.append(h("div", { class: "cols" }, col("next", "Next", status.next), col("open", "Open", status.open), col("done", "Done", status.done)));
  return collapsible(card, "_status");
}

const FINDINGS_SHOWN = 8;

function findingsCard(findings, showAll = false) {
  if (!findings?.length) return null;
  const list = h("ul", { class: "findings" });
  const card = h(
    "section",
    { class: "card", id: "findings" },
    h("h2", {}, h("span", { class: "title" }, "Findings"), h("span", { class: "n" }, String(findings.length)), h("span", { class: "meta" }, copyButton(() => findings.map((f) => `- ${f.text}`).join("\n"), "Copy all"))),
    h("div", { class: "bd flush" }, list),
  );
  // Newest first. findings.md is append-only, so file order is time order.
  const newest = [...findings].reverse();
  const shown = showAll ? newest : newest.slice(0, FINDINGS_SHOWN);
  let lastDay = "";
  for (const f of shown) {
    const d = new Date(f.at);
    const valid = !Number.isNaN(d.getTime());
    const day = valid ? dayLabel(d) : "";
    if (day && day !== lastDay) list.append(h("li", { class: "day" }, day));
    lastDay = day || lastDay;
    list.append(
      h(
        "li",
        {},
        h(
          "span",
          { class: "when" },
          h("time", { datetime: f.at, title: fullDate(f.at) }, valid ? clock(d) : f.at || ""),
          f.by === "auto" ? h("span", { class: "tag auto", title: "Written by the status model" }, "auto") : null,
        ),
        renderMarkdown(f.text),
        copyButton(() => f.text),
      ),
    );
  }
  const hidden = newest.length - shown.length;
  if (hidden) {
    const more = h("button", { class: "btn", type: "button" }, `Show ${hidden} older`);
    more.addEventListener("click", () => card.replaceWith(findingsCard(findings, true)));
    list.append(h("li", { class: "more" }, more));
  }
  return collapsible(card, "_findings");
}

const rawUrl = (id, sec, bust = true) =>
  `/s/${encodeURIComponent(id)}/f/${encodeURIComponent(sec.file)}${bust ? `?v=${encodeURIComponent(sec.at || "")}` : ""}`;

function sectionCard(id, sec) {
  const meta = h(
    "span",
    { class: "meta" },
    sec.by === "auto" ? h("span", { class: "tag auto", title: "Kept up to date automatically" }, "auto") : null,
    h("span", { class: "tag" }, sec.kind),
    agoEl(sec.at),
  );
  if (["markdown", "mermaid", "diff", "chart", "stats", "table", "steps", "timeline"].includes(sec.kind)) {
    const src = copyButton(async () => (await fetch(rawUrl(id, sec))).text(), "Copy source");
    src.dataset.yank = "source"; // yc presses it
    meta.append(src);
  }
  if (sec.file) meta.append(clipButton(() => rawUrl(id, sec, false)));
  meta.append(h("a", { class: "btn", href: rawUrl(id, sec, false), target: "_blank", title: "Open in a new tab" }, "↗"));
  const flush = sec.kind === "html" || sec.kind === "html-plan";
  const bd = h("div", { class: `bd${flush ? " flush" : ""}` });
  const el = h("section", { class: "card", id: `sec-${sec.id}` }, h("h2", {}, h("span", { class: "title", title: sec.title || sec.id }, sec.title || sec.id), meta), bd);
  return collapsible(
    el,
    sec.id,
    () =>
      sectionBody(id, sec).then(
        (body) => bd.replaceChildren(body),
        (e) => bd.replaceChildren(h("div", { class: "err" }, String(e))),
      ),
    WIDGETS.includes(sec.id) ? undefined : sec.at, // widgets never fold by age
  );
}

// ── charts ─────────────────────────────────────────────────────────────────────
// A chart section is a small JSON spec drawn here as SVG. Colours are CSS
// variables (--c1…--c8 and the status colours), so light and dark need no
// redraw. It redraws on width changes so text stays its real size.
// { type: bar|line|area|scatter|pie|donut, labels, series: [{ name, data, color }],
//   stacked, horizontal, x: { label }, y: { label, unit, prefix, min, max }, height, caption }

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null && k !== false) el.append(typeof k === "string" || typeof k === "number" ? String(k) : k);
  return el;
}
const tip = (text) => svg("title", {}, text);
const NAMED = new Set(["accent", "ok", "warn", "bad", "ink", "dim"]);
const seriesColor = (s, i) => (/^c[1-8]$/.test(s?.color) || NAMED.has(s?.color) ? `var(--${s.color})` : `var(--c${(i % 8) + 1})`);
const textW = (s) => String(s).length * 6.4;
const clip = (s, n = 18) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function niceScale(lo, hi, count) {
  if (!(hi > lo)) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(lo, 0), Math.max(hi, 0) || Math.abs(lo)];
  const raw = (hi - lo) / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo: a, hi: b, ticks };
}

function fmtValue(v, axis = {}, tick = false) {
  const abs = Math.abs(v);
  const opts = abs >= 1e5 ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: abs > 0 && abs < 1 ? 3 : 2 };
  const unit = axis.unit ? (axis.unit === "%" ? "%" : tick && axis.unit.length > 3 ? "" : `\u2009${axis.unit}`) : "";
  return `${axis.prefix ?? ""}${new Intl.NumberFormat(undefined, opts).format(v)}${unit}`;
}

function renderChart(spec) {
  const pie = spec.type === "pie" || spec.type === "donut";
  const series = spec.series || [];
  const legend = pie
    ? (() => {
        const data = series[0]?.data || [];
        const total = data.reduce((a, b) => a + (b || 0), 0) || 1;
        return (spec.labels || []).map((l, i) => [l, `var(--c${(i % 8) + 1})`, ` ${fmtValue(data[i] ?? 0, spec.y)} · ${Math.round(((data[i] || 0) / total) * 100)}%`]);
      })()
    : series.length > 1
      ? series.map((s, i) => [s.name || `Series ${i + 1}`, seriesColor(s, i), ""])
      : [];
  const plot = h("div", { class: "chart-plot" });
  const wrap = h(
    "figure",
    { class: "chart" },
    legend.length ? h("div", { class: "chart-legend" }, legend.map(([name, color, extra]) => h("span", {}, h("i", { style: `background:${color}` }), name, extra ? h("em", {}, extra) : null))) : null,
    plot,
    spec.caption ? h("figcaption", { class: "chart-cap" }, spec.caption) : null,
  );
  let lastW = 0;
  const draw = () => {
    const w = Math.floor(plot.clientWidth);
    if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    try {
      plot.replaceChildren(pie ? drawPie(spec, w) : drawXY(spec, w));
    } catch (e) {
      plot.replaceChildren(h("div", { class: "err" }, `chart: ${e.message}`));
    }
  };
  new ResizeObserver(draw).observe(plot);
  return wrap;
}

function drawXY(spec, W) {
  const type = spec.type;
  const series = spec.series;
  const scatter = type === "scatter";
  const horiz = type === "bar" && !!spec.horizontal;
  const stacked = !!spec.stacked && (type === "bar" || type === "area");
  const labels = scatter ? [] : (spec.labels || []).map(String);
  const n = labels.length;
  const ya = spec.y || {};
  const xa = spec.x || {};
  const pts = (s) => s.data.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], label: p[2] } : p)).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));

  // Value domain, with stacks summed and bars and areas reaching zero.
  let vals = [];
  if (scatter) vals = series.flatMap((s) => pts(s).map((p) => p.y));
  else if (stacked)
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of series) (s.data[i] ?? 0) >= 0 ? (pos += s.data[i] ?? 0) : (neg += s.data[i]);
      vals.push(pos, neg);
    }
  else vals = series.flatMap((s) => s.data.filter((v) => Number.isFinite(v)));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (type === "bar" || type === "area") (lo = Math.min(0, lo)), (hi = Math.max(0, hi));
  const H = Math.min(Math.max(spec.height || (horiz ? n * (series.length > 1 && !stacked ? series.length * 13 + 12 : 28) + 44 : 280), 120), 900);
  const vs = niceScale(ya.min ?? lo, ya.max ?? hi, horiz ? Math.max(2, Math.floor(W / 120)) : Math.max(2, Math.floor(H / 56)));
  if (ya.min != null) (vs.lo = ya.min), (vs.ticks = vs.ticks.filter((t) => t >= ya.min));
  if (ya.max != null) (vs.hi = ya.max), (vs.ticks = vs.ticks.filter((t) => t <= ya.max));

  const tickLabels = vs.ticks.map((t) => fmtValue(t, ya, true));
  const top = 8;
  const right = 14;
  let left;
  let bottom = 22 + (horiz ? (ya.label ? 16 : 0) : xa.label ? 16 : 0);
  if (horiz) left = Math.min(Math.max(...labels.map((l) => textW(clip(l, 24)))) + 12, W * 0.4);
  else left = Math.max(...tickLabels.map(textW)) + 10 + (ya.label ? 16 : 0);
  const pw = Math.max(W - left - right, 40);
  const ph = Math.max(H - top - bottom, 40);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  const grid = svg("g", { class: "grid" });
  const axis = svg("g", { class: "axis" });
  const marks = svg("g", { class: "marks" });
  root.append(grid, marks, axis);
  const span = vs.hi - vs.lo || 1;
  const vpos = horiz ? (v) => left + ((v - vs.lo) / span) * pw : (v) => top + (1 - (v - vs.lo) / span) * ph;
  const zero = vpos(Math.min(Math.max(0, vs.lo), vs.hi));

  // Value gridlines and their labels.
  vs.ticks.forEach((t, i) => {
    const p = vpos(t);
    const cls = t === 0 ? "zero" : null;
    if (horiz) {
      grid.append(svg("line", { x1: p, x2: p, y1: top, y2: top + ph, class: cls }));
      axis.append(svg("text", { x: p, y: top + ph + 15, "text-anchor": "middle" }, tickLabels[i]));
    } else {
      grid.append(svg("line", { x1: left, x2: left + pw, y1: p, y2: p, class: cls }));
      axis.append(svg("text", { x: left - 6, y: p + 3.5, "text-anchor": "end" }, tickLabels[i]));
    }
  });
  const valueLabel = ya.label;
  if (valueLabel && horiz) axis.append(svg("text", { class: "al", x: left + pw / 2, y: H - 4, "text-anchor": "middle" }, valueLabel));
  if (valueLabel && !horiz) axis.append(svg("text", { class: "al", transform: `translate(11 ${top + ph / 2}) rotate(-90)`, "text-anchor": "middle" }, valueLabel));
  if (xa.label && !horiz) axis.append(svg("text", { class: "al", x: left + pw / 2, y: H - 4, "text-anchor": "middle" }, xa.label));

  if (scatter) {
    const xs = series.flatMap((s) => pts(s).map((p) => p.x));
    const xsc = niceScale(xa.min ?? Math.min(...xs), xa.max ?? Math.max(...xs), Math.max(2, Math.floor(pw / 90)));
    const xspan = xsc.hi - xsc.lo || 1;
    const xpos = (v) => left + ((v - xsc.lo) / xspan) * pw;
    for (const t of xsc.ticks) {
      grid.append(svg("line", { x1: xpos(t), x2: xpos(t), y1: top, y2: top + ph, class: "minor" }));
      axis.append(svg("text", { x: xpos(t), y: top + ph + 15, "text-anchor": "middle" }, fmtValue(t, xa, true)));
    }
    series.forEach((s, si) => {
      const color = seriesColor(s, si);
      for (const p of pts(s)) marks.append(svg("circle", { class: "pt", cx: xpos(p.x), cy: vpos(p.y), r: 4, style: `fill:${color}` }, tip(`${p.label ? `${p.label}: ` : ""}${s.name ? `${s.name} · ` : ""}${fmtValue(p.x, xa)}, ${fmtValue(p.y, ya)}`)));
    });
    return root;
  }

  // Categories: one band each, labels thinned to fit.
  const band = (horiz ? ph : pw) / Math.max(n, 1);
  const cpos = (i) => (horiz ? top : left) + (i + 0.5) * band;
  if (horiz) {
    labels.forEach((l, i) => axis.append(svg("text", { x: left - 6, y: cpos(i) + 3.5, "text-anchor": "end" }, clip(l, 24), l.length > 24 ? tip(l) : null)));
  } else {
    const every = Math.max(1, Math.ceil((Math.max(...labels.map((l) => textW(clip(l)))) + 10) / band));
    labels.forEach((l, i) => i % every === 0 && axis.append(svg("text", { x: cpos(i), y: top + ph + 15, "text-anchor": "middle" }, clip(l), l.length > 18 ? tip(l) : null)));
  }

  if (type === "bar") {
    const group = band * (n > 1 ? 0.74 : 0.5);
    const bw = stacked ? group : group / series.length;
    const pos = new Array(n).fill(0);
    const neg = new Array(n).fill(0);
    series.forEach((s, si) => {
      const color = seriesColor(s, si);
      s.data.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        let a = 0;
        if (stacked) v >= 0 ? ((a = pos[i]), (pos[i] += v)) : ((a = neg[i]), (neg[i] += v));
        const p0 = vpos(a);
        const p1 = vpos(a + v);
        const off = cpos(i) - group / 2 + (stacked ? 0 : si * bw);
        const thick = Math.max(bw - (stacked || series.length === 1 ? 0 : 1.5), 1);
        const rect = horiz
          ? { x: Math.min(p0, p1), y: off, width: Math.max(Math.abs(p1 - p0), 0.5), height: thick }
          : { x: off, y: Math.min(p0, p1), width: thick, height: Math.max(Math.abs(p1 - p0), 0.5) };
        marks.append(svg("rect", { class: "bar", ...rect, rx: Math.min(2.5, thick / 4), style: `fill:${color}` }, tip(`${labels[i]}${s.name ? ` · ${s.name}` : ""}: ${fmtValue(v, ya)}`)));
      });
    });
    return root;
  }

  // Lines and areas: points at band centres, a gap for each null.
  const base = new Array(n).fill(0);
  series.forEach((s, si) => {
    const color = seriesColor(s, si);
    const tops = s.data.map((v, i) => (Number.isFinite(v) ? (stacked ? base[i] + v : v) : null));
    const runs = [];
    let run = [];
    tops.forEach((v, i) => (v == null ? (run.length && runs.push(run), (run = [])) : run.push(i)));
    if (run.length) runs.push(run);
    for (const r of runs) {
      const line = r.map((i, k) => `${k ? "L" : "M"}${cpos(i).toFixed(1)},${vpos(tops[i]).toFixed(1)}`).join("");
      if (type === "area") {
        const back = r
          .slice()
          .reverse()
          .map((i) => `L${cpos(i).toFixed(1)},${(stacked ? vpos(base[i]) : zero).toFixed(1)}`)
          .join("");
        marks.append(svg("path", { class: "area", d: `${line}${back}Z`, style: `fill:${color}` }));
      }
      marks.append(svg("path", { class: "line", d: line, style: `stroke:${color}` }));
    }
    if (n <= 80)
      s.data.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        marks.append(svg("circle", { class: "pt", cx: cpos(i), cy: vpos(tops[i]), r: n <= 24 ? 3.2 : 2.2, style: `fill:${color}` }, tip(`${labels[i]}${s.name ? ` · ${s.name}` : ""}: ${fmtValue(v, ya)}`)));
      });
    if (stacked) tops.forEach((v, i) => v != null && (base[i] = v));
  });
  return root;
}

function drawPie(spec, W) {
  const data = (spec.series[0]?.data || []).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const labels = (spec.labels || []).map(String);
  const total = data.reduce((a, b) => a + b, 0);
  const H = Math.min(Math.max(spec.height || 240, 120), 900);
  const r = Math.min(H / 2 - 6, W / 2 - 6);
  const inner = spec.type === "donut" ? r * 0.6 : 0;
  const cx = W / 2;
  const cy = H / 2;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  if (!total) return root;
  const at = (a, rad) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  let a0 = 0;
  data.forEach((v, i) => {
    if (!v) return;
    const a1 = a0 + (v / total) * Math.PI * 2;
    const color = `var(--c${(i % 8) + 1})`;
    const label = `${labels[i] ?? ""}: ${fmtValue(v, spec.y)} (${Math.round((v / total) * 100)}%)`;
    if (v === total) {
      marks(svg("circle", { class: "slice", cx, cy, r, style: `fill:${color}` }, tip(label)));
    } else {
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = at(a0, r);
      const [x1, y1] = at(a1, r);
      let d = `M${cx},${cy}L${x0},${y0}A${r},${r} 0 ${big} 1 ${x1},${y1}Z`;
      if (inner) {
        const [ix0, iy0] = at(a0, inner);
        const [ix1, iy1] = at(a1, inner);
        d = `M${ix0},${iy0}L${x0},${y0}A${r},${r} 0 ${big} 1 ${x1},${y1}L${ix1},${iy1}A${inner},${inner} 0 ${big} 0 ${ix0},${iy0}Z`;
      }
      marks(svg("path", { class: "slice", d, style: `fill:${color}` }, tip(label)));
    }
    a0 = a1;
  });
  if (inner) {
    if (data.filter(Boolean).length === 1) root.append(svg("circle", { cx, cy, r: inner, class: "hole" }));
    root.append(svg("text", { class: "total", x: cx, y: cy + 2, "text-anchor": "middle" }, fmtValue(total, spec.y)), svg("text", { x: cx, y: cy + 18, "text-anchor": "middle" }, "total"));
  }
  return root;
  function marks(el) {
    root.append(el);
  }
}

// ── terminal ─────────────────────────────────────────────────────────────────────
// Command output with its ANSI colours (mapped to --t0…--t15 so they follow
// the theme), a header with the command, exit code and duration, the middle of
// long output folded, and a filter box. Output without colour gets error,
// warning and pass lines tinted.

function applySgr(style, params) {
  const p = params === "" ? [0] : params.split(";").map(Number);
  const c256 = (n) => {
    if (n < 16) return n;
    if (n >= 232) return `rgb(${[0, 0, 0].map(() => 8 + (n - 232) * 10).join(",")})`;
    const v = (x) => (x ? x * 40 + 55 : 0);
    n -= 16;
    return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`;
  };
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) for (const k of Object.keys(style)) delete style[k];
    else if (n === 1) style.b = 1;
    else if (n === 2) style.dim = 1;
    else if (n === 3) style.i = 1;
    else if (n === 4) style.u = 1;
    else if (n === 7) style.inv = 1;
    else if (n === 22) delete style.b, delete style.dim;
    else if (n === 23) delete style.i;
    else if (n === 24) delete style.u;
    else if (n === 27) delete style.inv;
    else if (n >= 30 && n <= 37) style.fg = n - 30;
    else if (n >= 90 && n <= 97) style.fg = n - 90 + 8;
    else if (n === 39) delete style.fg;
    else if (n >= 40 && n <= 47) style.bg = n - 40;
    else if (n >= 100 && n <= 107) style.bg = n - 100 + 8;
    else if (n === 49) delete style.bg;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg";
      if (p[i + 1] === 5) (style[key] = c256(p[i + 2] || 0)), (i += 2);
      else if (p[i + 1] === 2) (style[key] = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`), (i += 4);
    }
  }
}

/** Output split into lines of [text, style] runs, with \r redraws applied and other escapes dropped. */
function parseAnsi(text) {
  const lines = [];
  const style = {};
  let segs = [];
  let plain = "";
  const push = (t) => {
    t = t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (t) segs.push([t, { ...style }]), (plain += t);
  };
  const end = () => {
    lines.push({ segs, plain });
    segs = [];
    plain = "";
  };
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\r\n|\n|\r/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[0] === "\n" || m[0] === "\r\n") end();
    else if (m[0] === "\r") (segs = []), (plain = "");
    else if (m[2] === "m") applySgr(style, m[1]);
  }
  push(text.slice(last));
  if (segs.length || plain) end();
  return lines;
}

function ansiCss(st) {
  const color = (c) => (typeof c === "number" ? `var(--t${c})` : c);
  let fg = st.fg != null ? color(st.fg) : null;
  let bg = st.bg != null ? color(st.bg) : null;
  if (st.inv) [fg, bg] = [bg || "var(--code)", fg || "var(--ink)"];
  return [fg && `color:${fg}`, bg && `background:${bg}`, st.b && "font-weight:700", st.dim && "opacity:.65", st.i && "font-style:italic", st.u && "text-decoration:underline"].filter(Boolean).join(";");
}

const lineTint = (s) =>
  /(?<!\b0 )\b(error|errors|failed|failure|fatal|panic|exception)\b|✖|✗|^\s*not ok\b|^\s*FAIL\b/i.test(s)
    ? " bad"
    : /\b(warn|warning|deprecated)\b/i.test(s)
      ? " warn"
      : /✔|✓|^\s*ok\b|^\s*PASS\b|(?<!\b0 )\bpassed\b/.test(s)
        ? " ok"
        : "";

function fmtSeconds(s) {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function renderTerminal(spec) {
  const output = spec.output || "";
  const lines = parseAnsi(output);
  const colored = /\x1b\[[0-9;]*m/.test(output);
  const count = h("span", { class: "term-count" });
  const filter = lines.length > 15 ? h("input", { class: "term-filter", type: "search", placeholder: "Filter lines", "aria-label": "Filter lines" }) : null;
  const head = h(
    "div",
    { class: "term-head" },
    h("code", { class: "term-cmd" }, spec.command ? [h("span", { class: "term-ps" }, "$ "), spec.command] : h("span", { class: "term-ps" }, "output")),
    h(
      "span",
      { class: "term-meta" },
      spec.cwd ? h("span", { title: spec.cwd }, tilde(spec.cwd)) : null,
      spec.duration != null ? h("span", {}, typeof spec.duration === "number" ? fmtSeconds(spec.duration) : spec.duration) : null,
      spec.exit != null ? h("span", { class: `term-exit ${spec.exit === 0 ? "ok" : "bad"}` }, `exit ${spec.exit}`) : null,
      h("span", {}, `${lines.length.toLocaleString()} line${lines.length === 1 ? "" : "s"}`),
    ),
  );
  const copy = copyButton(() => lines.map((l) => l.plain).join("\n"), "Copy output");
  const tools = filter ? h("div", { class: "term-tools" }, filter, count, copy) : null;
  if (!filter) head.lastChild.append(copy);
  const body = h("div", { class: "term-body" });
  const lineEl = (l, i, q) => {
    const text = h("span", { class: "tx" });
    if (q) {
      // Filtered lines show plain text with the matches marked.
      const low = l.plain.toLowerCase();
      let at = 0;
      for (let k = low.indexOf(q); k >= 0; k = low.indexOf(q, at)) {
        text.append(l.plain.slice(at, k), h("mark", {}, l.plain.slice(k, k + q.length)));
        at = k + q.length;
      }
      text.append(l.plain.slice(at));
    } else for (const [t, st] of l.segs) text.append(Object.keys(st).length ? h("span", { style: ansiCss(st) }, t) : t);
    return h("div", { class: `tl${colored ? "" : lineTint(l.plain)}` }, h("span", { class: "ln" }, i + 1), text);
  };
  const HEAD = 30;
  const TAIL = 40;
  let expanded = false;
  const draw = () => {
    const q = filter?.value.trim().toLowerCase() || "";
    body.replaceChildren();
    if (q) {
      const hits = [];
      lines.forEach((l, i) => l.plain.toLowerCase().includes(q) && hits.push(i));
      for (const i of hits.slice(0, 2000)) body.append(lineEl(lines[i], i, q));
      if (!hits.length) body.append(h("div", { class: "term-none" }, "No lines match"));
      count.textContent = `${hits.length.toLocaleString()} of ${lines.length.toLocaleString()}`;
      return;
    }
    count.textContent = "";
    if (expanded || lines.length <= HEAD + TAIL + 10) lines.forEach((l, i) => body.append(lineEl(l, i)));
    else {
      lines.slice(0, HEAD).forEach((l, i) => body.append(lineEl(l, i)));
      const hidden = lines.length - HEAD - TAIL;
      body.append(h("button", { class: "term-fold", type: "button", onclick: () => ((expanded = true), draw()) }, `Show ${hidden.toLocaleString()} more lines`));
      lines.slice(-TAIL).forEach((l, k) => body.append(lineEl(l, lines.length - TAIL + k)));
    }
    if (!lines.length) body.append(h("div", { class: "term-none" }, "No output"));
  };
  filter?.addEventListener("input", draw);
  draw();
  return h("div", { class: "term" }, head, tools, body);
}

// ── stats ──────────────────────────────────────────────────────────────────────────

/** A small line of numbers with a dot on the last one; null leaves a gap. */
function sparkSvg(data, w = 90, hgt = 26, color = "var(--accent)") {
  const vals = (data || []).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo || 1;
  const x = (i) => 2 + (i / (data.length - 1)) * (w - 4);
  const y = (v) => 3 + (1 - (v - lo) / span) * (hgt - 6);
  let d = "";
  let pen = false;
  data.forEach((v, i) => {
    if (!Number.isFinite(v)) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  let li = data.length - 1;
  while (li > 0 && !Number.isFinite(data[li])) li--;
  return svg("svg", { class: "spark", viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, "aria-hidden": "true" }, svg("path", { d, style: `stroke:${color}` }), svg("circle", { cx: x(li), cy: y(data[li]), r: 2.2, style: `fill:${color}` }));
}

function renderStats(spec) {
  const items = spec.items || [];
  return h(
    "div",
    { class: "stats" },
    items.map((it) => {
      const color = /^c[1-8]$/.test(it.color) || NAMED.has(it.color) ? `var(--${it.color})` : "var(--accent)";
      const value = typeof it.value === "number" ? fmtValue(it.value, it) : `${it.prefix ?? ""}${it.value}${it.unit ? `\u2009${it.unit}` : ""}`;
      let delta = null;
      if (it.delta != null && it.delta !== "") {
        const dir = typeof it.delta === "number" ? Math.sign(it.delta) : /^\s*-/.test(it.delta) ? -1 : /^\s*\+/.test(it.delta) ? 1 : 0;
        const text = typeof it.delta === "number" ? fmtValue(Math.abs(it.delta), { unit: it.unit === "%" ? "%" : "" }) : String(it.delta).replace(/^\s*[+-]\s*/, "");
        const good = it.good || "up";
        const cls = !dir || good === "none" ? "flat" : (dir > 0) === (good === "up") ? "ok" : "bad";
        delta = h("span", { class: `stat-delta ${cls}` }, `${dir > 0 ? "↑" : dir < 0 ? "↓" : "→"} ${text}`);
      }
      return h(
        "div",
        { class: "stat" },
        h("div", { class: "stat-label" }, it.label),
        h("div", { class: "stat-row" }, h("b", { class: "stat-value", style: it.color ? `color:${color}` : null }, value), delta),
        it.spark ? sparkSvg(it.spark, 120, 28, color) : null,
        it.note ? h("div", { class: "stat-note" }, it.note) : null,
      );
    }),
  );
}

// ── table ──────────────────────────────────────────────────────────────────────────
// Rows from JSON or CSV: click a header to sort (asc, desc, off), type to
// filter, typed cells (number, bar, spark, tag, link, code), 500 rows at a time.

const TAG_TONE = [
  [/^(ok|pass(ed|ing)?|success(ful)?|succeeded|done|yes|up|green|healthy|merged|open|active)$/i, "ok"],
  [/^(fail(ed|ing|ure)?|error|errored|broken|no|down|red|critical|high|blocked)$/i, "bad"],
  [/^(warn(ing)?|pending|queued|running|medium|yellow|slow|draft|skipped|flaky)$/i, "warn"],
];

function renderTable(spec) {
  const rows = spec.rows || [];
  let cols = spec.columns;
  if (!cols) cols = Array.isArray(rows[0]) ? rows[0].map((_, i) => `Column ${i + 1}`) : [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
  cols = cols.map((c, i) => (typeof c === "string" ? { label: c, key: c } : { ...c, label: c.label ?? c.key, key: c.key ?? c.label ?? String(i) }));
  const data = rows.map((r) => cols.map((c, i) => (Array.isArray(r) ? r[i] : r?.[c.key])));
  for (const [i, c] of cols.entries()) {
    if (c.type) continue;
    const vals = data.map((r) => r[i]).filter((v) => v != null && v !== "");
    c.type = !vals.length ? "text" : vals.every((v) => typeof v === "number") ? "number" : vals.every((v) => Array.isArray(v) && v.every((x) => x === null || typeof x === "number")) ? "spark" : "text";
  }
  const max = cols.map((c, i) => (c.type === "bar" ? Math.max(0, ...data.map((r) => (Number.isFinite(r[i]) ? Math.abs(r[i]) : 0))) : 0));
  const text = (v) => (v == null ? "" : Array.isArray(v) ? "" : typeof v === "object" ? String(v.text ?? v.href ?? "") : String(v));
  const haystack = data.map((r) => r.map(text).join(" \u0001 ").toLowerCase());
  const sortKey = (v, c) => (c.type === "spark" ? (Array.isArray(v) ? v.filter(Number.isFinite).at(-1) : null) : c.type === "number" || c.type === "bar" ? (Number.isFinite(v) ? v : null) : text(v) || null);

  const cell = (v, c, i) => {
    if (v == null || v === "") return h("td", { class: "nil" }, "–");
    switch (c.type) {
      case "number":
        return h("td", { class: "num" }, typeof v === "number" ? fmtValue(v, c) : String(v));
      case "bar": {
        const pct = max[i] && Number.isFinite(v) ? (Math.abs(v) / max[i]) * 100 : 0;
        return h("td", { class: "barc" }, h("div", {}, h("span", { class: "cbar" }, h("i", { style: `width:${pct.toFixed(1)}%` })), h("span", { class: "num" }, Number.isFinite(v) ? fmtValue(v, c) : String(v))));
      }
      case "spark":
        return h("td", { class: "sparkc" }, Array.isArray(v) ? sparkSvg(v, 84, 20) || "–" : String(v));
      case "tag": {
        const tone = TAG_TONE.find(([re]) => re.test(String(v).trim()))?.[1];
        return h("td", {}, h("span", { class: `ctag${tone ? ` ${tone}` : ""}` }, String(v)));
      }
      case "link": {
        const href = typeof v === "object" ? v.href : v;
        const label = typeof v === "object" ? v.text ?? v.href : v;
        return h("td", {}, /^https?:\/\//i.test(String(href)) ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, String(label)) : String(label));
      }
      case "code":
        return h("td", {}, h("code", {}, String(v)));
      default:
        return h("td", {}, text(v));
    }
  };

  const startCol = spec.sort ? cols.findIndex((c, i) => c.key === spec.sort.column || c.label === spec.sort.column || i === spec.sort.column) : -1;
  const sort = { col: startCol, desc: !!spec.sort?.desc };
  let limit = 500;
  const filter = rows.length > 8 ? h("input", { class: "tbl-filter", type: "search", placeholder: `Filter ${rows.length.toLocaleString()} rows`, "aria-label": "Filter rows" }) : null;
  const count = h("span", { class: "tbl-count" });
  const thead = h("thead");
  const tbody = h("tbody");
  const more = h("div", { class: "tbl-more" });
  const draw = () => {
    const q = filter?.value.trim().toLowerCase() || "";
    let order = data.map((_, i) => i);
    if (q) order = order.filter((i) => haystack[i].includes(q));
    if (sort.col >= 0) {
      const c = cols[sort.col];
      const keys = data.map((r) => sortKey(r[sort.col], c));
      order.sort((a, b) => {
        const x = keys[a];
        const y = keys[b];
        if (x == null || y == null) return x == null ? (y == null ? a - b : 1) : -1; // empties last
        const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
        return (sort.desc ? -d : d) || a - b;
      });
    }
    thead.replaceChildren(
      h(
        "tr",
        {},
        cols.map((c, i) => {
          const on = sort.col === i;
          const right = c.type === "number" || c.align === "right";
          return h(
            "th",
            { class: right ? "num" : null, "aria-sort": on ? (sort.desc ? "descending" : "ascending") : "none" },
            h(
              "button",
              {
                type: "button",
                class: `tbl-sort${on ? " on" : ""}`,
                title: "Sort",
                onclick: () => {
                  // Numbers start high-first, text A-Z; a third click turns sorting off.
                  const firstDesc = c.type === "number" || c.type === "bar" || c.type === "spark";
                  if (!on) Object.assign(sort, { col: i, desc: firstDesc });
                  else if (sort.desc === firstDesc) sort.desc = !sort.desc;
                  else sort.col = -1;
                  draw();
                },
              },
              c.label,
              h("span", { class: "arrow" }, on ? (sort.desc ? "▼" : "▲") : "↕"),
            ),
          );
        }),
      ),
    );
    tbody.replaceChildren(...order.slice(0, limit).map((ri) => h("tr", {}, cols.map((c, i) => cell(data[ri][i], c, i)))));
    if (!order.length) tbody.append(h("tr", {}, h("td", { class: "nil", colspan: cols.length }, "No rows match")));
    count.textContent = q ? `${order.length.toLocaleString()} of ${rows.length.toLocaleString()} rows` : `${rows.length.toLocaleString()} rows`;
    more.replaceChildren(
      order.length > limit ? h("button", { class: "term-fold", type: "button", onclick: () => ((limit += 1000), draw()) }, `Show ${Math.min(1000, order.length - limit).toLocaleString()} more of ${(order.length - limit).toLocaleString()}`) : "",
    );
  };
  filter?.addEventListener("input", () => ((limit = 500), draw()));
  draw();
  return h(
    "div",
    { class: "tbl" },
    h("div", { class: "tbl-tools" }, filter, count),
    h("div", { class: "tbl-scroll" }, h("table", { class: "ktable" }, thead, tbody)),
    more,
    spec.caption ? h("div", { class: "chart-cap" }, spec.caption) : null,
  );
}

// ── compare ────────────────────────────────────────────────────────────────────────
// Two images: a slider (before on the left, after on the right; drag, or the
// arrow keys), side by side, or onion skin (after over before, faded). The
// view is remembered per browser unless the section asks for one.

function renderCompare(spec, src) {
  const [la, lb] = spec.labels || ["Before", "After"];
  let mode = spec.mode || localStorage.getItem("canvas:compare-mode") || "slider";
  const img = (file, alt, cls) => h("img", { src: src(file), alt, class: cls, draggable: "false" });
  const stage = h("div", { class: "cmp-stage" });
  const fade = h("input", { type: "range", min: 0, max: 100, value: 50, class: "cmp-fade", "aria-label": `${lb} opacity` });
  const modes = h("span", { class: "segs" });
  const draw = () => {
    modes.replaceChildren(
      ...[
        ["slider", "Slider"],
        ["side", "Side by side"],
        ["onion", "Onion skin"],
      ].map(([m, label]) => h("button", { type: "button", class: `seg${m === mode ? " on" : ""}`, onclick: () => ((mode = m), localStorage.setItem("canvas:compare-mode", m), draw()) }, label)),
    );
    fade.hidden = mode !== "onion";
    if (mode === "side") {
      stage.replaceChildren(h("div", { class: "cmp-side" }, [[spec.before, la], [spec.after, lb]].map(([f, l]) => h("figure", {}, h("figcaption", {}, l), img(f, l)))));
      return;
    }
    const top = img(spec.after, lb, "top");
    const box = h("div", { class: "cmp-stack" }, img(spec.before, la), top);
    if (mode === "onion") {
      const apply = () => (top.style.opacity = String(fade.value / 100));
      fade.oninput = apply;
      apply();
      box.append(h("span", { class: "cmp-tag l" }, `${la} → ${lb}`));
      stage.replaceChildren(box);
      return;
    }
    const handle = h("div", { class: "cmp-handle" }, h("span", {}, "⟷"));
    box.append(handle, h("span", { class: "cmp-tag l" }, la), h("span", { class: "cmp-tag r" }, lb));
    Object.assign(box, { tabIndex: 0 });
    box.setAttribute("role", "slider");
    box.setAttribute("aria-label", `${la} and ${lb}`);
    box.classList.add("slide");
    const set = (p) => {
      p = Math.min(Math.max(p, 0), 100);
      top.style.clipPath = `inset(0 0 0 ${p}%)`;
      handle.style.left = `${p}%`;
      box.setAttribute("aria-valuenow", String(Math.round(p)));
      box.dataset.pos = String(p);
    };
    const at = (e) => {
      const r = box.getBoundingClientRect();
      set(((e.clientX - r.left) / r.width) * 100);
    };
    box.addEventListener("pointerdown", (e) => {
      box.setPointerCapture(e.pointerId);
      at(e);
    });
    box.addEventListener("pointermove", (e) => box.hasPointerCapture(e.pointerId) && at(e));
    box.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 2;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        set(Number(box.dataset.pos) + (e.key === "ArrowLeft" ? -step : step));
      }
    });
    set(50);
    stage.replaceChildren(box);
  };
  draw();
  return h("div", { class: "cmp" }, h("div", { class: "cmp-bar" }, modes, fade), stage);
}

// ── steps ───────────────────────────────────────────────────────────────────────────
// A checklist with a progress bar; the agent replaces the section as steps move.

const STEP_ICON = { done: "✓", active: "", failed: "✕", skipped: "–", blocked: "!", todo: "" };

function renderSteps(spec) {
  const steps = spec.steps || [];
  const n = (s) => steps.filter((x) => x.status === s).length;
  const counted = steps.length - n("skipped");
  const pct = counted ? (n("done") / counted) * 100 : 100;
  const extra = [n("failed") && h("span", { class: "bad" }, `${n("failed")} failed`), n("blocked") && h("span", { class: "warn" }, `${n("blocked")} blocked`), n("skipped") && h("span", {}, `${n("skipped")} skipped`)].filter(Boolean);
  return h(
    "div",
    { class: "steps" },
    h(
      "div",
      { class: "steps-head" },
      spec.title ? h("b", {}, spec.title) : null,
      h("span", { class: "steps-count" }, `${n("done")} of ${counted} done`, extra.flatMap((e) => [" · ", e])),
      h("span", { class: `steps-bar${n("failed") ? " bad" : ""}`, role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${pct.toFixed(1)}%` })),
    ),
    h(
      "ol",
      { class: "steps-list" },
      steps.map((s) =>
        h(
          "li",
          { class: `step s-${s.status}` },
          h("span", { class: "smark", title: s.status }, STEP_ICON[s.status] ?? ""),
          h("div", { class: "sbody" }, h("div", { class: "slabel" }, s.label), s.note ? h("div", { class: "snote" }, s.note) : null, s.detail ? h("pre", { class: "sdetail" }, s.detail) : null),
        ),
      ),
    ),
  );
}

// ── json ────────────────────────────────────────────────────────────────────────────
// A collapsible tree, built lazily as nodes open. Two levels open to start;
// the filter keeps the paths to matching keys and values and opens them.
// Clicking a key copies its jq-style path.

function renderJson(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return h("pre", { class: "err" }, `Not JSON: ${e.message}`);
  }
  const isObj = (v) => v && typeof v === "object";
  // jq-style paths: the root is ".", its children ".key" and ".[0]".
  const childPath = (p, k) => {
    const b = p === "." ? "" : p;
    if (typeof k === "number") return `${b || "."}[${k}]`;
    return /^[A-Za-z_$][\w$]*$/.test(k) ? `${b}.${k}` : `${b || "."}[${JSON.stringify(k)}]`;
  };
  const entriesOf = (v) => (Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v));
  const filter = h("input", { class: "tbl-filter", type: "search", placeholder: "Filter keys and values", "aria-label": "Filter keys and values" });
  const count = h("span", { class: "tbl-count" });
  const tree = h("div", { class: "jt" });
  let state = { open: "auto", keep: null, q: "", budget: 0 };

  const marked = (s, q) => {
    if (!q) return s;
    const k = s.toLowerCase().indexOf(q);
    return k < 0 ? s : [s.slice(0, k), h("mark", {}, s.slice(k, k + q.length)), s.slice(k + q.length)];
  };
  const prim = (v) => {
    const t = v === null ? "null" : typeof v;
    return h("span", { class: `jv j-${t}` }, marked(t === "string" ? JSON.stringify(v) : String(v), state.q));
  };
  const keyEl = (k, path) =>
    k == null
      ? null
      : h(
          "button",
          {
            type: "button",
            class: `jk${typeof k === "number" ? " idx" : ""}`,
            title: `Copy path ${path}`,
            onclick: async (e) => {
              e.stopPropagation();
              await copyText(path).catch(() => {});
              e.target.classList.add("copied");
              setTimeout(() => e.target.classList.remove("copied"), 900);
            },
          },
          typeof k === "number" ? String(k) : marked(k, state.q),
        );
  const node = (k, v, path, depth, free) => {
    if (!isObj(v)) return h("div", { class: "jn leaf" }, h("span", { class: "jtog" }), keyEl(k, path), k != null ? h("span", { class: "jp" }, ": ") : null, prim(v));
    const entries = entriesOf(v);
    const arr = Array.isArray(v);
    const kids = h("div", { class: "jc" });
    const tog = h("span", { class: "jtog" }, entries.length ? "▸" : "");
    const preview = h("span", { class: "jprev" }, arr ? `[ ${entries.length} item${entries.length === 1 ? "" : "s"} ]` : `{ ${entries.length} key${entries.length === 1 ? "" : "s"} }`);
    const row = h("div", { class: "jrow" }, tog, keyEl(k, path), k != null ? h("span", { class: "jp" }, ": ") : null, preview);
    const wrap = h("div", { class: "jn" }, row, kids);
    let built = false;
    const build = () => {
      built = true;
      const keep = free ? null : state.keep;
      let shown = entries.filter(([ck]) => !keep || keep.has(childPath(path, ck)));
      const LIMIT = 200;
      const add = (from) => {
        for (const [ck, cv] of shown.slice(from, from + LIMIT)) {
          const cp = childPath(path, ck);
          // Below a match, everything shows; elsewhere the filter keeps only paths that lead to one.
          kids.append(node(ck, cv, cp, depth + 1, free || (keep && state.hits.has(cp))));
        }
        if (shown.length > from + LIMIT) {
          const more = h("button", { type: "button", class: "term-fold jmore", onclick: () => (more.remove(), add(from + LIMIT)) }, `Show ${Math.min(LIMIT, shown.length - from - LIMIT)} more of ${shown.length - from - LIMIT}`);
          kids.append(more);
        }
      };
      add(0);
    };
    const set = (open) => {
      if (open && !built) build();
      wrap.classList.toggle("open", open);
      tog.textContent = entries.length ? (open ? "▾" : "▸") : "";
    };
    row.addEventListener("click", () => entries.length && set(!wrap.classList.contains("open")));
    let open;
    if (state.keep && !free) open = true;
    else if (state.open === "all") open = state.budget-- > 0;
    else if (state.open === "none") open = depth === 0;
    else open = depth < 2 && entries.length <= 60;
    if (open && entries.length) set(true);
    return wrap;
  };

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    state.q = q;
    state.keep = null;
    state.hits = new Set();
    if (q) {
      const keep = new Set(["."]);
      let seen = 0;
      const walk = (v, path, k, trail) => {
        if (++seen > 50000 || state.hits.size >= 500) return;
        const hit = (k != null && typeof k === "string" && k.toLowerCase().includes(q)) || (!isObj(v) && String(v).toLowerCase().includes(q));
        if (hit) {
          state.hits.add(path);
          for (const t of trail) keep.add(t);
          keep.add(path);
        }
        if (isObj(v)) for (const [ck, cv] of entriesOf(v)) walk(cv, childPath(path, ck), ck, [...trail, path]);
      };
      walk(root, ".", null, []);
      state.keep = keep;
      count.textContent = `${state.hits.size >= 500 ? "500+" : state.hits.size} match${state.hits.size === 1 ? "" : "es"}`;
    } else count.textContent = "";
    tree.replaceChildren(node(null, root, ".", 0, false));
    if (q && !state.hits.size) tree.replaceChildren(h("div", { class: "term-none" }, "Nothing matches"));
  };
  filter.addEventListener("input", () => ((state.open = "auto"), draw()));
  const btn = (label, mode) => h("button", { type: "button", class: "btn", onclick: () => ((state.open = mode), (state.budget = 3000), (filter.value = ""), draw()) }, label);
  draw();
  return h("div", { class: "jsonv" }, h("div", { class: "tbl-tools" }, filter, count, h("span", { class: "jtools" }, btn("Expand all", "all"), btn("Collapse", "none"), copyButton(() => JSON.stringify(root, null, 2), "Copy JSON"))), tree);
}

// ── timeline ─────────────────────────────────────────────────────────────────────
// Events down a line. When every event has a real time they are sorted
// (unless order is "given"), grouped under day headings, and the gap since
// the previous event is shown; text times are shown as written.

function fmtGap(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(m / 1440);
  const hr = Math.round((m % 1440) / 60);
  return `${d}d${hr ? ` ${hr}h` : ""}`;
}

function renderTimeline(spec) {
  const toDate = (at) => (typeof at === "number" ? new Date(at) : typeof at === "string" && /\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}/.test(at) ? new Date(/^\d{1,2}:\d{2}/.test(at) ? `1970-01-01T${at.padStart(5, "0")}` : at) : null);
  let events = (spec.events || []).map((e, i) => ({ ...e, i, d: toDate(e.at) }));
  const dated = events.every((e) => e.d && !Number.isNaN(e.d.getTime()));
  const timeOnly = dated && events.every((e) => typeof e.at === "string" && /^\d{1,2}:\d{2}/.test(e.at));
  if (dated && spec.order !== "given") events = [...events].sort((a, b) => a.d - b.d || a.i - b.i);
  const list = h("ol", { class: "tline" });
  let lastDay = "";
  let prev = null;
  for (const e of events) {
    if (dated && !timeOnly) {
      const day = e.d.toDateString();
      if (day !== lastDay) list.append(h("li", { class: "tday" }, dayLabel(e.d)));
      lastDay = day;
    }
    const gap = dated && prev ? fmtGap(e.d - prev.d) : "";
    const tone = /^(ok|warn|bad|accent|dim|c[1-8])$/.test(e.tone) ? `var(--${e.tone})` : "var(--line)";
    list.append(
      h(
        "li",
        { class: `tev${e.tone ? " toned" : ""}`, style: `--tone:${tone}` },
        h("div", { class: "twhen" }, h("span", { title: dated && !timeOnly ? e.d.toLocaleString() : null }, dated ? (timeOnly ? e.at : clock(e.d)) : e.at ?? ""), gap ? h("span", { class: "tgap" }, `+${gap}`) : null),
        h("span", { class: "tdot" }),
        h(
          "div",
          { class: "tbody" },
          h("div", { class: "ttitle" }, e.title, e.tag ? h("span", { class: `ctag${/^(ok|warn|bad)$/.test(e.tone) ? ` ${e.tone}` : ""}` }, e.tag) : null),
          e.note ? h("div", { class: "tnote" }, e.note) : null,
        ),
      ),
    );
    prev = e;
  }
  const span = dated && events.length > 1 ? fmtGap(events.at(-1).d - events[0].d) : "";
  return h("div", { class: "tlw" }, list, spec.caption || span ? h("div", { class: "chart-cap" }, [spec.caption, span && `${events.length} events over ${span}`].filter(Boolean).join(" · ")) : null);
}

// ── diffs ────────────────────────────────────────────────────────────────────
// One renderer for the diff kind, Files changed and the modal: a patch splits
// into files, each a collapsible block with old and new line numbers, unified
// or side by side. Lines are coloured by the file's extension, and paired -/+
// lines mark the words that changed.

const DIFF_LANGS = { rb: "ruby", rake: "ruby", gemspec: "ruby", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript", json: "json", py: "python", rs: "rust", go: "go", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", md: "markdown", html: "xml", erb: "xml", xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less", sql: "sql", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cs: "csharp", ini: "ini", toml: "ini", php: "php", lua: "lua", pl: "perl", graphql: "graphql", mk: "makefile", diff: "diff", patch: "diff" };

function langFor(path) {
  const name = String(path || "").split("/").pop().toLowerCase();
  if (["gemfile", "rakefile", "guardfile", "brewfile"].includes(name)) return "ruby";
  if (name === "makefile") return "makefile";
  return DIFF_LANGS[name.includes(".") ? name.split(".").pop() : ""] || "";
}

/** A patch as files: { from, to, path, status, binary, hunks: [{ head, rows: [{ t, a, b, text }] }], adds, dels }. */
function parsePatch(text) {
  const files = [];
  let f = null;
  let hunk = null;
  let remA = 0;
  let remB = 0;
  const start = () => {
    f = { from: "", to: "", path: "", status: "modified", binary: false, hunks: [], adds: 0, dels: 0, minus: false };
    files.push(f);
    hunk = null;
  };
  const strip = (p) => (p === "/dev/null" ? "" : p.replace(/\t.*$/, "").replace(/^[ab]\//, ""));
  for (const line of text.split("\n")) {
    // Inside a hunk the header's counts say which lines belong to it, so a
    // removed line that reads "-- x" is never taken for a file header.
    if (hunk && (remA > 0 || remB > 0)) {
      const c = line[0];
      if (c === "+") (hunk.rows.push({ t: "add", b: hunk.b++, text: line.slice(1) }), f.adds++, remB--);
      else if (c === "-") (hunk.rows.push({ t: "del", a: hunk.a++, text: line.slice(1) }), f.dels++, remA--);
      else if (c === " " || line === "") (hunk.rows.push({ t: "ctx", a: hunk.a++, b: hunk.b++, text: line.slice(1) }), remA--, remB--);
      else if (c === "\\") hunk.rows.push({ t: "note", text: line.slice(2) });
      else hunk = null;
      if (hunk) continue;
    }
    if (hunk && line.startsWith("\\")) {
      hunk.rows.push({ t: "note", text: line.slice(2) });
      continue;
    }
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) {
      start();
      f.from = m[1];
      f.to = m[2];
    } else if (line.startsWith("--- ")) {
      if (!f || f.hunks.length || f.minus) start();
      f.minus = true;
      f.from = strip(line.slice(4));
      if (!f.from) f.status = "added";
    } else if (line.startsWith("+++ ") && f) {
      f.to = strip(line.slice(4));
      if (!f.to) f.status = "deleted";
    } else if (f && line.startsWith("new file mode")) f.status = "added";
    else if (f && line.startsWith("deleted file mode")) f.status = "deleted";
    else if (f && line.startsWith("rename from ")) (f.status = "renamed"), (f.from = line.slice(12));
    else if (f && line.startsWith("rename to ")) (f.status = "renamed"), (f.to = line.slice(10));
    else if (line.startsWith("Binary files ")) {
      if (!f) start();
      f.binary = true;
    } else if ((m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) {
      if (!f) start();
      hunk = { head: line, a: Number(m[1]), b: Number(m[3]), rows: [] };
      f.hunks.push(hunk);
      remA = m[2] === undefined ? 1 : Number(m[2]);
      remB = m[4] === undefined ? 1 : Number(m[4]);
    }
  }
  for (const x of files) x.path = x.to || x.from;
  return files.filter((x) => x.hunks.length || x.binary || x.status !== "modified");
}

const wordTokens = (s) => s.match(/\w+|\s+|[^\w\s]/g) || [];

/** The changed character ranges of a and b (LCS over words), or null when too long or too different to help. */
function wordRanges(a, b) {
  const x = wordTokens(a);
  const y = wordTokens(b);
  if (!x.length || !y.length || x.length * y.length > 40000) return null;
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra = [];
  const rb = [];
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  let same = 0;
  const add = (r, s, e) => (r.length && r[r.length - 1][1] === s ? (r[r.length - 1][1] = e) : r.push([s, e]));
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      same += x[i].length;
      pa += x[i++].length;
      pb += y[j++].length;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      add(rb, pb, (pb += y[j++].length));
    } else {
      add(ra, pa, (pa += x[i++].length));
    }
  }
  // Mostly rewritten lines read better whole than speckled with marks.
  if (same < 0.4 * Math.max(a.length, b.length)) return null;
  return [ra, rb];
}

/** Wrap character ranges of el's text in <mark>, across any highlight spans. */
function markRanges(el, ranges) {
  if (!ranges?.length) return;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n; (n = walk.nextNode()); ) nodes.push(n);
  let pos = 0;
  for (const node of nodes) {
    const start = pos;
    const end = (pos += node.data.length);
    const cuts = ranges.filter(([s, e]) => s < end && e > start).map(([s, e]) => [Math.max(s, start) - start, Math.min(e, end) - start]);
    if (!cuts.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [s, e] of cuts) {
      if (s > at) frag.append(node.data.slice(at, s));
      frag.append(h("mark", {}, node.data.slice(s, e)));
      at = e;
    }
    if (at < node.data.length) frag.append(node.data.slice(at));
    node.replaceWith(frag);
  }
}

function codeCell(row, hl, lang, ranges) {
  const td = h("td", { class: "code" });
  if (!row) return (td.classList.add("blank"), td);
  let html = null;
  if (hl && lang && row.t !== "note" && row.text.length <= 2000 && window.DOMPurify) {
    try {
      html = window.DOMPurify.sanitize(hl.highlight(row.text, { language: lang, ignoreIllegals: true }).value, HL_CLEAN);
    } catch {}
  }
  if (html != null) td.innerHTML = html;
  else td.textContent = row.text;
  markRanges(td, ranges);
  return td;
}

/** Each del paired with the add at the same place in its change block: Map row -> ranges. */
function pairWords(rows) {
  const marks = new Map();
  for (let i = 0; i < rows.length; ) {
    if (rows[i].t !== "del" && rows[i].t !== "add") {
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const r = wordRanges(dels[k].text, adds[k].text);
      if (r) (marks.set(dels[k], r[0]), marks.set(adds[k], r[1]));
    }
  }
  return marks;
}

function hunkRows(hunk, split, hl, lang) {
  const marks = pairWords(hunk.rows);
  const out = [h("tr", { class: "hunk" }, h("td", { colspan: split ? 4 : 3 }, hunk.head))];
  const ln = (n) => h("td", { class: "ln" }, n ?? "");
  if (!split) {
    for (const r of hunk.rows) out.push(h("tr", { class: r.t }, ln(r.a), ln(r.b), codeCell(r, hl, lang, marks.get(r))));
    return out;
  }
  const rows = hunk.rows;
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.t === "ctx" || r.t === "note") {
      out.push(h("tr", { class: r.t }, ln(r.a), codeCell(r, hl, lang), ln(r.b), codeCell(r, hl, lang)));
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push(h("tr", { class: "pair" }, ln(d?.a), codeCell(d, hl, lang, marks.get(d)), ln(a?.b), codeCell(a, hl, lang, marks.get(a))));
      const tr = out[out.length - 1];
      if (d) (tr.children[0].classList.add("del"), tr.children[1].classList.add("del"));
      if (a) (tr.children[2].classList.add("add"), tr.children[3].classList.add("add"));
    }
  }
  return out;
}

const BIG_FILE = 1500;
const diffViews = new Set();
const diffMode = () => (localStorage.getItem("canvas:diff-view") === "split" ? "split" : "unified");
const counts = (adds, dels) => [h("span", { class: "n-add" }, `+${adds}`), " ", h("span", { class: "n-del" }, `\u2212${dels}`)];
const STATUS = { added: "new", deleted: "deleted", renamed: "renamed" };

function fileBlock(f, split, hl, showHead) {
  const lang = langFor(f.path);
  const lines = f.hunks.reduce((n, x) => n + x.rows.length, 0);
  const body = h("div", { class: "dv-body" });
  const fill = () => {
    if (f.binary) return body.replaceChildren(h("div", { class: "empty" }, "Binary file changed."));
    if (!f.hunks.length) return body.replaceChildren(h("div", { class: "empty" }, f.status === "renamed" ? "Renamed without changes." : "No content changes."));
    body.replaceChildren(h("table", { class: `diff${split ? " split" : ""}` }, split ? h("colgroup", {}, h("col", { class: "c-ln" }), h("col"), h("col", { class: "c-ln" }), h("col")) : null, h("tbody", {}, f.hunks.flatMap((x) => hunkRows(x, split, hl, lang)))));
  };
  if (lines > BIG_FILE && !f.loaded) body.append(h("button", { class: "btn dv-load", type: "button", onclick: () => ((f.loaded = true), fill()) }, `Show this diff (${lines} lines)`));
  else fill();
  if (!showHead) return h("section", { class: "dv-file bare" }, body);
  const block = h("section", { class: `dv-file${f.shut ? " shut" : ""}` });
  const head = h(
    "header",
    { title: f.shut ? "Expand" : "Collapse" },
    h("button", { class: "chev", type: "button", "aria-label": "Toggle file" }),
    h("span", { class: "dv-path" }, f.status === "renamed" && f.from !== f.to ? `${f.from} \u2192 ${f.to}` : f.path),
    STATUS[f.status] ? h("span", { class: `dv-status ${f.status}` }, STATUS[f.status]) : null,
    h("span", { class: "dv-n" }, f.binary ? "binary" : counts(f.adds, f.dels)),
  );
  head.addEventListener("click", () => {
    f.shut = !f.shut;
    block.classList.toggle("shut", f.shut);
  });
  block.append(head, body);
  return block;
}

/** The whole patch: a summary bar, a file list when there are several, then one block per file. */
async function renderDiffView(text, { title = "Diff", href = "", inModal = false } = {}) {
  const files = parsePatch(text);
  if (!files.length) return h("div", { class: "empty" }, text.trim() ? "No file changes in this patch." : "No net change since the session first touched this file.");
  const hl = files.some((f) => langFor(f.path)) ? await loadHighlight() : null;
  const root = h("div", { class: `diffview${inModal ? " in-modal" : ""}` });
  const draw = () => {
    const split = diffMode() === "split";
    const adds = files.reduce((n, f) => n + f.adds, 0);
    const dels = files.reduce((n, f) => n + f.dels, 0);
    const mode = (m, label) => h("button", { class: `seg${(m === "split") === split ? " on" : ""}`, type: "button", onclick: () => setDiffMode(m) }, label);
    const blocks = files.map((f) => fileBlock(f, split, hl, !(inModal && files.length === 1)));
    const bar = h(
      "div",
      { class: "dv-bar" },
      h("span", { class: "dv-sum" }, `${files.length} file${files.length === 1 ? "" : "s"} changed `, counts(adds, dels)),
      h(
        "span",
        { class: "tools" },
        h("span", { class: "segs" }, mode("unified", "Unified"), mode("split", "Split")),
        inModal ? null : h("button", { class: "btn", type: "button", title: "Open large", onclick: () => showModal([text], 0, () => ({ kind: "diff", title, href, body: renderDiffView(text, { title, href, inModal: true }) })) }, "Expand \u2922"),
      ),
    );
    const list =
      files.length > 1
        ? h(
            "ol",
            { class: "dv-files" },
            files.map((f, i) =>
              h(
                "li",
                {},
                h(
                  "a",
                  {
                    href: "#",
                    onclick: (e) => {
                      e.preventDefault();
                      if (f.shut) blocks[i].querySelector("header").click();
                      blocks[i].scrollIntoView({ behavior: "smooth", block: "start" });
                    },
                  },
                  f.path,
                ),
                STATUS[f.status] ? h("span", { class: `dv-status ${f.status}` }, STATUS[f.status]) : null,
                h("span", { class: "dv-n" }, f.binary ? "binary" : counts(f.adds, f.dels)),
              ),
            ),
          )
        : null;
    root.replaceChildren(bar, list ?? "", ...blocks);
  };
  draw();
  root.redraw = draw;
  diffViews.add(root);
  return root;
}

function setDiffMode(m) {
  localStorage.setItem("canvas:diff-view", m);
  for (const v of diffViews) v.isConnected ? v.redraw() : diffViews.delete(v);
}

// ── modal: screenshots and diffs open over the page ──────────────────────────
// One <dialog> serves both. Esc and a backdrop click close it; ← and → step
// through the other items from the same card. A modifier-click still opens the
// link in a tab, as does the modal's own link.

let dlg;
let dlgKeys = null;

function modalEl() {
  if (dlg) return dlg;
  dlg = h("dialog", { class: "modal" });
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
  dlg.addEventListener("close", () => {
    dlg.replaceChildren();
    if (dlgKeys) document.removeEventListener("keydown", dlgKeys);
    dlgKeys = null;
  });
  document.body.append(dlg);
  return dlg;
}

/** Show items[i]; render(item) gives { kind, title, sub, href, extra, body }: extra sits in the header, body may be a promise. */
function showModal(items, i, render) {
  const d = modalEl();
  const show = (j) => {
    i = (j + items.length) % items.length;
    const { kind, title, sub, href, extra, body } = render(items[i]);
    d.className = `modal ${kind}`;
    const step = (n, label, tip) => h("button", { class: "btn", type: "button", title: tip, onclick: () => show(i + n) }, label);
    const box = h("div", { class: "mbody" }, h("div", { class: "empty" }, "Loading…"));
    const raw = h("a", { class: "btn open", href, target: "_blank", rel: "noopener", title: "Open in a new tab" }, "↗");
    d.replaceChildren(
      h(
        "header",
        {},
        h("span", { class: "title", title }, title),
        sub ? h("span", { class: "sub" }, sub) : null,
        h(
          "span",
          { class: "tools" },
          extra ?? null,
          items.length > 1 ? [step(-1, "←", "Previous (←)"), h("span", { class: "pos" }, `${i + 1} / ${items.length}`), step(1, "→", "Next (→)")] : null,
          clipButton(() => raw.href),
          raw,
          h("button", { class: "btn", type: "button", title: "Close (Esc)", onclick: () => d.close() }, "✕"),
        ),
      ),
      box,
    );
    Promise.resolve(body).then(
      (node) => box.replaceChildren(node),
      (e) => box.replaceChildren(h("div", { class: "err" }, String(e))),
    );
  };
  if (dlgKeys) document.removeEventListener("keydown", dlgKeys);
  dlgKeys = (e) => {
    if (items.length < 2 || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") (e.preventDefault(), show(i - 1));
    if (e.key === "ArrowRight") (e.preventDefault(), show(i + 1));
  };
  document.addEventListener("keydown", dlgKeys);
  if (!d.open) d.showModal();
  show(i);
}

const imageItem = (a) => ({
  kind: "image",
  title: a.closest("figure")?.querySelector("figcaption")?.textContent || a.querySelector("img")?.alt || "Image",
  href: a.href,
  body: h("img", { class: "lightbox", src: a.href, alt: "" }),
});

const fetchText = (url) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));

/**
 * A Files changed link as { diff, file } URLs ("" when absent). A row links
 * its copy (cur-<id>.txt) or, failing that, its patch (diff-<id>.patch);
 * "#diff" on a copy's link says the patch exists too.
 */
function fileLink(a) {
  const u = new URL(a.href, location.href);
  const m = u.pathname.match(/^(.*\/f\/)(diff|cur)-([0-9a-f]{12})\.(patch|txt)$/);
  if (!m) return null;
  return { diff: m[2] === "diff" || u.hash === "#diff" ? `${m[1]}diff-${m[3]}.patch` : "", file: m[2] === "cur" ? `${m[1]}cur-${m[3]}.txt` : "" };
}

/** A file as it is now: line numbers beside the text, coloured by extension. */
async function renderFileView(url, path) {
  const text = await fetchText(url);
  if (!text) return h("div", { class: "empty" }, "Empty file.");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const lang = langFor(path);
  const code = h("code");
  let html = null;
  if (lang && text.length <= 256 * 1024) {
    const hl = await loadHighlight();
    if (hl?.getLanguage(lang) && window.DOMPurify) {
      try {
        html = window.DOMPurify.sanitize(hl.highlight(text, { language: lang, ignoreIllegals: true }).value, HL_CLEAN);
      } catch {}
    }
  }
  if (html != null) code.innerHTML = html;
  else code.textContent = text;
  return h("div", { class: "fileview" }, h("pre", { class: "gutter", "aria-hidden": "true" }, lines.map((_, i) => i + 1).join("\n")), h("pre", { class: "src" }, code));
}

/** A markdown file rendered, its YAML frontmatter shown as a code block rather than stray text. */
async function renderMarkdownFile(url) {
  const text = await fetchText(url);
  if (!text.trim()) return h("div", { class: "empty" }, "Empty file.");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const el = renderMarkdown(fm ? `\`\`\`yaml\n${fm[1]}\n\`\`\`\n\n${text.slice(fm[0].length)}` : text);
  el.classList.add("doc");
  return el;
}

// The tab last picked in a Files changed modal, kept while stepping through
// rows: "diff", "file" (rendered, for markdown) or "source".
let fileTab = "diff";

function fileItem(a) {
  const urls = fileLink(a);
  const path = a.textContent.trim();
  const md = langFor(path) === "markdown";
  const names = { diff: "Diff", file: md ? "Preview" : "File", source: "Source" };
  const have = (t) => (t === "diff" ? !!urls.diff : t === "source" ? md && !!urls.file : !!urls.file);
  const order = ["diff", "file", "source"].filter(have);
  const tab = have(fileTab) ? fileTab : fileTab === "source" && have("file") ? "file" : order[0];
  const view = (t) =>
    t === "diff" ? fetchText(urls.diff).then((x) => renderDiffView(x, { title: path, href: urls.diff, inModal: true })) : t === "file" && md ? renderMarkdownFile(urls.file) : renderFileView(urls.file, path);
  const hrefFor = (t) => (t === "diff" ? urls.diff : urls.file);
  let shown = 0;
  const pick = (t, btn) => {
    fileTab = t;
    for (const b of btn.parentNode.children) b.classList.toggle("on", b === btn);
    dlg.querySelector("a.open").href = hrefFor(t);
    const box = dlg.querySelector(".mbody");
    const mine = ++shown;
    box.replaceChildren(h("div", { class: "empty" }, "Loading…"));
    view(t).then(
      (n) => mine === shown && box.replaceChildren(n),
      (e) => mine === shown && box.replaceChildren(h("div", { class: "err" }, String(e))),
    );
  };
  const tabs =
    order.length > 1
      ? h(
          "span",
          { class: "segs" },
          order.map((t) => h("button", { class: `seg${t === tab ? " on" : ""}`, type: "button", onclick: (e) => pick(t, e.currentTarget) }, names[t])),
        )
      : null;
  return {
    kind: "diff",
    title: path,
    sub: a.closest("tr")?.children[1]?.textContent.split(" · ")[1] || "",
    href: hrefFor(tab),
    extra: tabs,
    body: view(tab),
  };
}

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href]");
  // The modal's own links (↗, links in a preview) open normally.
  if (a?.closest("dialog")) return;
  const gallery = a?.closest(".gallery");
  if (gallery) {
    e.preventDefault();
    const links = [...gallery.querySelectorAll("a[href]")];
    return showModal(links, links.indexOf(a), imageItem);
  }
  if (a && fileLink(a)) {
    e.preventDefault();
    const links = [...(a.closest(".md") || document).querySelectorAll("a[href]")].filter(fileLink);
    return showModal(links, links.indexOf(a), fileItem);
  }
  const shot = e.target.closest?.("img.shot");
  if (shot) showModal([shot], 0, (img) => ({ kind: "image", title: img.alt || "Image", href: img.src, body: h("img", { class: "lightbox", src: img.src, alt: "" }) }));
});

// ── session view ─────────────────────────────────────────────────────────────

async function sessionView(id) {
  currentSession = id;
  const waitbar = h("div", { class: "waitbar" });
  const header = h("header", { class: "top" });
  const statusSlot = h("div");
  const sectionsSlot = h("div");
  const findingsSlot = h("div");
  const tocSlot = h("div");
  const widgetSlot = h("div");
  $app.classList.add("session");
  $app.replaceChildren(
    waitbar,
    header,
    h("div", { class: "layout" }, h("div", { class: "main-col" }, statusSlot, findingsSlot, sectionsSlot), h("aside", { class: "side" }, tocSlot, widgetSlot)),
  );
  loadChoices(id);
  const cards = new Map(); // section id → { at, el }
  const wide = matchMedia(WIDE);
  let lastSections = [];
  let lastStatusAt;
  let lastState;
  let lastFindings = -1;

  // ── placement: widgets go to the sidebar when the screen is wide ──
  function place() {
    const sections = lastSections;
    const aside = (s) => wide.matches && WIDGETS.includes(s.id);
    const lay = (slot, list) =>
      list.forEach((sec, i) => {
        // Move a card only when its place changed: moving a frame reloads it.
        const el = cards.get(sec.id).el;
        const here = slot.children[i];
        if (here !== el) slot.insertBefore(el, here || null);
      });
    const mainList = sections.filter((s) => !aside(s));
    sectionsSlot.querySelector(":scope > p.empty")?.remove();
    lay(sectionsSlot, mainList);
    lay(widgetSlot, WIDGETS.map((wid) => sections.find((s) => s.id === wid)).filter((s) => s && aside(s)));
    if (!mainList.length) sectionsSlot.append(h("p", { class: "empty" }, "No sections yet."));
    renderToc(mainList);
  }

  // ── Contents: every main-column section, a click opens and scrolls to it ──
  let tocList = [];
  const tocItems = h("ul", { class: "toc" });
  const tocCount = h("span", { class: "n" });
  const tocCard = collapsible(h("section", { class: "card" }, h("h2", {}, h("span", { class: "title" }, "Contents"), tocCount), tocItems), "_contents");
  const TOC_RECENT = 6;
  let tocAll = false;
  function renderToc(list = tocList) {
    tocList = list;
    if (!wide.matches || !list.length) return tocSlot.replaceChildren();
    tocCount.textContent = String(list.length);
    // The newest few, plus anything open or changed unseen; older collapsed
    // sections wait behind "Show N older".
    const state = (sec) => cards.get(sec.id)?.el?.classList;
    const keep = list.map((sec, i) => i < TOC_RECENT || !state(sec)?.contains("collapsed") || state(sec)?.contains("unseen"));
    const hidden = keep.filter((k) => !k).length;
    const fold = hidden > 2 && !tocAll;
    const toggle = hidden > 2 ? h("li", { class: "more" }, h("button", { class: "btn", type: "button", onclick: () => ((tocAll = !tocAll), renderToc()) }, tocAll ? "Show fewer" : `Show ${hidden} older`)) : null;
    tocItems.replaceChildren(
      ...list
        .filter((_, i) => !fold || keep[i])
        .map((sec) => {
          const card = cards.get(sec.id)?.el;
          const cls = ["", card?.classList.contains("collapsed") ? "shut" : "", card?.classList.contains("unseen") ? "unseen" : ""].join(" ").trim();
          const a = h("a", { class: cls, href: `#sec-${sec.id}`, title: sec.title || sec.id }, h("span", { class: "t" }, sec.title || sec.id), agoEl(sec.at));
          a.addEventListener("click", (e) => {
            e.preventDefault();
            if (!card) return;
            if (card.classList.contains("collapsed")) card.setCollapsed(false);
            card.scrollIntoView({ behavior: "smooth", block: "start" });
          });
          return h("li", {}, a);
        }),
      toggle ?? [],
    );
    if (tocSlot.firstChild !== tocCard) tocSlot.replaceChildren(tocCard);
  }
  onFold = () => renderToc();
  wide.addEventListener("change", place);

  async function refresh() {
    let state;
    try {
      state = await (await fetch(`/api/s/${encodeURIComponent(id)}`)).json();
    } catch {
      return;
    }
    const name = state.meta.name || id.slice(0, 8);
    document.title = `${name} · canvas`;
    header.replaceChildren(
      h("h1", {}, name),
      h("span", { class: "cwd" }, tilde(state.meta.cwd)),
      stateBadge(state),
      h(
        "span",
        { class: "tools" },
        h("button", { class: "btn", type: "button", onclick: () => setAll(true) }, "Collapse all"),
        h("button", { class: "btn", type: "button", onclick: () => setAll(false) }, "Expand all"),
        kbdButton(),
        h("a", { class: "back", href: "/" }, "All sessions"),
      ),
    );
    if (state.status?.at !== lastStatusAt || stateOf(state) !== lastState || !statusSlot.firstChild) {
      const changed = lastStatusAt !== undefined && state.status?.at !== lastStatusAt;
      lastStatusAt = state.status?.at;
      lastState = stateOf(state);
      const card = statusCard(state.status, lastState);
      if (changed) card.classList.add("fresh");
      if (changed && card.classList.contains("collapsed")) card.classList.add("unseen");
      statusSlot.replaceChildren(card);
    } else {
      // Keep the "12s ago" honest without a rebuild.
      const by = statusSlot.querySelector(".by");
      if (by && state.status) by.textContent = statusBy(state.status);
    }

    const sections = sortSections(state.sections);
    const keep = new Set(sections.map((s) => s.id));
    for (const [sid, c] of cards) if (!keep.has(sid)) (c.el.remove(), cards.delete(sid));
    for (const sec of sections) {
      let c = cards.get(sec.id);
      if (!c || c.at !== sec.at) {
        const el = sectionCard(id, sec);
        if (c) {
          el.classList.add("fresh");
          if (el.classList.contains("collapsed")) el.classList.add("unseen");
          c.el.replaceWith(el);
        }
        c = { at: sec.at, el };
        cards.set(sec.id, c);
      }
    }
    lastSections = sections;
    place();

    if (state.findings.length !== lastFindings) {
      const grew = lastFindings >= 0 && state.findings.length > lastFindings;
      lastFindings = state.findings.length;
      const card = findingsCard(state.findings);
      if (card && grew) {
        card.classList.add("fresh");
        if (card.classList.contains("collapsed")) card.classList.add("unseen");
      }
      findingsSlot.replaceChildren(card || "");
    }
  }

  function setAll(shut) {
    for (const card of $app.querySelectorAll(".card[data-key]")) card.setCollapsed?.(shut);
  }
  pageHooks.setAll = setAll;

  // One stream for every session: this page refreshes on its own changes, and
  // the banner on anyone's (a second stream per tab would eat into the
  // browser's six connections per host).
  let bannerTimer = 0;
  const banner = () => {
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => fetchSessions().then(() => renderWaitbar(waitbar)), 400);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    markSeen();
    banner();
  });

  await refresh();
  markSeen();
  banner();
  const es = new EventSource("/api/events");
  es.addEventListener("changed", (e) => {
    let d = {};
    try {
      d = JSON.parse(e.data);
    } catch {}
    if (d.id === id) refresh().then(markSeen);
    banner();
  });
  setInterval(refresh, 30_000);
}

// ── themes ───────────────────────────────────────────────────────────────────
// A pair of Omarchy themes, one for when macOS is dark and one for light, shared
// by every canvas page (one origin, one localStorage). The resolved variables
// are cached so theme-boot.js can apply them before the first paint.

const darkMq = matchMedia("(prefers-color-scheme: dark)");
const THEME_KEYS = Object.keys(themeVars({ background: "#000000", foreground: "#ffffff" }));
let themesReady = null;
let themePreview = null; // what the picker is hovering, until Enter or Esc

function loadThemes() {
  return (themesReady ??= fetch("/assets/themes.json")
    .then((r) => r.json())
    .then((j) => j.themes || {})
    .catch(() => ({})));
}
const systemMode = () => (darkMq.matches ? "dark" : "light");
function themeCache() {
  try {
    return JSON.parse(localStorage.getItem("canvas:theme-cache") || "null") || {};
  } catch {
    return {};
  }
}
const themePair = () => readPair(localStorage.getItem("canvas:theme"));
/** { name, mode, vars } in force now, or null for the canvas default. */
function activeTheme() {
  if (themePreview) return themePreview.vars ? themePreview : null;
  return themeCache()[systemMode()] || null;
}
const isDark = () => (activeTheme()?.mode ?? systemMode()) === "dark";

function postTheme(frame) {
  try {
    frame.contentWindow?.postMessage({ canvasTheme: activeTheme() }, "*");
  } catch {}
}

function applyTheme() {
  const t = activeTheme();
  const s = document.documentElement.style;
  for (const k of THEME_KEYS) s.removeProperty(k);
  if (t?.vars) for (const [k, v] of Object.entries(t.vars)) s.setProperty(k, v);
  s.colorScheme = t?.mode || "";
  for (const f of document.querySelectorAll("iframe")) postTheme(f);
  rethemeMermaid();
}

async function setTheme(name, mode) {
  const themes = await loadThemes();
  const pair = { ...themePair(), [mode]: name };
  const cache = themeCache();
  cache[mode] = name !== "canvas" && themes[name] ? { name, mode, vars: themeVars(themes[name]) } : null;
  try {
    localStorage.setItem("canvas:theme", JSON.stringify(pair));
    localStorage.setItem("canvas:theme-cache", JSON.stringify(cache));
  } catch {}
  applyTheme();
}

/** Rebuild the cache from themes.json, in case the palettes or the mapping changed. */
async function refreshThemeCache() {
  const pair = themePair();
  if (pair.dark === "canvas" && pair.light === "canvas") return;
  const themes = await loadThemes();
  const cache = {};
  for (const mode of ["dark", "light"]) if (themes[pair[mode]]) cache[mode] = { name: pair[mode], mode, vars: themeVars(themes[pair[mode]]) };
  if (JSON.stringify(cache) === JSON.stringify(themeCache())) return;
  try {
    localStorage.setItem("canvas:theme-cache", JSON.stringify(cache));
  } catch {}
  applyTheme();
}

function mermaidConfig() {
  const base = { startOnLoad: false, securityLevel: "strict" };
  const v = activeTheme()?.vars;
  if (!v) return { ...base, theme: isDark() ? "dark" : "neutral" };
  return {
    ...base,
    theme: "base",
    themeVariables: {
      darkMode: isDark(),
      background: v["--card"],
      mainBkg: v["--soft"],
      primaryColor: v["--soft"],
      primaryTextColor: v["--ink"],
      primaryBorderColor: v["--dim"],
      secondaryColor: v["--tint"],
      tertiaryColor: v["--code"],
      nodeBorder: v["--dim"],
      lineColor: v["--dim"],
      textColor: v["--ink"],
      titleColor: v["--ink"],
      clusterBkg: v["--code"],
      clusterBorder: v["--line"],
      edgeLabelBackground: v["--card"],
    },
  };
}

let mermaidRetheme = 0;
function rethemeMermaid() {
  // Debounced: arrowing through themes in the picker shouldn't redraw each step.
  clearTimeout(mermaidRetheme);
  mermaidRetheme = setTimeout(() => {
    if (!window.mermaid) return;
    window.mermaid.initialize(mermaidConfig());
    for (const el of document.querySelectorAll(".mmd")) if (el._src) renderMermaid(el, el._src);
  }, 120);
}

darkMq.addEventListener("change", applyTheme);
addEventListener("storage", (e) => e.key === "canvas:theme-cache" && applyTheme());
// Frames get the theme once their script is listening (load doesn't bubble).
document.addEventListener("load", (e) => e.target?.tagName === "IFRAME" && postTheme(e.target), true);
applyTheme();
refreshThemeCache();

// ── other sessions waiting on you ────────────────────────────────────────────
// A session waits on you when it is blocked, done or failed. It gets a chip
// until you have its page in view after that change. "Seen" times live in
// localStorage (canvas:seen), so every canvas tab agrees.

const SEEN_KEY = "canvas:seen";
let sessionsCache = [];
let currentSession = null;
const pageHooks = {}; // set by sessionView: setAll(shut)

function readSeen() {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
  } catch {
    return null;
  }
}
function writeSeen(m) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(m));
  } catch {}
}
function markSeen() {
  if (!currentSession || document.visibilityState !== "visible") return;
  writeSeen({ ...(readSeen() || {}), [currentSession]: Date.now() });
}

async function fetchSessions() {
  try {
    sessionsCache = await (await fetch("/api/sessions")).json();
  } catch {
    return sessionsCache;
  }
  const seen = nextSeen(readSeen(), sessionsCache);
  if (currentSession && document.visibilityState === "visible") seen[currentSession] = Date.now();
  writeSeen(seen);
  return sessionsCache;
}

const sessionName = (s) => s.name || String(s.cwd || "").split("/").filter(Boolean).pop() || s.id.slice(0, 8);
const waitingNow = () => waitingSessions(sessionsCache, readSeen() || {}, currentSession);

function renderWaitbar(bar) {
  const list = waitingNow();
  if (!list.length) return bar.replaceChildren();
  bar.replaceChildren(
    h("span", { class: "lbl" }, "Waiting on you"),
    ...list.map((s) =>
      h(
        "a",
        { class: `waitchip ${s.activity}`, href: `/s/${encodeURIComponent(s.id)}`, title: [tilde(s.cwd), s.activityMessage, s.now || s.goal].filter(Boolean).join("\n") },
        h("span", { class: `pulse ${s.activity}` }),
        h("span", { class: "nm" }, sessionName(s)),
        h("span", { class: "st" }, STATE_LABEL[s.activity] || s.activity, " · ", s.activityAt ? agoEl(s.activityAt) : ""),
      ),
    ),
  );
}

// ── toast ───────────────────────────────────────────────────────────────────

let toastTimer = 0;
function toast(text) {
  let el = document.querySelector(".toast");
  if (!el) document.body.append((el = h("div", { class: "toast", role: "status" })));
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ── Cmd-K picker ─────────────────────────────────────────────────────────────
// Other sessions (waiting on you first, then live, then recent) and a few
// actions, matched on titles. "Change theme…" opens a second list that
// previews each theme as you move through it.

let picker = null;

function go(href, newTab) {
  if (newTab) window.open(href, "_blank", "noopener");
  else location.href = href;
}

function mainItems() {
  const waiting = waitingNow();
  const wait = new Set(waiting.map((s) => s.id));
  const sessions = orderSessions(sessionsCache, waiting, currentSession).map((s) => ({
    group: wait.has(s.id) ? "Waiting on you" : s.live ? "Sessions" : "Recent",
    label: sessionName(s),
    sub: [tilde(s.cwd), s.goal].filter(Boolean).join(" · "),
    end: () => [stateBadge(s), agoEl(s.activityAt || s.ended || new Date(s.updated).toISOString())],
    run: (e) => go(`/s/${encodeURIComponent(s.id)}`, e?.metaKey || e?.ctrlKey),
  }));
  const pair = themePair();
  const actions = [
    currentSession && { label: "Fold all sections", run: () => pageHooks.setAll?.(true) },
    currentSession && { label: "Open all sections", run: () => pageHooks.setAll?.(false) },
    {
      label: "Copy link to this page",
      run: () => navigator.clipboard.writeText(location.href).then(() => toast("Link copied"), () => toast("Couldn't copy the link")),
    },
    currentSession && { label: "All sessions", sub: "the sessions index", run: (e) => go("/", e?.metaKey || e?.ctrlKey) },
    { label: "Change theme…", sub: `dark: ${pair.dark === "canvas" ? "Canvas" : prettyName(pair.dark)} · light: ${pair.light === "canvas" ? "Canvas" : prettyName(pair.light)}`, stay: true, run: () => setPickerMode("theme") },
    { label: "Keyboard shortcuts", sub: "or press ? on the page", run: () => toggleHelp() },
  ]
    .filter(Boolean)
    .map((a) => ({ group: "Actions", ...a }));
  return [...sessions, ...actions];
}

function themeItems(themes) {
  const pair = themePair();
  const out = [];
  for (const mode of ["dark", "light"]) {
    const names = Object.keys(themes).filter((n) => themeMode(themes[n]) === mode).sort();
    for (const name of ["canvas", ...names]) {
      const c = themes[name];
      const label = name === "canvas" ? "Canvas" : prettyName(name);
      out.push({
        group: mode === "dark" ? "For dark mode" : "For light mode",
        label,
        sub: name === "canvas" ? "the default look" : "",
        end: () => [pair[mode] === name ? h("span", { class: "in-use" }, "in use") : null, c ? h("span", { class: "sw" }, swatch(c).map((v) => h("i", { style: `background:${v}` }))) : null],
        // The default palette for the other mode lives in a media query, so it can't be previewed.
        preview: name === "canvas" ? (mode === systemMode() ? { vars: null } : null) : { name, mode, vars: themeVars(c) },
        run: () => {
          setTheme(name, mode);
          if (mode !== systemMode()) toast(`${label} will be used when macOS is in ${mode} mode`);
        },
      });
    }
  }
  return out;
}

function setPickerMode(mode) {
  if (!picker) return;
  picker.mode = mode;
  picker.input.value = "";
  picker.crumb.hidden = mode !== "theme";
  picker.input.placeholder = mode === "theme" ? "Pick a theme…" : "Jump to a session or run an action…";
  if (mode === "theme") {
    picker.items = [];
    loadThemes().then((themes) => {
      if (picker?.mode !== "theme") return;
      picker.items = themeItems(themes);
      // Start on the theme in force now.
      const now = themePair()[systemMode()];
      const label = now === "canvas" ? "Canvas" : prettyName(now);
      picker.sel = Math.max(0, picker.items.findIndex((it) => it.label === label && it.group.includes(systemMode())));
      drawPicker(false);
    });
  } else {
    themePreview = null;
    applyTheme();
    picker.items = mainItems();
  }
  picker.sel = 0;
  drawPicker();
}

function drawPicker(resetSel = true) {
  const p = picker;
  const q = p.input.value;
  p.shown = rankItems(p.items, q);
  if (resetSel && p.lastQ !== q) p.sel = 0;
  p.lastQ = q;
  p.sel = Math.min(Math.max(p.sel, 0), Math.max(p.shown.length - 1, 0));
  const rows = [];
  let group = null;
  p.shown.forEach((it, i) => {
    // Group headings only for the unfiltered list; a search is ordered by match.
    if (!q && it.group !== group) rows.push(h("li", { class: "grp" }, (group = it.group)));
    const li = h("li", { class: `it${i === p.sel ? " on" : ""}`, role: "option", "aria-selected": String(i === p.sel) }, h("span", { class: "lb" }, it.label), h("span", { class: "sub" }, q && p.mode === "main" ? [it.group, it.sub].filter(Boolean).join(" · ") : it.sub || ""), h("span", { class: "end" }, it.end?.() ?? []));
    li.addEventListener("mousemove", () => p.sel !== i && ((p.sel = i), drawPicker(false)));
    li.addEventListener("click", (e) => runPick(it, e));
    rows.push(li);
  });
  p.list.replaceChildren(...(rows.length ? rows : [h("li", { class: "none" }, p.mode === "theme" && !p.items.length ? "Loading themes…" : "No matches")]));
  p.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  if (p.mode === "theme") {
    const it = p.shown[p.sel];
    themePreview = it?.preview ?? null;
    applyTheme();
  }
}

function runPick(it, e) {
  if (!it) return;
  if (!it.stay) closePicker(true);
  it.run(e);
}

function openPicker() {
  if (picker) return;
  const input = h("input", { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": "Search" });
  const crumb = h("span", { class: "crumb" }, "Theme");
  const list = h("ul", { role: "listbox" });
  const foot = h("div", { class: "foot" }, h("span", {}, h("kbd", {}, "↑↓"), " move"), h("span", {}, h("kbd", {}, "↵"), " open"), h("span", {}, h("kbd", {}, "⌘↵"), " new tab"), h("span", {}, h("kbd", {}, "esc"), " back / close"));
  const box = h("div", { class: "cmdk", role: "dialog", "aria-label": "Go to" }, h("div", { class: "q" }, crumb, input), list, foot);
  const back = h("div", { class: "cmdk-back" }, box);
  back.addEventListener("mousedown", (e) => e.target === back && closePicker());
  picker = { back, input, crumb, list, mode: "main", items: [], shown: [], sel: 0, lastQ: "", focus: document.activeElement };
  input.addEventListener("input", () => drawPicker());
  input.addEventListener("keydown", (e) => {
    const p = picker;
    const move = (d) => {
      e.preventDefault();
      if (p.shown.length) p.sel = (p.sel + d + p.shown.length) % p.shown.length;
      drawPicker(false);
    };
    if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) return move(1);
    if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) return move(-1);
    if (e.key === "Enter") return (e.preventDefault(), runPick(p.shown[p.sel], e));
    if (e.key === "Escape") return (e.preventDefault(), p.mode === "theme" ? setPickerMode("main") : closePicker());
    if (e.key === "Backspace" && !input.value && p.mode === "theme") return (e.preventDefault(), setPickerMode("main"));
  });
  document.body.append(back);
  setPickerMode("main");
  input.focus();
  // The cache may be a minute old; refresh and redraw if the picker is still on the main list.
  fetchSessions().then(() => picker?.mode === "main" && ((picker.items = mainItems()), drawPicker(false)));
}

function closePicker(keepTheme = false) {
  if (!picker) return;
  const { back, focus } = picker;
  picker = null;
  back.remove();
  if (!keepTheme && themePreview) {
    themePreview = null;
    applyTheme();
  }
  themePreview = null;
  focus?.focus?.();
}

// ── vim keys ─────────────────────────────────────────────────────────────────
// j / k move a highlighted "current" section, and o, za, zc, zo, yc and yf act
// on it. Once it scrolls out of view, the section at the top of the window
// stands in. The keys themselves are the VIM_KEYS table in nav.mjs.

let currentCard = null;
let keySeq = "";
let keySeqTimer = 0;
let helpBox = null;

const mainCards = () => [...$app.querySelectorAll(".main-col .card, .card.sessions")].filter((c) => c.offsetParent && !c.parentElement.closest(".card"));
function inView(c) {
  const r = c.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
}
const liveCurrent = (cards) => (currentCard && cards.includes(currentCard) && inView(currentCard) ? currentCard : null);

function setCurrent(card, scroll = true, instant = false) {
  if (currentCard && currentCard !== card) currentCard.classList.remove("current");
  currentCard = card || null;
  if (!card) return;
  card.classList.add("current");
  if (scroll) window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - 12, behavior: instant ? "auto" : "smooth" });
}

/** The highlighted section if it's on screen, else the one at the top of the window. */
function currentOrTop(cards = mainCards()) {
  const live = liveCurrent(cards);
  if (live) return live;
  const i = cards.map((c) => c.getBoundingClientRect().top).findLastIndex((t) => t <= 14);
  return cards[Math.max(i, 0)] ?? null;
}

function hopSection(dir, instant) {
  const cards = mainCards();
  if (!cards.length) return;
  const live = liveCurrent(cards);
  const tops = cards.map((c) => c.getBoundingClientRect().top);
  const i = live ? cards.indexOf(live) + dir : dir > 0 ? tops.findIndex((t) => t > 14) : tops.findLastIndex((t) => t < 10);
  if (i >= 0 && i < cards.length) setCurrent(cards[i], true, instant);
}

/** n / N: the next section with the changed-while-folded dot, wrapping like vim. */
function hopChanged(dir) {
  const cards = mainCards();
  const from = cards.indexOf(currentOrTop(cards));
  const order = dir > 0 ? [...cards.slice(from + 1), ...cards.slice(0, from + 1)] : [...cards.slice(0, Math.max(from, 0)).reverse(), ...cards.slice(Math.max(from, 0)).reverse()];
  const card = order.find((c) => c.classList.contains("unseen"));
  if (!card) return toast("No sections changed while folded");
  card.setCollapsed?.(false);
  setCurrent(card);
}

const cardTitle = (card) => card?.querySelector(":scope > h2 .title")?.textContent || "this section";

/** Press a header button of the current section (Copy source, Clippy) and echo its result. */
async function yankWith(card, selector, what) {
  const b = card?.querySelector(`:scope > h2 ${selector}`);
  if (!b) return toast(`“${cardTitle(card)}” has no ${what} to copy`);
  setCurrent(card, false);
  b.click();
  const ok = await new Promise((resolve) => {
    const mo = new MutationObserver(() => /\b(ok|bad)\b/.test(b.className) && (clearTimeout(t), mo.disconnect(), resolve(b.className.includes("ok"))));
    const t = setTimeout(() => (mo.disconnect(), resolve(null)), 5000);
    mo.observe(b, { attributes: true, attributeFilter: ["class"] });
  });
  if (ok === true) toast(what === "file" ? b.title || "File copied" : `Copied the source of “${cardTitle(card)}”`);
  else if (ok === false) toast(`Couldn't copy the ${what}${b.title && what === "file" ? `: ${b.title}` : ""}`);
}

function vimAction(action, e) {
  const smooth = e?.repeat ? "auto" : "smooth";
  switch (action) {
    case "next":
      return hopSection(1, e?.repeat);
    case "prev":
      return hopSection(-1, e?.repeat);
    case "top":
      setCurrent(null);
      return window.scrollTo({ top: 0, behavior: "smooth" });
    case "bottom":
      setCurrent(null);
      return window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
    case "halfDown":
      return window.scrollBy({ top: innerHeight / 2, behavior: smooth });
    case "halfUp":
      return window.scrollBy({ top: -innerHeight / 2, behavior: smooth });
    case "nextChanged":
      return hopChanged(1);
    case "prevChanged":
      return hopChanged(-1);
    case "toggle":
    case "open":
    case "close": {
      const c = currentOrTop();
      if (!c?.setCollapsed) return;
      c.setCollapsed(action === "toggle" ? !c.classList.contains("collapsed") : action === "close");
      // Folding a tall section whose top is off screen: bring its header back.
      return setCurrent(c, c.getBoundingClientRect().top < 0);
    }
    case "openAll":
      return pageHooks.setAll?.(false);
    case "foldAll":
      return pageHooks.setAll?.(true);
    case "yankLink":
      return copyText(location.href).then(
        () => toast("Copied the page link"),
        () => toast("Couldn't copy the link"),
      );
    case "yankSource":
      return yankWith(currentOrTop(), "[data-yank=source]", "source");
    case "yankFile":
      return yankWith(currentOrTop(), ".clip", "file");
    case "help":
      return toggleHelp();
  }
}

function showKeyHint(text) {
  let el = document.querySelector(".keyhint");
  if (!text) return el?.remove();
  if (!el) document.body.append((el = h("div", { class: "keyhint", "aria-live": "polite" })));
  el.textContent = text;
}
function clearSeq() {
  keySeq = "";
  clearTimeout(keySeqTimer);
  showKeyHint("");
}

function closeHelp() {
  helpBox?.remove();
  helpBox = null;
}
function toggleHelp() {
  if (helpBox) return closeHelp();
  const row = (keys, text) => h("tr", {}, h("td", {}, keys.flatMap((k, i) => [i ? " " : "", h("kbd", {}, k)])), h("td", {}, text));
  const groups = [...new Set(VIM_KEYS.map((k) => k.group))].map((g) =>
    h("div", {}, h("h3", {}, g), h("table", {}, VIM_KEYS.filter((k) => k.group === g && k.help).map((k) => row([k.keys], k.help)))),
  );
  groups.push(
    h(
      "div",
      {},
      h("h3", {}, "Picker"),
      h("table", {}, row(["⌘K", "Ctrl-K"], "sessions, actions and themes"), row(["↑↓", "Ctrl-n/p", "Ctrl-j/k"], "move"), row(["↵", "⌘↵"], "open here, or in a new tab"), row(["esc"], "back, close, or clear the highlight")),
    ),
  );
  const box = h("div", { class: "cmdk keys", role: "dialog", "aria-label": "Keyboard shortcuts" }, h("div", { class: "keys-hd" }, "Keyboard shortcuts"), h("div", { class: "keys-grid" }, groups));
  helpBox = h("div", { class: "cmdk-back" }, box);
  helpBox.addEventListener("mousedown", (e) => e.target === helpBox && closeHelp());
  document.body.append(helpBox);
}

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return; // the picker's own keys (Ctrl-k moves up there)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    closeHelp();
    return picker ? closePicker() : openPicker();
  }
  if (picker) return;
  const t = e.target;
  if (t?.isContentEditable || t?.closest?.("input, textarea, select") || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") {
    if (helpBox) return closeHelp();
    if (keySeq) return clearSeq();
    return setCurrent(null);
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "d" || e.key === "u")) {
    e.preventDefault();
    return vimAction(e.key === "d" ? "halfDown" : "halfUp", e);
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  if (helpBox && e.key !== "?") return;
  let seq = keySeq + e.key;
  let m = matchKeys(seq);
  // A dangling prefix (g then j) shouldn't swallow the key after it.
  if (!m.action && !m.pending && keySeq) m = matchKeys((seq = e.key));
  clearSeq();
  if (m.pending) {
    e.preventDefault();
    keySeq = seq;
    showKeyHint(seq);
    keySeqTimer = setTimeout(clearSeq, 1500);
    return;
  }
  if (!m.action) return;
  e.preventDefault();
  vimAction(m.action, e);
});

const kbdButton = () => h("button", { class: "btn", type: "button", title: "Sessions, actions and themes (⌘K). Press ? for every key.", onclick: () => openPicker() }, "⌘K");

// ── index view ───────────────────────────────────────────────────────────────

async function indexView() {
  document.title = "Canvas";
  const groups = h("div");
  const header = h("header", { class: "top" }, h("h1", {}, "Canvas"), h("span", { class: "cwd" }, ""), h("span", { class: "tools" }, kbdButton()));
  $app.replaceChildren(header, groups);

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function row(s) {
    const st = stateOf(s);
    const endedAt = s.ended || (s.live ? undefined : new Date(s.updated).toISOString());
    const updatedIso = new Date(s.updated).toISOString();
    const chips = [
      s.open ? h("span", { class: "chip open", title: "Open questions in the status" }, `${s.open} open`) : null,
      s.next ? h("span", { class: "chip next" }, `${s.next} next`) : null,
      s.done ? h("span", { class: "chip" }, `${s.done} done`) : null,
      s.sections ? h("span", { class: "chip" }, plural(s.sections, "section")) : null,
      s.findings ? h("span", { class: "chip" }, plural(s.findings, "finding")) : null,
    ].filter(Boolean);
    // Live rows say how long ago; ended rows sit under a day heading, so the
    // clock time is enough.
    const when = st === "ended" ? h("time", { datetime: endedAt, title: fullDate(endedAt) }, clock(new Date(endedAt))) : agoEl(updatedIso);
    return h(
      "a",
      { class: `row ${st}`, href: `/s/${encodeURIComponent(s.id)}` },
      h(
        "div",
        { class: "main" },
        h("div", { class: "line1" }, h("span", { class: "name" }, s.name || s.id.slice(0, 8)), h("span", { class: "cwd" }, tilde(s.cwd))),
        h("div", { class: `goal${s.goal ? "" : " none"}` }, s.goal || "No status yet"),
        s.now && st !== "ended" ? h("div", { class: "nowline" }, h("span", { class: "eyebrow" }, "Now"), h("span", {}, s.now)) : null,
        s.now && st === "ended" ? h("div", { class: "nowline" }, h("span", { class: "eyebrow" }, "Last"), h("span", {}, s.now)) : null,
        chips.length ? h("div", { class: "chips" }, chips) : null,
      ),
      h("div", { class: "side" }, st === "ended" ? "" : stateBadge(s), when),
    );
  }

  function group(title, sessions, extra) {
    return h(
      "section",
      { class: "card sessions" },
      h("h2", {}, h("span", { class: "title" }, title), h("span", { class: "n" }, String(sessions.length)), extra ? h("span", { class: "meta" }, extra) : null),
      h("div", { class: "bd flush" }, sessions.map(row)),
    );
  }

  async function refresh() {
    let sessions;
    try {
      sessions = await (await fetch("/api/sessions")).json();
      sessionsCache = sessions;
    } catch {
      return;
    }
    const active = sessions.filter((s) => s.live);
    const waiting = active.filter((s) => NEEDS_YOU.has(stateOf(s))).length;
    header.querySelector(".cwd").textContent = [plural(sessions.length, "session"), waiting ? `${waiting} waiting on you` : ""].filter(Boolean).join(" · ");
    if (!sessions.length) return groups.replaceChildren(h("section", { class: "card" }, h("div", { class: "bd empty" }, "No sessions yet. A session gets a page on its first status or section.")));
    // The ones that need you first, most urgent first.
    const rank = { blocked: 0, error: 1, done: 2, working: 3, idle: 4 };
    active.sort((a, b) => (rank[stateOf(a)] ?? 5) - (rank[stateOf(b)] ?? 5) || b.updated - a.updated);
    const out = [];
    if (active.length) out.push(group("Active", active));
    const byDay = new Map();
    for (const s of sessions.filter((x) => !x.live).sort((a, b) => Date.parse(b.ended || 0) - Date.parse(a.ended || 0) || b.updated - a.updated)) {
      const d = new Date(s.ended || s.updated);
      const key = dayLabel(d);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(s);
    }
    for (const [day, list] of byDay) out.push(group(day, list));
    groups.replaceChildren(...out);
  }

  await refresh();
  const es = new EventSource("/api/events");
  es.addEventListener("changed", refresh);
}

const m = location.pathname.match(/^\/s\/([^/]+)\/?$/);
if (m) sessionView(decodeURIComponent(m[1]));
else indexView();
