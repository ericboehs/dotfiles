// Session canvas page. Served by daemon.mjs at / (index) and /s/<id>.
// Re-fetches state on each server-sent "changed" event and re-renders only the
// sections whose timestamp moved, so iframes and scroll position survive.

const CSS = `
:root { color-scheme: light dark; --bg:#f7f5f0; --card:#fff; --ink:#1c1b19; --dim:#8a8578; --line:#e6e1d6; --soft:#f0ece3; --accent:#b4541f; --ok:#1f7a52; --warn:#a86a00; --bad:#c0392b; --code:#f3f0e8; --tint:#fbf3ec; --hl-kw:#285880; --hl-str:#42632a; --hl-num:#805424; --hl-com:#5b6a7f; --hl-title:#68448b; }
@media (prefers-color-scheme: dark) { :root { --bg:#1f1e1c; --card:#282725; --ink:#ecebe7; --dim:#9a958a; --line:#3a3834; --soft:#312f2c; --accent:#e08a5a; --ok:#5cc495; --warn:#e2b257; --bad:#ef6f5e; --code:#211f1d; --tint:#33291f; --hl-kw:#8fc4e2; --hl-str:#bed59d; --hl-num:#e5c29b; --hl-com:#a5b4c6; --hl-title:#d6b9ed; } }
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
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
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
  const fit = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      // scrollHeight never drops below the frame's own height, so measure the
      // bottom of the content instead; then the frame can shrink as well as grow.
      const body = doc.body;
      if (!body) return;
      let bottom = 0;
      for (const kid of body.children) bottom = Math.max(bottom, kid.getBoundingClientRect().bottom);
      bottom += parseFloat(doc.defaultView.getComputedStyle(body).marginBottom) || 0;
      frame.style.height = `${Math.min(Math.max(Math.ceil(bottom), 40), 4000)}px`;
    } catch {}
  };
  frame.addEventListener("load", () => {
    fit();
    try {
      new ResizeObserver(fit).observe(frame.contentDocument.body);
    } catch {}
  });
}

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
      const f = h("iframe", { src: url, sandbox: "allow-scripts allow-same-origin allow-popups allow-modals allow-downloads", allow: "clipboard-write", loading: "lazy" });
      fitFrame(f);
      return f;
    }
    case "html-plan":
      return h("iframe", { class: "plan", src: url, sandbox: "allow-scripts allow-same-origin allow-popups allow-modals allow-downloads", allow: "clipboard-write" });
    case "image":
      return h("img", { class: "shot", src: url, alt: sec.title });
    case "diff":
      return renderDiffView(await (await fetch(url)).text(), { title: sec.title || sec.id, href: rawUrl(id, sec, false) });
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
  if (sec.kind === "markdown" || sec.kind === "mermaid" || sec.kind === "diff") meta.append(copyButton(async () => (await fetch(rawUrl(id, sec))).text(), "Copy source"));
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
          h("a", { class: "btn open", href, target: "_blank", rel: "noopener" }, "Open in new tab ↗"),
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
  const header = h("header", { class: "top" });
  const statusSlot = h("div");
  const sectionsSlot = h("div");
  const findingsSlot = h("div");
  const tocSlot = h("div");
  const widgetSlot = h("div");
  $app.classList.add("session");
  $app.replaceChildren(
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

  await refresh();
  const es = new EventSource(`/api/s/${encodeURIComponent(id)}/events`);
  es.addEventListener("changed", refresh);
  setInterval(refresh, 30_000);
}

// ── index view ───────────────────────────────────────────────────────────────

async function indexView() {
  document.title = "Canvas";
  const groups = h("div");
  const header = h("header", { class: "top" }, h("h1", {}, "Canvas"), h("span", { class: "cwd" }, ""));
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
