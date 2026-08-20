import type { FlowAudit } from "./model.js";

function serializedAudit(audit: FlowAudit): string {
  return JSON.stringify(audit).replaceAll("<", "\\u003c");
}

export function renderFlowAuditHtml(audit: FlowAudit): string {
  const data = serializedAudit(audit);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ARIS 程序执行流程审计图</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06101d;
      --panel: #0d1b2c;
      --panel-2: #13263d;
      --line: #31506f;
      --muted: #97abc1;
      --text: #eff7ff;
      --blue: #68aefc;
      --cyan: #58d7c5;
      --amber: #f4c66a;
      --red: #fb7185;
      --violet: #b8a1ff;
      --green: #80dfa8;
      --shadow: 0 18px 52px rgba(0, 0, 0, .25);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; color: var(--text); background: radial-gradient(circle at 28% -10%, #193958 0, var(--bg) 42%); }
    button, input { font: inherit; }
    button { color: inherit; }
    code { color: #cce5ff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .topbar { position: sticky; z-index: 30; top: 0; padding: 17px 24px 13px; border-bottom: 1px solid rgba(104, 174, 252, .18); background: rgba(6, 16, 29, .92); backdrop-filter: blur(16px); }
    .title-row { display: flex; gap: 20px; align-items: flex-end; justify-content: space-between; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 33px); letter-spacing: -.04em; }
    .subtitle { max-width: 900px; margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .search { width: min(360px, 38vw); border: 1px solid var(--line); border-radius: 12px; padding: 10px 13px; color: var(--text); background: rgba(13, 27, 44, .92); outline: none; }
    .search:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(104, 174, 252, .12); }
    .stats, .tabs, .legend, .node-badges, .card-footer, .call-actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .stats { margin-top: 12px; }
    .stat, .badge { border: 1px solid var(--line); border-radius: 999px; background: rgba(19, 38, 61, .75); color: var(--muted); }
    .stat { padding: 5px 9px; font-size: 12px; }
    .stat strong { color: var(--text); font-variant-numeric: tabular-nums; }
    .badge { display: inline-flex; align-items: center; padding: 3px 7px; font-size: 10px; font-weight: 700; }
    .badge.entry, .badge.coordination { border-color: rgba(104, 174, 252, .45); color: #b9d9ff; }
    .badge.judgment { border-color: rgba(244, 198, 106, .55); color: #f8d992; }
    .badge.execution { border-color: rgba(128, 223, 168, .48); color: #a8efc5; }
    .badge.mixed, .badge.tool { border-color: rgba(184, 161, 255, .5); color: #d2c4ff; }
    .badge.retry, .badge.pause { border-color: rgba(251, 113, 133, .45); color: #fda4b2; }
    .badge.inferred { border-style: dashed; border-color: rgba(244, 198, 106, .65); color: #f8d992; }
    .tabs { margin-top: 12px; }
    .tab { border: 1px solid transparent; border-radius: 10px; padding: 8px 12px; background: transparent; color: var(--muted); cursor: pointer; }
    .tab:hover, .tab.active { border-color: var(--line); background: var(--panel-2); color: var(--text); }
    .layout { display: grid; grid-template-columns: 272px minmax(0, 1fr); min-height: calc(100vh - 152px); }
    .sidebar { position: sticky; top: 152px; align-self: start; height: calc(100vh - 152px); overflow: auto; padding: 17px 13px 60px; border-right: 1px solid rgba(104, 174, 252, .14); background: rgba(6, 16, 29, .48); }
    .sidebar-group { margin-bottom: 20px; }
    .sidebar-title { display: flex; justify-content: space-between; margin: 0 8px 7px; color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
    .node-link { display: block; width: 100%; margin: 3px 0; padding: 8px 10px; overflow: hidden; border: 1px solid transparent; border-radius: 9px; background: transparent; color: #cad9e9; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .node-link:hover, .node-link.active { border-color: var(--line); background: var(--panel-2); color: white; }
    .node-link small { color: var(--muted); }
    main { min-width: 0; padding: 27px clamp(18px, 3vw, 50px) 80px; }
    .section-head { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; margin-bottom: 19px; }
    .section-head h2 { margin: 0; font-size: 25px; letter-spacing: -.025em; }
    .section-head p { max-width: 900px; margin: 7px 0 0; color: var(--muted); line-height: 1.55; }
    .legend { align-items: center; margin: 13px 0 19px; color: var(--muted); font-size: 11px; }
    .legend-shape { display: inline-block; width: 18px; height: 13px; border: 1px solid var(--line); background: var(--panel-2); vertical-align: middle; }
    .legend-shape.start { border-radius: 999px; }
    .legend-shape.decision { width: 13px; transform: rotate(45deg); border-color: var(--amber); }
    .legend-shape.subprocess { border-right: 3px double var(--violet); border-left: 3px double var(--violet); }
    .ghost-button, .source-button, .small-button { border: 1px solid var(--line); border-radius: 9px; background: rgba(19, 38, 61, .78); cursor: pointer; }
    .ghost-button { padding: 9px 12px; white-space: nowrap; }
    .source-button, .small-button { padding: 5px 8px; color: #bed8f5; font-size: 11px; }
    .ghost-button:hover, .source-button:hover, .small-button:hover { border-color: var(--blue); color: white; }
    .entry-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 15px; }
    .entry-card { padding: 17px; border: 1px solid var(--line); border-radius: 16px; background: linear-gradient(145deg, rgba(19, 38, 61, .97), rgba(9, 22, 37, .98)); box-shadow: var(--shadow); cursor: pointer; }
    .entry-card:hover { border-color: var(--blue); transform: translateY(-1px); }
    .entry-card h3 { margin: 11px 0 7px; font-size: 18px; }
    .field-label { display: block; margin: 10px 0 4px; color: #91a9c1; font-size: 9px; font-weight: 850; text-transform: uppercase; letter-spacing: .12em; }
    .function-copy { margin: 0; color: #d2dfed; font-size: 12px; line-height: 1.5; }
    .purpose-copy { margin: 0; color: #a9c4dc; font-size: 11px; line-height: 1.5; }
    .source-copy { margin: 7px 0 0; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .mini-flow { display: flex; gap: 5px; align-items: center; margin: 13px 0; overflow: hidden; }
    .mini-node { max-width: 105px; padding: 5px 7px; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: #0b1727; color: #c9d9e9; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
    .mini-arrow { color: var(--blue); font-size: 11px; }
    .card-footer { margin-top: 11px; }
    .chart-scroll { position: relative; overflow-x: auto; padding: 4px 4px 50px; border: 1px solid rgba(49, 80, 111, .55); border-radius: 18px; background: rgba(5, 13, 24, .52); }
    .execution-chart { position: relative; display: grid; grid-template-columns: minmax(180px, 260px) minmax(390px, 650px) minmax(300px, 430px); grid-auto-rows: minmax(30px, auto); gap: 17px 72px; align-items: center; min-width: 1120px; padding: 32px 45px 55px; }
    .flow-svg { position: absolute; z-index: 0; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
    .flow-edge-spec { display: none; }
    .flow-edge { fill: none; stroke: #6f91b5; stroke-width: 1.7; }
    .flow-edge.call { stroke: var(--violet); stroke-dasharray: 6 4; }
    .flow-edge.failure { stroke: var(--red); }
    .flow-edge.retry { stroke: var(--amber); }
    .flow-edge.pause { stroke: var(--cyan); stroke-dasharray: 6 4; }
    .flow-edge.recovery { stroke: var(--cyan); stroke-dasharray: 3 4; }
    .flow-edge.inferred { stroke-dasharray: 5 5; }
    .edge-label { fill: #c8d9ea; stroke: #06101d; stroke-width: 4px; paint-order: stroke; font-size: 10px; font-weight: 750; text-anchor: middle; }
    .flow-node, .decision-block, .call-stack { position: relative; z-index: 2; }
    .flow-node { padding: 15px 16px; border: 1px solid var(--line); background: linear-gradient(145deg, rgba(19, 38, 61, .98), rgba(9, 22, 37, .98)); box-shadow: 0 13px 35px rgba(0, 0, 0, .2); }
    .flow-node.process { border-radius: 5px; }
    .flow-node.start, .flow-node.end { justify-self: center; width: min(300px, 90%); padding: 11px 18px; border-radius: 999px; text-align: center; }
    .flow-node.end { border-color: rgba(128, 223, 168, .6); color: #b8f1ce; }
    .flow-node.failure-terminal { border-color: rgba(251, 113, 133, .68); border-radius: 999px; background: rgba(73, 21, 35, .82); }
    .flow-node.user-node { border-color: rgba(88, 215, 197, .6); clip-path: polygon(8% 0, 100% 0, 92% 100%, 0 100%); background: rgba(14, 57, 59, .88); }
    .flow-node.unresolved { border-style: dashed; border-color: var(--amber); }
    .flow-node.subprocess { border-right: 5px double rgba(184, 161, 255, .75); border-left: 5px double rgba(184, 161, 255, .75); border-radius: 7px; }
    .flow-node h3, .flow-node h4 { margin: 0; }
    .flow-node h3 { font-size: 16px; }
    .flow-node h4 { font-size: 13px; }
    .node-header { display: flex; gap: 9px; align-items: flex-start; justify-content: space-between; }
    .node-header > div { min-width: 0; }
    .node-header small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
    .node-index { display: inline-grid; place-items: center; flex: 0 0 auto; width: 28px; height: 28px; border: 1px solid rgba(104, 174, 252, .58); border-radius: 50%; color: #c0ddff; background: #102943; font-size: 11px; font-weight: 850; }
    .node-title-row { display: flex; gap: 10px; align-items: flex-start; }
    .io-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 11px; }
    .io-box { min-width: 0; padding: 8px 9px; border: 1px solid rgba(49, 80, 111, .72); border-radius: 8px; background: rgba(5, 13, 24, .5); }
    .io-box b { display: block; margin-bottom: 4px; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .1em; }
    .io-box span { display: block; overflow: hidden; color: #d3e2f1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .decision-block { justify-self: center; width: min(390px, 95%); text-align: center; }
    .decision-diamond { display: grid; place-items: center; min-height: 145px; padding: 34px 68px; clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); background: #49391b; color: #fff0c8; filter: drop-shadow(0 10px 26px rgba(0, 0, 0, .25)); }
    .decision-diamond strong { display: block; max-width: 230px; font-size: 12px; line-height: 1.35; }
    .decision-diamond small { display: block; margin-top: 4px; color: #f4d690; font-size: 9px; }
    .condition-details, .call-details { margin-top: 7px; border: 1px solid rgba(49, 80, 111, .7); border-radius: 8px; background: rgba(9, 22, 37, .92); text-align: left; }
    .condition-details summary, .call-details summary { padding: 7px 9px; color: #bed0e3; font-size: 10px; cursor: pointer; }
    .condition-list, .parameter-list { max-height: 230px; margin: 0; padding: 0 9px 9px; overflow: auto; list-style: none; }
    .condition-list li, .parameter-list li { padding: 7px 0; border-top: 1px solid rgba(49, 80, 111, .42); color: #cad8e6; font-size: 10px; line-height: 1.45; }
    .condition-list .source-button, .parameter-list .source-button { margin-top: 5px; }
    .call-stack { display: grid; gap: 10px; align-self: start; }
    .call-gateway { width: 100%; padding: 12px; border: 3px double rgba(184, 161, 255, .7); border-radius: 7px; background: rgba(37, 28, 67, .82); color: #ded5ff; text-align: left; cursor: pointer; }
    .call-gateway:hover { border-color: var(--violet); }
    .call-gateway strong, .call-gateway small { display: block; }
    .call-gateway small { margin-top: 4px; color: #b9acd9; }
    .call-card .function-copy { font-size: 11px; }
    .call-card .purpose-copy { font-size: 10px; }
    .call-card .io-grid { grid-template-columns: 1fr 1fr; }
    .invocation { margin: 6px 0 0; padding: 7px 8px; border-radius: 6px; background: rgba(5, 13, 24, .65); color: #adbed1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; line-height: 1.45; overflow-wrap: anywhere; }
    .interface-grid { display: grid; grid-template-columns: minmax(330px, .8fr) minmax(360px, 1.2fr); gap: 16px; }
    .panel { padding: 17px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    .panel h3 { margin: 0 0 12px; }
    .parameter-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .parameter-table th, .parameter-table td { padding: 9px 8px; border-bottom: 1px solid rgba(49, 80, 111, .5); text-align: left; vertical-align: top; }
    .parameter-table th { color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .09em; }
    .detailed-use { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-top: 7px; padding: 8px; border-radius: 8px; background: rgba(19, 38, 61, .78); }
    .detailed-use div { min-width: 0; }
    .detailed-use strong, .detailed-use small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detailed-use small { margin-top: 3px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
    .artifact-list, .warning-list { display: grid; gap: 11px; }
    .artifact-card { display: grid; grid-template-columns: minmax(180px, .8fr) minmax(220px, 1fr) 42px minmax(220px, 1fr); gap: 13px; align-items: center; padding: 15px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    .artifact-name { min-width: 0; }
    .artifact-name h3 { margin: 0; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; text-overflow: ellipsis; }
    .artifact-name small { color: var(--muted); }
    .use-column h4 { margin: 0 0 7px; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .1em; }
    .use { display: flex; gap: 7px; align-items: center; justify-content: space-between; margin-top: 6px; padding: 7px 8px; border-radius: 8px; background: rgba(19, 38, 61, .82); font-size: 10px; }
    .use-copy { min-width: 0; }
    .use-copy span, .use-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .use-path { max-width: 320px; margin-top: 3px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
    .arrow { color: var(--blue); font-size: 23px; text-align: center; }
    .warning { padding: 14px 15px; border: 1px solid var(--line); border-left: 3px solid var(--amber); border-radius: 11px; background: var(--panel); }
    .warning.info { border-left-color: var(--blue); }
    .warning p { margin: 7px 0 0; color: #c8d7e8; font-size: 12px; line-height: 1.5; }
    .coverage, .empty { padding: 16px; border: 1px dashed var(--line); border-radius: 12px; color: var(--muted); background: rgba(13, 27, 44, .58); font-size: 12px; line-height: 1.6; }
    .empty { padding: 28px; text-align: center; }
    .source-drawer { position: fixed; z-index: 60; top: 0; right: 0; width: min(730px, 94vw); height: 100vh; padding: 22px; overflow: auto; border-left: 1px solid var(--line); background: #06101d; box-shadow: -28px 0 80px rgba(0, 0, 0, .5); transform: translateX(105%); transition: transform .2s ease; }
    .source-drawer.open { transform: translateX(0); }
    .drawer-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
    .drawer-head h2 { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 16px; }
    .drawer-head p, .copy-path { color: var(--muted); font-size: 11px; }
    .code-view { margin-top: 19px; overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: #030a13; }
    .code-line { display: grid; grid-template-columns: 54px minmax(0, 1fr); min-height: 30px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.55; }
    .code-line.highlight { background: rgba(104, 174, 252, .16); }
    .line-no { padding: 6px 9px; border-right: 1px solid rgba(49, 80, 111, .5); color: #647b94; text-align: right; user-select: none; }
    .line-text { padding: 6px 11px; color: #dbe9f8; white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 920px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { position: static; display: flex; gap: 8px; height: auto; padding: 10px 15px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      .sidebar-group { display: flex; flex: 0 0 auto; gap: 4px; margin: 0; }
      .sidebar-title { align-items: center; margin: 0 6px; }
      .node-link { width: auto; max-width: 210px; }
      .interface-grid { grid-template-columns: 1fr; }
      .artifact-card { grid-template-columns: 1fr; }
      .arrow { transform: rotate(90deg); }
    }
    @media (max-width: 640px) {
      .topbar { padding: 14px; }
      .title-row, .section-head { align-items: stretch; flex-direction: column; }
      .search { width: 100%; }
      main { padding: 21px 13px 60px; }
      .entry-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title-row">
      <div>
        <h1>ARIS 程序执行流程审计图</h1>
        <p class="subtitle">矩形是执行，菱形是判断，双框是子任务或脚本，椭圆是开始/结束；实线来自明确文字，虚线表示仍需人工确认。</p>
      </div>
      <input id="search" class="search" type="search" placeholder="搜索入口、步骤、脚本或文件…" autocomplete="off">
    </div>
    <div id="stats" class="stats"></div>
    <nav class="tabs" aria-label="审计视图">
      <button class="tab active" data-action="tab" data-tab="overview">程序执行图</button>
      <button class="tab" data-action="tab" data-tab="artifacts">文件流</button>
      <button class="tab" data-action="tab" data-tab="warnings">待确认</button>
    </nav>
  </header>
  <div class="layout">
    <aside id="sidebar" class="sidebar"></aside>
    <main id="main"></main>
  </div>
  <aside id="source-drawer" class="source-drawer" aria-hidden="true">
    <div class="drawer-head">
      <div><h2 id="source-title"></h2><p id="source-subtitle"></p></div>
      <button class="ghost-button" data-action="close-source">关闭</button>
    </div>
    <div id="source-code" class="code-view"></div>
    <p id="copy-path" class="copy-path"></p>
  </aside>
  <script id="audit-data" type="application/json">${data}</script>
  <script>
    (function () {
      "use strict";
      var audit = JSON.parse(document.getElementById("audit-data").textContent);
      var defaultSkill = audit.skills.find(function (skill) { return skill.name === "auto-research-loop"; });
      var state = { tab: "overview", selected: defaultSkill ? defaultSkill.id : null, search: "", openCalls: new Set() };
      var nodes = new Map();
      audit.skills.concat(audit.code).forEach(function (node) { nodes.set(node.id, node); });
      var sourceIndex = new Map();

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function rememberSource(source) {
        if (!source) return;
        sourceIndex.set(source.file + ":" + source.line, source);
      }

      audit.skills.forEach(function (skill) {
        skill.steps.forEach(function (step) {
          rememberSource(step.source);
          step.controls.forEach(function (item) { rememberSource(item.source); });
          step.routes.forEach(function (item) {
            rememberSource(item.source);
            (item.occurrences || []).forEach(function (occurrence) { rememberSource(occurrence.source); });
          });
          step.authorityEvidence.forEach(function (item) { rememberSource(item.source); });
        });
      });
      audit.code.forEach(function (node) {
        rememberSource(node.descriptionSource);
        (node.parameters || []).forEach(function (parameter) { rememberSource(parameter.source); });
      });
      audit.calls.forEach(function (call) { rememberSource(call.source); });
      audit.artifacts.forEach(function (artifact) {
        artifact.producers.concat(artifact.consumers, artifact.unknownUses).forEach(function (use) { rememberSource(use.source); });
      });
      audit.warnings.forEach(function (warning) { rememberSource(warning.source); });

      function roleLabel(role) {
        var labels = { coordination: "只负责编排", judgment: "负责判断", execution: "负责执行", mixed: "判断并执行", unclear: "角色待确认" };
        return labels[role] || role;
      }

      function classLabel(classification) {
        var labels = { entry: "入口流程", subtask: "仅子任务", standalone: "独立任务" };
        return labels[classification] || classification;
      }

      function nodeName(id) {
        var node = nodes.get(id);
        return node ? node.name : id;
      }

      function sourceAttributes(source) {
        return ' data-file="' + escapeHtml(source.file) + '" data-line="' + source.line + '"';
      }

      function sourceButton(source, label) {
        if (!source) return "";
        return '<button class="source-button" data-action="source"' + sourceAttributes(source) + '>' + escapeHtml(label || (source.file + ":" + source.line)) + '</button>';
      }

      function badge(label, kind) {
        return '<span class="badge ' + escapeHtml(kind || "") + '">' + escapeHtml(label) + '</span>';
      }

      function matchesSearch(values) {
        if (!state.search) return true;
        return values.join(" ").toLowerCase().includes(state.search.toLowerCase());
      }

      // The source files are intentionally kept in their original language for
      // auditability.  Cards use this small glossary for the human-facing copy
      // so a reviewer can understand the execution role without translating
      // every SKILL.md or helper description first.
      var skillFunctionMap = {
        "auto-research-loop": "按指标目标反复执行实验、复核、指标判断、想法发现和缺口规划，直到满足停止条件。",
        "experiment-bridge": "读取实验计划，实现并运行实验，收集本轮结果后交给复核流程。",
        "auto-review-loop": "多轮复核研究结果、实施修复并再次复核，直到通过或达到轮数上限。",
        "idea-discovery": "从研究方向出发检索资料、提出候选想法并筛选出可验证的方案。",
        "gap-planner": "审计实验缺口，合并或关闭重复缺口并排序，再生成下一轮实验计划。",
        "experiment-env-manager": "统一管理实验环境的创建、修复、验证和需要人工介入的分支。",
        "experiment-env-audit": "通过静态检查和真实运行验证实验环境是否可靠。",
        "experiment-env-configuration": "根据已确认的配置生成项目本地实验脚本和运行环境。",
        "research-setup": "通过问答收集项目配置，初始化研究说明、运行状态和知识库。",
        "research-pipeline": "把想法发现、实验、复核和论文产出串成完整研究流程。",
        "research-refine-pipeline": "把模糊研究方向细化成方法方案，并继续生成实验路线图。",
        "resubmit-pipeline": "在不改动既有实验和引用的前提下，按新的投稿目标期刊或会议重新组织论文。",
        "paper-writing": "把研究报告和实验结果整理成可提交的论文并完成编译检查。",
        "paper-talk": "把论文转换成演讲提纲、幻灯片和最终演示材料。",
        "paper-compile": "编译论文并检查生成的 PDF 是否可交付。",
        "paper-plan": "根据复核结论和实验结果生成论文结构与写作计划。",
        "paper-write": "按照提纲逐节撰写 LaTeX 论文内容。",
        "result-to-claim": "判断实验结果支持哪些论点、缺少哪些证据，并把结果路由到下一步。",
        "analyze-results": "收集并分析实验结果，循环修正分析脚本或补充实验，直到验证通过。",
        "experiment-audit": "检查实验是否真实、范围是否足够，以及结果是否支持当前结论。",
        "citation-audit": "逐条核对论文引用是否真实、归属正确且确实支持对应论述。",
        "paper-claim-audit": "核对论文中的数字和范围是否与原始结果文件一致。",
        "kill-argument": "分别构造最强反驳和回应，找出仍未解决的问题并形成后续实验线索。",
        "dse-loop": "运行设计空间探索，分析结果、调整参数并循环寻找更优配置。",
        "experiment-queue": "管理多种子、多配置实验的远程队列，并处理显存不足重试和状态持久化。",
        "run-experiment": "部署并运行实验，收集任务状态和结果。",
        "monitor-experiment": "监控运行中的实验，检查进度并收集结果。",
        "training-check": "定期检查训练指标，及时发现 NaN、发散或 GPU 空转。",
        "research-wiki": "维护跨研究周期的知识库，保存论文、想法、实验、论点及其关系。",
        "render-html": "把研究 Markdown 或 JSON 产物渲染成单文件 HTML。",
        "figure-spec": "根据结构化图形规格生成可编辑的出版级 SVG。",
        "figure-description": "处理专利附图并生成正式的附图说明。",
        "patent-pipeline": "把发明描述整理成完整的专利申请文件并转换为指定国家格式。",
        "patent-review": "获取外部专利审查意见，检查权利要求和说明书的问题。",
        "prior-art-search": "检索与发明相关的专利和学术现有技术。",
        "patent-novelty-check": "根据现有技术评估发明的新颖性和非显而易见性。",
        "grant-proposal": "把研究想法整理成符合目标资助机构格式的基金申请书。",
        "rebuttal": "解析外部审稿意见，在约束下撰写有依据的回复并管理后续轮次。",
        "meta-optimize": "分析使用记录并提出技能、评审提示和流程默认值的改进建议。",
        "meta-apply": "只把已获批准的自我优化补丁应用到技能库，并保留审查证据。",
        "research-lit": "检索和分析论文，整理相关工作与关键观点。",
        "arxiv": "从 arXiv 检索、下载并概括学术论文。",
        "openalex": "通过 OpenAlex 检索论文及其引用、机构和资助信息。",
        "semantic-scholar": "通过 Semantic Scholar 检索已发表论文及其引用信息。",
        "deepxiv": "通过 DeepXiv 分层检索并阅读开放获取论文。",
        "exa-search": "通过 Exa 搜索网页并提取页面内容。",
        "novelty-check": "检索近期文献，核验研究想法是否具有新颖性。",
        "idea-creator": "根据研究方向生成并排序候选研究想法。",
        "auto-paper-improvement-loop": "循环复核并修改已生成的论文，重新编译后输出改进版本。",
        "paper-figure": "根据实验结果生成论文图表。",
        "paper-slides": "从已编译论文生成会议演示文稿、PPTX 和演讲备注。",
        "slides-polish": "逐页检查并修正幻灯片的布局、字号、溢出和视觉一致性。",
        "paper-poster-html": "生成带硬性版式检查的学术会议海报 HTML，并导出可打印 PDF。",
        "overleaf-sync": "在本地论文目录和 Overleaf 项目之间同步文件。",
        "proof-checker": "严格检查数学证明，修复缺口并重复复核。",
        "proof-writer": "为定理、引理或推论补写严格的数学证明。",
        "formula-derivation": "整理假设和公式，形成连贯、可写入论文的推导文档。",
        "experiment-plan": "把研究方案转成按论点组织的详细实验路线、评估协议和运行顺序。",
        "ablation-planner": "在主要结果支持论点时规划消融实验，以满足论文投稿所需证据。",
        "aris-update": "比较当前项目和上游 ARIS 技能，展示差异并按项目进度应用更新。",
        "system-profile": "对目标程序、进程或硬件进行性能分析，定位瓶颈。",
        "vast-gpu": "租用、管理和释放 Vast.ai GPU 实例。",
        "serverless-modal": "在 Modal 上运行 GPU 训练、微调、推理或批处理任务。",
        "qzcli": "通过 qzcli 管理启智平台上的 GPU 计算任务。",
        "feishu-notify": "向飞书或 Lark 发送状态通知。",
        "watchdog": "监控服务端任务状态并在异常时触发处理。",
        "alphaxiv": "通过 AlphaXiv 快速查找和概括单篇论文。",
        "auto-review-loop-llm": "通过兼容的语言模型接口进行多轮研究复核，直到通过或达到上限。",
        "auto-review-loop-minimax": "通过 MiniMax 进行多轮研究复核，直到通过或达到上限。",
        "claims-drafting": "根据发明内容起草专利权利要求。",
        "comm-lit-review-claude-single": "面向通信领域检索并整理相关文献。",
        "embodiment-description": "为专利说明书撰写具体实施方式。",
        "gemini-search": "通过 Gemini 广泛检索研究论文。",
        "idea-discovery-robot": "面向机器人和具身智能完成文献检索、想法生成与评审。",
        "interview-cheatsheet": "围绕指定机器学习主题生成中文面试速查资料。",
        "invention-structuring": "把零散发明想法整理成正式的发明披露材料。",
        "jurisdiction-format": "把专利申请编排成指定法域的递交格式。",
        "mermaid-diagram": "根据需求生成 Mermaid 流程图或其他结构图。",
        "paper-illustration": "通过图像生成和评审循环制作论文插图。",
        "paper-illustration-image2": "通过本地图像生成桥接流程制作论文插图。",
        "paper-poster": "维护旧版论文海报流程，仅用于兼容旧调用。",
        "pixel-art": "生成适合文档、README 或幻灯片的像素风 SVG 插图。",
        "research-refine": "把模糊研究方向打磨成聚焦、可实现的方法方案。",
        "research-review": "通过外部评审后端对研究想法、论文或实验结果做批判性复核。",
        "specification-writing": "根据权利要求和发明披露撰写完整专利说明书。",
        "wiki-enrich": "补全研究知识库中论文页面的摘要、方法和结果内容。",
        "writing-systems-papers": "为系统论文提供按段落组织的结构和写作蓝图。"
      };

      var codeFunctionMap = {
        "build_manifest.py": "把网格规格转换成实验队列使用的 manifest.json。",
        "queue_manager.py": "在远程主机调度实验，分配空闲 GPU，处理显存不足重试并持续写入状态。",
        "figure_renderer.py": "把 FigureSpec 结构转换成 SVG 图形。",
        "paper_illustration_image2.py": "为论文插图流程提供本地图像生成集成辅助。",
        "__init__.py": "执行 Python 包初始化辅助操作。",
        "canvas.py": "从海报 CSS 或命令行参数解析画布尺寸。",
        "measure.py": "执行版面对齐硬检查，测量各列底部差异。",
        "polish.py": "执行版面软检查，检查图形比例、字号和视觉细节。",
        "preflight.py": "在渲染前执行静态 HTML 检查，发现残留标记和本地资源问题。",
        "render.py": "提供 Playwright 启动、字体加载和页面稳定等待的公共辅助。",
        "textutil.py": "把输出文本转成适合终端、CI 日志和问题单的安全格式。",
        "verify_final.py": "检查最终 PDF 的页数、尺寸和文件大小。",
        "asset_check.py": "检查论文图形的来源、面积和分辨率。",
        "extract_pdf_figures.py": "从 PDF 提取论文图形并生成联系表。",
        "poster_check.py": "按固定顺序运行海报的预检、样式、素材、对齐和润色检查。",
        "preprocess_figures.py": "裁剪图形周围的空白并报告原始尺寸。",
        "render_preview.py": "把海报 HTML 渲染成可打印 PDF 和预览缩略图。",
        "run_gates.py": "按固定顺序编排海报的五道检查并写出总报告。",
        "style_check.py": "执行海报样式硬检查，核对预先规定的版式规则。",
        "metric-gate.ts": "解析指标目标配置，并按固定规则判断是否停止循环。",
        "dashboard-merge.ts": "校验工作结果收据，并原子地合并到运行仪表盘。",
        "run-state.ts": "保存可恢复的运行状态，区分“已完成”和“已验收”。",
        "research-wiki.ts": "提供研究知识库的读取、写入和索引功能。",
        "render-html.ts": "把 ARIS Markdown 产物渲染成单文件 HTML。",
        "render_html.py": "把 ARIS Markdown 产物渲染成单文件 HTML。",
        "verify-papers.ts": "在开始检索前核验论文是否真实存在。",
        "threat-scan.ts": "扫描提示注入和数据外传风险。",
        "arxiv-fetch.ts": "搜索并下载 arXiv 论文。",
        "openalex-fetch.ts": "从 OpenAlex 搜索学术论文。",
        "semantic-scholar-fetch.ts": "从 Semantic Scholar 搜索并获取论文。",
        "deepxiv-fetch.ts": "通过 DeepXiv 搜索和分层读取论文。",
        "exa-search.ts": "通过 Exa 执行网络检索并提取内容。",
        "evidence-check.ts": "对实验文件做确定性的证据预检查。",
        "iteration-log.ts": "检测循环停滞，并在必要时强制切换研究方向。",
        "watchdog-early-stop.ts": "根据看门狗状态提前停止任务。",
        "parse-env.ts": "校验实验环境配置并写入配置文件。",
        "env-helper.ts": "统一提供实验环境的创建、检查、部署、监控、收集和销毁操作。",
        "docker-env.ts": "使用 Docker 管理实验环境的创建、部署、监控和结果收集。",
        "local-env.ts": "管理本地实验环境的创建、部署、监控和结果收集。",
        "remote-env.ts": "管理远程实验环境的创建、部署、监控和结果收集。",
        "modal-env.ts": "管理 Modal 实验环境的部署和结果收集。",
        "vast-env.ts": "管理 Vast.ai 实验环境的部署和结果收集。",
        "skill-flow-audit.ts": "扫描技能、脚本和工具，生成可回溯到源码行号的程序执行流程图。",
        "experiment-queue-build-manifest-shim.ts": "把收到的命令行参数转交给实验队列的 manifest 生成脚本。",
        "experiment-queue-queue-manager-shim.ts": "把收到的命令行参数转交给实验队列调度脚本。",
        "figure-renderer-shim.ts": "把收到的命令行参数转交给 FigureSpec SVG 渲染脚本。",
        "paper-illustration-image2-shim.ts": "把命令转交给论文插图生成辅助流程。",
        "provenance.ts": "记录来源并把来源信息作为授权依据。",
        "capture-filter.ts": "过滤可能污染研究记录的外部输入。",
        "gpu-sample-history.ts": "记录 GPU 采样历史，并提供统计和清理功能。",
        "extract-paper-style.ts": "从参考论文提取可选的版式风格概要。",
        "check-skills-inventory.ts": "检查 ARIS 技能清单和文档是否发生漂移。",
        "convert-skills-to-llm-chat.ts": "把 Codex 技能转换成兼容 llm-chat 的版本。",
        "overleaf_audit.sh": "扫描仓库，检查是否意外泄露 Overleaf 令牌。",
        "overleaf_setup.sh": "交互式配置一次性的 Overleaf Git 桥接。",
        "verify_paper_audits.sh": "验证论文必须完成的审计是否齐全且仍然有效。",
        "verify_wiki_coverage.sh": "检查近期产物引用的论文是否已进入研究知识库。",
        "lint_skills_helpers.sh": "检查技能是否通过约定的安全路径引用辅助工具。",
        "render_w_agent_prompt.sh": "根据项目配置生成 W-agent 的提示词和运行配置。",
        "save_trace.sh": "把评审调用轨迹保存到 .aris/traces/，供后续审计。",
        "log_event.sh": "读取 hook 事件并把结构化记录写入项目和全局日志。",
        "check_ready.sh": "检查是否积累了足够的使用记录以提示运行自我优化。"
        ,"env-backend.ts": "提供实验环境后端错误类型和共享接口。",
        "index.ts": "统一导出实验环境后端、错误和安全命令工具。",
        "watchdog.ts": "监控服务端任务状态，并在异常时触发处理。"
      };

      var nameWordMap = {
        auto: "自动", research: "研究", loop: "循环", paper: "论文", writing: "写作", write: "撰写", review: "复核",
        experiment: "实验", audit: "审计", plan: "规划", planner: "规划", idea: "想法", discovery: "发现", search: "检索",
        check: "检查", novelty: "新颖性", citation: "引用", claim: "论点", claims: "论点", drafting: "起草", patent: "专利",
        proposal: "申请书", pipeline: "流程", setup: "初始化", env: "环境", configuration: "配置", manager: "管理", bridge: "桥接",
        result: "结果", figure: "图形", render: "渲染", proof: "证明", writer: "撰写", format: "格式", resubmit: "重投",
        monitor: "监控", training: "训练", wiki: "知识库", compile: "编译", slides: "幻灯片", poster: "海报", sync: "同步",
        formula: "公式", derivation: "推导", ablation: "消融", queue: "队列", serverless: "无服务器", modal: "Modal", vast: "Vast",
        gpu: "GPU", system: "系统", profile: "性能分析", notification: "通知", notify: "通知", watchdog: "看门狗", kill: "反驳",
        argument: "论证", prior: "现有技术", art: "技术", deepxiv: "DeepXiv", arxiv: "arXiv", openalex: "OpenAlex",
        semantic: "Semantic", scholar: "Scholar", exa: "Exa", feishu: "飞书", meta: "元优化", optimize: "优化",
        metric: "指标", gate: "判断", state: "状态", dashboard: "仪表盘", merge: "合并", receipt: "收据", agent: "代理", prompt: "提示词", w: "W",
        illustration: "插图", image: "图像", style: "风格", extract: "提取", convert: "转换", skills: "技能",
        inventory: "清单", overleaf: "Overleaf", verify: "验证", coverage: "覆盖率", trace: "轨迹", log: "日志", event: "事件",
        ready: "就绪", run: "运行", implement: "实现", queue_manager: "实验队列管理"
      };

      function humanizeName(name) {
        var raw = String(name || "").split(".")[0].replaceAll("-", " ").replaceAll("_", " ");
        return raw.split(" ").filter(Boolean).map(function (word) { return nameWordMap[word.toLowerCase()] || word; }).join("");
      }

      function translatedDescription(node) {
        var raw = String(node && node.description || "").trim();
        if (!raw) return "";
        if (/[一-鿿]/.test(raw) && !/[A-Za-z]{5,}/.test(raw)) return raw;
        var mapped = codeFunctionMap[node.name];
        if (mapped) return mapped;
        var descriptionMap = [
          ["Metric-target-driven iterative research loop", "按指标目标推进的迭代研究循环。"],
          ["Post-idea gap audit and experiment planning", "在想法发现后审计实验缺口，并规划下一轮实验。"],
          ["Autonomous multi-round research review loop", "自动进行多轮研究复核，直到通过或达到轮数上限。"],
          ["Workflow 1.5: Bridge between idea discovery and auto review", "连接想法发现与自动复核的实验执行桥接。"],
          ["Search and download", "搜索并下载相关资料。"],
          ["Search and fetch papers", "搜索并获取学术论文。"],
          ["Search OpenAlex", "从 OpenAlex 搜索学术论文。"],
          ["AI-powered web search", "执行网络检索并提取页面内容。"],
          ["Validate experiment evidence", "校验实验证据并写出判断结果。"],
          ["Render an ARIS Markdown artifact", "把 ARIS Markdown 产物渲染成单文件 HTML。"],
          ["ARIS Research Wiki utilities", "提供研究知识库的读取、写入和索引功能。"],
          ["ARIS resumable run-state", "保存可恢复的运行状态，区分完成和验收。"],
          ["ARIS injection / exfiltration scanner", "扫描提示注入和数据外传风险。"]
        ];
        for (var index = 0; index < descriptionMap.length; index += 1) {
          if (raw.toLowerCase().includes(descriptionMap[index][0].toLowerCase())) return descriptionMap[index][1];
        }
        return "";
      }

      function functionTextForSkill(skill) {
        return skillFunctionMap[skill.name] || "负责执行“" + humanizeName(skill.name) + "”子流程，处理输入并产出后续结果。";
      }

      function functionTextForCode(node) {
        return translatedDescription(node) || "提供“" + humanizeName(node.name) + "”工具能力，处理流程传入的参数和文件。";
      }

      function functionTextForNode(node) {
        if (!node) return "调用目标不存在，功能无法确认。";
        return node.kind === "skill" ? functionTextForSkill(node) : functionTextForCode(node);
      }

      function sourceDescriptionDetails(node, label) {
        if (!node || !node.description) return "";
        return '<details class="call-details"><summary>' + escapeHtml(label || "源码原文功能说明") + '</summary><p class="source-copy">' + escapeHtml(node.description) + '</p></details>';
      }

      function entryPurposeText(skill) {
        return "作为当前入口，启动“" + humanizeName(skill.name) + "”并串联各执行环节；遇到判断时决定继续、重试、暂停或结束。";
      }

      function stepFunctionText(step) {
        var title = String(step.title || "").toLowerCase();
        if (title.includes("precondition") || title.includes("initialize") || title.includes("初始化")) return "检查运行前提并初始化本轮运行状态。";
        if (title.includes("experiment bridge") || title.includes("experiment implementation")) return "派发实验执行桥接，实现并运行当前实验，收集本轮结果。";
        if (title.includes("auto review") || title.includes("review")) return "派发复核流程，检查当前结果并记录复核结论。";
        if (title.includes("metric") || title.includes("stop gate")) return "根据指标数据做确定性判断，决定停止还是进入下一轮。";
        if (title.includes("idea") || title.includes("discover")) return "根据上一轮证据提出并筛选下一轮实验想法。";
        if (title.includes("gap") || title.includes("planner")) return "审计、合并、关闭并排序实验缺口，生成下一轮计划。";
        if (title.includes("summary") || title.includes("report")) return "在流程停止后汇总结果并生成报告。";
        if (title.includes("paper") || title.includes("write")) return "根据已经验证的结果生成或更新论文内容。";
        return "执行本步骤规定的操作，处理输入并产生后续结果。";
      }

      function stepPurposeText(skill, step, index) {
        var calls = callsForStep(skill, step.id);
        var hasDecision = step.routes.some(function (route) { return route.conditional; });
        var callNames = calls.map(function (call) { var target = nodes.get(call.to); return target ? humanizeName(target.name) : humanizeName(call.to); });
        var text = "在“" + humanizeName(skill.name) + "”中，这是第 " + (index + 1) + " 个执行环节";
        if (callNames.length) text += "，这里调用“" + callNames.join("、") + "”完成本步的辅助工作";
        if (hasDecision || step.routes.length) text += "；完成后根据结果选择继续、重试、暂停、恢复或结束。";
        else text += "，并把结果交给下一步。";
        return text;
      }

      function callPurposeText(call, target) {
        var name = target ? humanizeName(target.name) : humanizeName(call.to);
        var role = target && target.kind === "skill" ? "子流程" : "执行工具";
        if (target && target.authority === "judgment") role = "判断子流程";
        return "当前步骤在这里调用“" + name + "”这个" + role + "完成本步处理，结束后把结果交回主流程。";
      }

      function codePurposeText(node) {
        var callers = audit.calls.filter(function (call) { return call.to === node.id; }).map(function (call) {
          var owner = nodes.get(call.from);
          return owner ? humanizeName(owner.name) : humanizeName(call.from);
        });
        if (callers.length) return "当前流程在“" + Array.from(new Set(callers)).join("、") + "”中把它作为执行工具调用，完成处理后把结果交回调用方。";
        return "当前扫描未发现明确调用方；它可以作为独立工具被流程或人工直接使用。";
      }

      function routeFunctionText(route) {
        if (route.kind === "failure") return "终止当前流程并报告失败。";
        if (route.kind === "pause") return "暂停执行并等待用户输入或选择。";
        if (route.kind === "retry") return "重新执行当前步骤，直到重试条件解除或流程失败。";
        if (route.kind === "recovery") return "恢复已保存的运行状态，并回到可继续执行的位置。";
        return "根据当前判断把流程转交到下一个执行节点。";
      }

      function routePurposeText(route) {
        if (route.kind === "failure") return "当前流程用这条路径隔离错误，防止失败结果继续传给后续步骤。";
        if (route.kind === "pause") return "当前流程无法自动决定时在这里停下，把选择权交给用户。";
        if (route.kind === "retry") return "当前流程在本步结果未通过时从这里回到执行节点。";
        if (route.kind === "recovery") return "当前流程从保存的状态恢复，避免重新执行已经完成的部分。";
        return "当前流程根据判断结果沿这条路径继续推进。";
      }

      function parameterDescriptionText(parameter) {
        var raw = String(parameter && parameter.description || "").trim();
        if (!raw) return "用于向工具传入或配置本步骤所需信息。";
        if (/[一-鿿]/.test(raw) && !/[A-Za-z]{5,}/.test(raw)) return raw;
        var lower = raw.toLowerCase();
        if (lower.includes("to read") || lower.includes("read")) return "要读取的输入文件或数据。";
        if (lower.includes("to write") || lower.includes("write") || lower.includes("output")) return "要写出的输出文件或结果。";
        if (lower.includes("path") || lower.includes("file") || lower.includes("directory")) return "文件或目录位置。";
        if (lower.includes("config") || lower.includes("option")) return "控制工具行为的配置项。";
        return "传给“" + humanizeName(parameter.syntax || parameter.name) + "”的输入信息。";
      }

      function renderStats() {
        var items = [
          ["入口", audit.stats.entries], ["仅子任务", audit.stats.subtasks], ["脚本/工具", audit.coverage.scriptFiles + audit.coverage.toolFiles],
          ["调用", audit.stats.calls], ["文件关系", audit.stats.artifacts], ["需确认", audit.stats.reviewWarnings]
        ];
        document.getElementById("stats").innerHTML = items.map(function (item) {
          return '<span class="stat">' + escapeHtml(item[0]) + ' <strong>' + item[1] + '</strong></span>';
        }).join("");
      }

      function groupLinks(title, entries) {
        if (!entries.length) return "";
        var links = entries.map(function (node) {
          var active = state.selected === node.id ? " active" : "";
          var suffix = node.kind === "skill" ? "" : " <small>· " + (node.kind === "tool" ? "工具" : "脚本") + "</small>";
          var description = node.description || "";
          return '<button class="node-link' + active + '" title="' + escapeHtml(description) + '" data-action="select-node" data-node="' + escapeHtml(node.id) + '">' + escapeHtml(node.name) + suffix + '</button>';
        }).join("");
        return '<section class="sidebar-group"><h2 class="sidebar-title"><span>' + escapeHtml(title) + '</span><span>' + entries.length + '</span></h2>' + links + '</section>';
      }

      function renderSidebar() {
        var skillFilter = function (skill) { return matchesSearch([skill.name, skill.description, skill.file]); };
        var entries = audit.skills.filter(function (skill) { return skill.classification === "entry" && skillFilter(skill); });
        var subtasks = audit.skills.filter(function (skill) { return skill.classification === "subtask" && skillFilter(skill); });
        var standalone = audit.skills.filter(function (skill) { return skill.classification === "standalone" && skillFilter(skill); });
        var code = audit.code.filter(function (node) { return matchesSearch([node.name, node.file, node.description, node.ownerSkill || ""]); });
        document.getElementById("sidebar").innerHTML = groupLinks("入口流程", entries) + groupLinks("仅子任务", subtasks) + groupLinks("独立任务", standalone) + groupLinks("脚本与工具", code);
      }

      function usesForStep(stepId, direction) {
        var uses = new Map();
        audit.artifacts.forEach(function (artifact) {
          var candidates = direction === "input" ? artifact.consumers : artifact.producers;
          candidates.forEach(function (use) {
            if (use.stepId !== stepId) return;
            var existing = uses.get(artifact.key);
            if (!existing || (existing.use.confidence === "inferred" && use.confidence === "explicit")) uses.set(artifact.key, { artifact: artifact, use: use });
          });
        });
        return Array.from(uses.values());
      }

      function usesForOwner(ownerId, direction) {
        var uses = new Map();
        audit.artifacts.forEach(function (artifact) {
          var candidates = direction === "input" ? artifact.consumers : artifact.producers;
          candidates.forEach(function (use) {
            if (use.owner !== ownerId) return;
            var existing = uses.get(artifact.key);
            if (!existing || (existing.use.confidence === "inferred" && use.confidence === "explicit")) uses.set(artifact.key, { artifact: artifact, use: use });
          });
        });
        return Array.from(uses.values());
      }

      function parameterIoKind(parameter) {
        var text = (parameter.name + " " + parameter.syntax + " " + parameter.description).toLowerCase();
        if (/\b(?:output|out|destination|dest|write|save|emit|export)\b|输出|写出|保存|生成/.test(text)) return "output";
        if (/\b(?:input|source|src|manifest|receipt|config|root|file|path|dir|query|url)\b|输入|读取|来源|路径|目录/.test(text)) return "input";
        return "config";
      }

      function declaredParameterNames(target, direction) {
        if (!target || target.kind === "skill") return [];
        return (target.parameters || []).filter(function (parameter) { return parameterIoKind(parameter) === direction; }).map(function (parameter) { return parameter.syntax; });
      }

      function renderIo(title, uses, declared) {
        var content = uses.slice(0, 5).map(function (entry) {
          return '<span title="' + escapeHtml(entry.use.rawPath) + '">' + escapeHtml(entry.artifact.displayName) + '</span>';
        }).join("");
        (declared || []).slice(0, Math.max(0, 5 - uses.length)).forEach(function (syntax) { content += '<span title="由命令行参数声明">参数 ' + escapeHtml(syntax) + '</span>'; });
        if (!content) content = '<span style="color:var(--muted)">源码未明确</span>';
        return '<div class="io-box"><b>' + escapeHtml(title) + '</b>' + content + '</div>';
      }

      function renderOverview() {
        var entries = audit.skills.filter(function (skill) { return skill.classification === "entry" && matchesSearch([skill.name, skill.description, skill.file]); });
        var cards = entries.map(function (skill) {
          var steps = skill.steps.slice(0, 5);
          var mini = '<span class="mini-node">开始</span>' + steps.map(function (step) { return '<span class="mini-arrow">→</span><span class="mini-node" title="' + escapeHtml(step.title) + '">' + escapeHtml(step.title) + '</span>'; }).join("");
          if (skill.steps.length > 5) mini += '<span class="mini-arrow">→</span><span class="mini-node">+' + (skill.steps.length - 5) + ' 步</span>';
          mini += '<span class="mini-arrow">→</span><span class="mini-node">结束</span>';
          var routes = skill.steps.reduce(function (sum, step) { return sum + step.routes.length; }, 0);
          return '<article class="entry-card" data-action="select-node" data-node="' + escapeHtml(skill.id) + '">' +
            badge(classLabel(skill.classification), "entry") + " " + badge(roleLabel(skill.authority), skill.authority) +
            '<h3>/' + escapeHtml(skill.name) + '</h3><span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(functionTextForSkill(skill)) + '</p>' +
            '<span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(entryPurposeText(skill)) + '</p>' +
            sourceDescriptionDetails(skill) +
            '<span class="field-label">主执行顺序预览</span><div class="mini-flow">' + mini + '</div>' +
            '<footer class="card-footer">' + badge(skill.steps.length + " 个执行步骤", "") + badge(routes + " 条分支/异常", "judgment") + badge(skill.outbound + " 个对外调用", "mixed") + '</footer></article>';
        }).join("");
        document.getElementById("main").innerHTML =
          '<div class="section-head"><div><h2>选择一个执行入口</h2><p>这里仅用于选择入口。点开后显示从开始到结束的实际执行节点、判断分支、回跳、暂停和子任务调用。</p></div></div>' +
          '<div class="legend"><span class="legend-shape start"></span> 开始/结束 <span class="legend-shape"></span> 执行 <span class="legend-shape decision"></span> 判断 <span class="legend-shape subprocess"></span> 子任务或脚本</div>' +
          '<div class="entry-grid">' + cards + '</div>' + (cards ? "" : '<div class="empty">没有匹配的入口。</div>');
      }

      function targetParameters(target) {
        if (!target) return [];
        if (target.kind === "skill") {
          if (!target.argumentHint) return [];
          return [{ name: "调用参数", syntax: target.argumentHint, description: "SKILL.md 声明的调用格式", required: false, source: null }];
        }
        return target.parameters || [];
      }

      function renderParameterList(target) {
        var parameters = targetParameters(target);
        if (!parameters.length) return '<li>源码没有声明命令行参数。</li>';
        return parameters.map(function (parameter) {
          var ioKind = parameterIoKind(parameter);
          var ioLabel = ioKind === "input" ? "输入" : (ioKind === "output" ? "输出" : "配置");
          return '<li><code>' + escapeHtml(parameter.syntax) + '</code> ' + badge(parameter.required ? "必填" : "可选", parameter.required ? "retry" : "") + " " + badge(ioLabel, ioKind === "output" ? "execution" : "") +
            '<br>' + escapeHtml(parameterDescriptionText(parameter)) + (parameter.source ? '<br>' + sourceButton(parameter.source, "参数来源") : "") + '</li>';
        }).join("");
      }

      function renderCallNode(call, flowId) {
        var target = nodes.get(call.to);
        var targetRole = target ? roleLabel(target.authority) : "目标缺失";
        var targetKind = target && target.kind !== "skill" ? "tool" : (target ? target.authority : "retry");
        var inputs = target ? usesForOwner(target.id, "input") : [];
        var outputs = target ? usesForOwner(target.id, "output") : [];
        var confidence = call.confidence === "inferred" ? badge("推测调用", "inferred") : badge("明确调用", "entry");
        if (call.relation === "prohibited") confidence = badge("禁止调用", "retry");
        if (call.relation === "import") confidence = badge("代码导入", "mixed");
        var open = target ? '<button class="small-button" data-action="select-node" data-node="' + escapeHtml(target.id) + '">打开完整节点</button>' : "";
        return '<article class="flow-node subprocess call-card" data-flow-node-id="' + escapeHtml(flowId) + '">' +
          '<div class="node-header"><div><h4>' + escapeHtml(target ? target.name : call.to) + '</h4><small>' + escapeHtml(target ? target.file : "未找到目标文件") + '</small></div>' + badge(targetRole, targetKind) + '</div>' +
          '<span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(functionTextForNode(target)) + '</p>' +
          '<span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(callPurposeText(call, target)) + '</p>' +
          sourceDescriptionDetails(target) +
          '<div class="io-grid">' + renderIo("输入文件/参数", inputs, declaredParameterNames(target, "input")) + renderIo("输出文件/参数", outputs, declaredParameterNames(target, "output")) + '</div>' +
          '<details class="call-details"><summary>入参与本次调用</summary><ul class="parameter-list">' + renderParameterList(target) +
          '<li><strong>本次调用：</strong><div class="invocation">' + escapeHtml(call.summary) + '</div>' + sourceButton(call.source, "调用来源") + '</li></ul></details>' +
          '<div class="call-actions">' + confidence + open + '</div></article>';
      }

      function edgeSpec(from, to, label, kind, confidence) {
        return '<span class="flow-edge-spec" data-from="' + escapeHtml(from) + '" data-to="' + escapeHtml(to) + '" data-label="' + escapeHtml(label || "") + '" data-kind="' + escapeHtml(kind || "main") + '" data-confidence="' + escapeHtml(confidence || "explicit") + '"></span>';
      }

      function compactCondition(route) {
        if (route.kind === "failure") return route.occurrences.length > 1 ? "是否出现任一失败条件？" : "是否执行失败？";
        if (route.kind === "retry") return "是否需要重试本步骤？";
        if (route.kind === "pause") return "是否需要暂停并询问用户？";
        var text = route.condition || route.summary || "是否走此分支？";
        text = text.replace(/^\s*(?:if|when|unless)\s+/i, "").replace(/[：:]$/, "");
        if (text.length > 105) text = text.slice(0, 102) + "…";
        return text.endsWith("?") || text.endsWith("？") ? text : text + "？";
      }

      function renderRouteEvidence(route) {
        var occurrences = route.occurrences || [{ condition: route.condition, summary: route.summary, source: route.source }];
        return '<details class="condition-details"><summary>' + occurrences.length + ' 个触发条件与源码</summary><ul class="condition-list">' + occurrences.map(function (occurrence) {
          return '<li>' + escapeHtml(occurrence.condition || occurrence.summary) + '<br>' + sourceButton(occurrence.source, occurrence.source.file + ":" + occurrence.source.line) + '</li>';
        }).join("") + '</ul></details>';
      }

      function routeTerminal(route, flowId) {
        if (route.kind === "failure") {
          return '<article class="flow-node failure-terminal" data-flow-node-id="' + escapeHtml(flowId) + '"><h4>失败终止</h4><span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(routeFunctionText(route)) + '</p><span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(routePurposeText(route)) + '</p><span class="field-label">源码写出的去向</span><p class="source-copy">' + escapeHtml(route.destination) + '</p></article>';
        }
        if (route.kind === "pause") {
          return '<article class="flow-node user-node" data-flow-node-id="' + escapeHtml(flowId) + '"><h4>等待用户输入</h4><span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(routeFunctionText(route)) + '</p><span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(routePurposeText(route)) + '</p><span class="field-label">源码写出的去向</span><p class="source-copy">' + escapeHtml(route.destination) + '</p></article>';
        }
        return '<article class="flow-node unresolved" data-flow-node-id="' + escapeHtml(flowId) + '"><h4>去向未定位</h4><span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(routeFunctionText(route)) + '</p><span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(routePurposeText(route)) + '</p><span class="field-label">源码写出的去向</span><p class="source-copy">' + escapeHtml(route.destination) + '</p></article>';
      }

      function renderStepNode(skill, step, index, row) {
        var inputs = usesForStep(step.id, "input");
        var outputs = usesForStep(step.id, "output");
        var controls = step.controls.map(function (control) {
          var labels = { loop: "含循环", retry: "含重试", pause: "会暂停/询问" };
          return badge(labels[control.kind] || control.kind, control.kind);
        }).join("");
        var searchClass = matchesSearch([step.title, step.summary, step.source.file]) ? "" : " opacity:.38";
        return '<article class="flow-node process" style="grid-column:2;grid-row:' + row + ';' + searchClass + '" data-flow-node-id="' + escapeHtml(step.id) + '">' +
          '<div class="node-title-row"><span class="node-index">' + (index + 1) + '</span><div style="min-width:0;flex:1"><div class="node-header"><div><h3>' + escapeHtml(step.title) + '</h3></div>' + badge(roleLabel(step.authority), step.authority) + '</div>' +
          '<span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(stepFunctionText(step)) + '</p>' +
          '<span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(stepPurposeText(skill, step, index)) + '</p>' +
          '<details class="call-details"><summary>源码原文步骤说明</summary><p class="source-copy">' + escapeHtml(step.summary) + '</p></details></div></div>' +
          '<div class="io-grid">' + renderIo("输入文件", inputs) + renderIo("输出文件", outputs) + '</div>' +
          '<div class="card-footer">' + controls + sourceButton(step.source, step.source.file + ":" + step.source.line) + '</div></article>';
      }

      function callsForStep(skill, stepId) {
        return audit.calls.filter(function (call) {
          return call.from === skill.id && call.stepId === stepId && (call.relation === "call" || call.relation === "prohibited" || call.relation === "import");
        });
      }

      function renderCallLane(skill, step, row, edges) {
        var calls = callsForStep(skill, step.id);
        if (!calls.length) return "";
        var open = state.openCalls.has(step.id);
        if (!open) {
          var gateId = step.id + ":calls";
          edges.push(edgeSpec(step.id, gateId, "调用并返回", "call", calls.some(function (call) { return call.confidence === "inferred"; }) ? "inferred" : "explicit"));
          return '<div class="call-stack" style="grid-column:3;grid-row:' + row + '"><button class="call-gateway" data-flow-node-id="' + escapeHtml(gateId) + '" data-action="toggle-calls" data-step="' + escapeHtml(step.id) + '"><strong>子任务 / 脚本调用 · ' + calls.length + '</strong><small>' + escapeHtml(calls.map(function (call) { return nodeName(call.to); }).join("、")) + '</small><span class="field-label">功能（中文）</span><p class="function-copy">在侧栏展开并查看这些调用各自能做什么。</p><span class="field-label">当前流程作用</span><p class="purpose-copy">本步骤通过这些调用完成辅助工作，完成后回到主流程。</p></button></div>';
        }
        var cards = calls.map(function (call, index) {
          var callId = step.id + ":call:" + index;
          edges.push(edgeSpec(step.id, callId, call.relation === "prohibited" ? "禁止" : "调用并返回", "call", call.confidence));
          return renderCallNode(call, callId);
        }).join("");
        return '<div class="call-stack" style="grid-column:3;grid-row:' + row + '"><button class="small-button" data-action="toggle-calls" data-step="' + escapeHtml(step.id) + '">收起 ' + calls.length + ' 个调用</button>' + cards + '</div>';
      }

      function renderUnscopedCallLane(skill, startId, edges) {
        var calls = audit.calls.filter(function (call) {
          return call.from === skill.id && !call.stepId && (call.relation === "call" || call.relation === "import");
        });
        if (!calls.length) return "";
        var key = skill.id + ":shared-calls";
        var open = state.openCalls.has(key);
        if (!open) {
          var gateId = key + ":gateway";
          edges.push(edgeSpec(startId, gateId, "全程共用", "call", calls.some(function (call) { return call.confidence === "inferred"; }) ? "inferred" : "explicit"));
          return '<div class="call-stack" style="grid-column:3;grid-row:1"><button class="call-gateway" data-flow-node-id="' + escapeHtml(gateId) + '" data-action="toggle-calls" data-step="' + escapeHtml(key) + '"><strong>跨步骤共用调用 · ' + calls.length + '</strong><small>' + escapeHtml(calls.map(function (call) { return nodeName(call.to); }).join("、")) + '</small><span class="field-label">功能（中文）</span><p class="function-copy">集中展示没有归入编号步骤的共用工具或子流程。</p><span class="field-label">当前流程作用</span><p class="purpose-copy">它们由入口统一触发，供多个执行环节复用；展开后可核对源码证据。</p></button></div>';
        }
        var cards = calls.map(function (call, index) {
          var callId = key + ":call:" + index;
          edges.push(edgeSpec(startId, callId, "全程共用", "call", call.confidence));
          return renderCallNode(call, callId);
        }).join("");
        return '<div class="call-stack" style="grid-column:3;grid-row:1"><button class="small-button" data-action="toggle-calls" data-step="' + escapeHtml(key) + '">收起跨步骤调用</button>' + cards + '</div>';
      }

      function renderExecutionChart(skill) {
        var steps = skill.steps;
        if (!steps.length) return '<div class="empty">没有提取到执行步骤。</div>';
        var stepRows = new Map();
        var row = 3;
        steps.forEach(function (step) {
          stepRows.set(step.id, row);
          var decisions = step.routes.filter(function (route) { return route.kind !== "recovery" && route.conditional; }).length;
          row += 2 + decisions * 2;
        });
        var endRow = row + 1;
        var endId = skill.id + ":success";
        var html = ['<svg class="flow-svg" aria-hidden="true"></svg>'];
        var edges = [];
        var startId = skill.id + ":start";
        html.push('<article class="flow-node start" style="grid-column:2;grid-row:1" data-flow-node-id="' + escapeHtml(startId) + '"><strong>开始 /' + escapeHtml(skill.name) + '</strong></article>');
        html.push(renderUnscopedCallLane(skill, startId, edges));
        edges.push(edgeSpec(startId, steps[0].id, "", "main", "explicit"));

        steps.forEach(function (step, stepIndex) {
          var stepRow = stepRows.get(step.id);
          html.push(renderStepNode(skill, step, stepIndex, stepRow));
          html.push(renderCallLane(skill, step, stepRow, edges));

          var recoveryRoutes = step.routes.filter(function (route) { return route.kind === "recovery"; });
          if (recoveryRoutes.length) {
            var recoveryCards = recoveryRoutes.map(function (route, index) {
              var recoveryId = step.id + ":recovery:" + index;
              var targetId = route.targetStepId || step.id;
              edges.push(edgeSpec(recoveryId, targetId, "恢复", "recovery", "explicit"));
              return '<article class="flow-node user-node" data-flow-node-id="' + escapeHtml(recoveryId) + '"><h4>恢复入口</h4><span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(routeFunctionText(route)) + '</p><span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(routePurposeText(route)) + '</p><span class="field-label">源码写出的去向</span><p class="source-copy">' + escapeHtml(route.destination) + '</p>' + renderRouteEvidence(route) + '</article>';
            }).join("");
            html.push('<div class="call-stack" style="grid-column:1;grid-row:' + stepRow + '">' + recoveryCards + '</div>');
          }

          var conditionalRoutes = step.routes.filter(function (route) { return route.kind !== "recovery" && route.conditional; });
          var tailId = step.id;
          conditionalRoutes.forEach(function (route, routeIndex) {
            var decisionId = step.id + ":decision:" + routeIndex;
            var decisionRow = stepRow + 2 + routeIndex * 2;
            edges.push(edgeSpec(tailId, decisionId, routeIndex === 0 ? "" : "否 / 继续", "main", "explicit"));
            html.push('<div class="decision-block" style="grid-column:2;grid-row:' + decisionRow + '" data-flow-node-id="' + escapeHtml(decisionId) + '"><div class="decision-diamond"><div><strong>' + escapeHtml(compactCondition(route)) + '</strong><small>' + route.occurrences.length + ' 个源码触发点</small></div></div>' + renderRouteEvidence(route) + '</div>');

            if (route.targetStepId) {
              var routeKind = route.kind === "retry" ? "retry" : (route.kind === "failure" ? "failure" : "main");
              edges.push(edgeSpec(decisionId, route.targetStepId, route.kind === "retry" ? "重试" : "是 → " + route.destination, routeKind, "explicit"));
            } else {
              var terminalId = decisionId + ":destination";
              html.push('<div style="grid-column:1;grid-row:' + decisionRow + '">' + routeTerminal(route, terminalId) + '</div>');
              edges.push(edgeSpec(decisionId, terminalId, "是", route.kind, "explicit"));
            }
            tailId = decisionId;
          });

          var unconditional = step.routes.filter(function (route) { return route.kind !== "recovery" && !route.conditional; });
          var routed = false;
          unconditional.forEach(function (route, routeIndex) {
            if (route.targetStepId) {
              edges.push(edgeSpec(tailId, route.targetStepId, route.condition || route.destination, "main", "explicit"));
              routed = true;
            } else {
              var unresolvedId = step.id + ":jump:" + routeIndex;
              html.push('<div style="grid-column:1;grid-row:' + stepRow + '">' + routeTerminal(route, unresolvedId) + '</div>');
              edges.push(edgeSpec(tailId, unresolvedId, route.condition, "inferred", "inferred"));
              routed = true;
            }
          });
          if (!routed) {
            var nextId = steps[stepIndex + 1] ? steps[stepIndex + 1].id : endId;
            edges.push(edgeSpec(tailId, nextId, conditionalRoutes.length ? "否 / 继续" : "", "main", "explicit"));
          }
        });

        html.push('<article class="flow-node end" style="grid-column:2;grid-row:' + endRow + '" data-flow-node-id="' + escapeHtml(endId) + '"><strong>正常结束</strong></article>');
        html.push(edges.join(""));
        return '<div class="chart-scroll"><div class="execution-chart">' + html.join("") + '</div></div>';
      }

      function renderSkillFlow(skill) {
        var branchCount = skill.steps.reduce(function (sum, step) { return sum + step.routes.length; }, 0);
        document.getElementById("main").innerHTML =
          '<div class="section-head"><div><h2>/' + escapeHtml(skill.name) + ' 的程序执行图</h2><span class="field-label">入口功能（中文）</span><p class="function-copy">' + escapeHtml(functionTextForSkill(skill)) + '</p><span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(entryPurposeText(skill)) + '</p>' + sourceDescriptionDetails(skill) +
          (skill.argumentHint ? '<span class="field-label">调用参数</span><p><code>' + escapeHtml(skill.argumentHint) + '</code></p>' : "") +
          '<div class="legend">' + badge(classLabel(skill.classification), skill.classification === "entry" ? "entry" : "") + badge(roleLabel(skill.authority), skill.authority) + badge(skill.steps.length + " 个执行节点", "") + badge(branchCount + " 条分支/恢复路径", "judgment") + badge(skill.outbound + " 个外部调用", "mixed") + '</div></div><button class="ghost-button" data-action="back-overview">全部执行入口</button></div>' +
          '<div class="legend"><span class="legend-shape start"></span> 开始/结束 <span class="legend-shape"></span> 执行 <span class="legend-shape decision"></span> 判断 <span class="legend-shape subprocess"></span> 子任务/脚本；箭头回到上方表示循环或重试</div>' +
          renderExecutionChart(skill) +
          '<div class="coverage" style="margin-top:16px"><strong>图的证据边界：</strong>主顺序来自编号 Phase/Stage/Step；条件和跳转来自 if、retry、resume、proceed/loop to、失败与用户询问文字。去向无法落到某个编号步骤时会画成“去向未定位”，不会擅自补线。代码文件内部的逐语句分支不在这张跨 skill 图中展开。</div>';
        requestAnimationFrame(drawFlowEdges);
      }

      function renderDetailedUses(entries) {
        if (!entries.length) return '<div class="empty">源码未明确写出。</div>';
        return entries.map(function (entry) {
          return '<div class="detailed-use"><div><strong>' + escapeHtml(entry.artifact.displayName) + '</strong><small>' + escapeHtml(entry.use.rawPath) + '</small></div>' + sourceButton(entry.use.source, "来源") + '</div>';
        }).join("");
      }

      function renderCodeIo(node, entries, direction) {
        var artifacts = entries.length ? renderDetailedUses(entries) : "";
        var parameters = (node.parameters || []).filter(function (parameter) { return parameterIoKind(parameter) === direction; }).map(function (parameter) {
          return '<div class="detailed-use"><div><strong>参数 <code>' + escapeHtml(parameter.syntax) + '</code></strong><small>' + escapeHtml(parameterDescriptionText(parameter)) + '</small></div>' + sourceButton(parameter.source, "声明") + '</div>';
        }).join("");
        return artifacts + parameters || '<div class="empty">源码未明确写出。</div>';
      }

      function renderCodeNode(node) {
        var calls = audit.calls.filter(function (call) { return call.from === node.id; });
        var inputs = usesForOwner(node.id, "input");
        var outputs = usesForOwner(node.id, "output");
        var descriptionEvidence = node.descriptionSource ? sourceButton(node.descriptionSource, "功能说明来源") : "";
        var parameters = (node.parameters || []).map(function (parameter) {
          var ioKind = parameterIoKind(parameter);
          var ioLabel = ioKind === "input" ? "输入" : (ioKind === "output" ? "输出" : "配置");
          return '<tr><td><code>' + escapeHtml(parameter.syntax) + '</code></td><td>' + (parameter.required ? "必填" : "可选") + '</td><td>' + ioLabel + '</td><td>' + escapeHtml(parameterDescriptionText(parameter)) + '</td><td>' + sourceButton(parameter.source, "源码") + '</td></tr>';
        }).join("");
        if (!parameters) parameters = '<tr><td colspan="5">没有发现命令行参数声明。</td></tr>';
        var callHtml = calls.length ? '<div class="call-stack">' + calls.map(function (call, index) { return renderCallNode(call, node.id + ":detail-call:" + index); }).join("") + '</div>' : '<div class="empty">没有发现它调用其他已扫描文件。</div>';
        document.getElementById("main").innerHTML =
          '<div class="section-head"><div><h2>' + escapeHtml(node.name) + '</h2><p><code>' + escapeHtml(node.file) + '</code></p><span class="field-label">功能（中文）</span><p class="function-copy">' + escapeHtml(functionTextForCode(node)) + '</p><span class="field-label">当前流程作用</span><p class="purpose-copy">' + escapeHtml(codePurposeText(node)) + '</p>' + sourceDescriptionDetails(node) + '<div class="legend">' + badge(node.kind === "tool" ? "工具" : "skill 脚本", "tool") + badge("负责执行", "execution") + badge(node.descriptionConfidence === "explicit" ? "功能由源码明确说明" : "功能由代码结构推断", node.descriptionConfidence === "explicit" ? "entry" : "inferred") + descriptionEvidence + '</div></div><button class="ghost-button" data-action="back-overview">全部执行入口</button></div>' +
          '<div class="interface-grid"><section class="panel"><h3>入参</h3><table class="parameter-table"><thead><tr><th>写法</th><th>要求</th><th>类别</th><th>作用</th><th>位置</th></tr></thead><tbody>' + parameters + '</tbody></table></section>' +
          '<section class="panel"><h3>输入与输出</h3><div class="io-grid"><div><span class="field-label">读取</span>' + renderCodeIo(node, inputs, "input") + '</div><div><span class="field-label">写出</span>' + renderCodeIo(node, outputs, "output") + '</div></div></section></div>' +
          '<section class="panel" style="margin-top:16px"><h3>它继续调用谁</h3>' + callHtml + '</section>';
      }

      function renderArtifactUse(entry) {
        var owner = nodes.get(entry.owner);
        return '<div class="use"><div class="use-copy"><span>' + escapeHtml(owner ? owner.name : entry.owner) + '</span><small class="use-path" title="' + escapeHtml(entry.rawPath) + '">' + escapeHtml(entry.rawPath) + '</small></div>' + sourceButton(entry.source, entry.source.file + ":" + entry.source.line) + '</div>';
      }

      function renderArtifacts() {
        var artifacts = audit.artifacts.filter(function (artifact) {
          var values = [artifact.displayName, artifact.key];
          artifact.producers.concat(artifact.consumers).forEach(function (use) { values.push(nodeName(use.owner), use.rawPath); });
          return matchesSearch(values);
        });
        var cards = artifacts.map(function (artifact) {
          var producers = artifact.producers.map(renderArtifactUse).join("") || '<div class="use"><span>未找到明确产出方</span></div>';
          var consumers = artifact.consumers.map(renderArtifactUse).join("") || '<div class="use"><span>未找到后续读取方</span></div>';
          return '<article class="artifact-card"><div class="artifact-name"><h3>' + escapeHtml(artifact.displayName) + '</h3><small>' + artifact.unknownUses.length + ' 处方向待确认</small></div><div class="use-column"><h4>由谁产生</h4>' + producers + '</div><div class="arrow">→</div><div class="use-column"><h4>交给谁</h4>' + consumers + '</div></article>';
        }).join("");
        document.getElementById("main").innerHTML = '<div class="section-head"><div><h2>输入与输出文件流</h2><p>同名文件按文件名汇总。每个来源都能跳回文件和行号。</p></div></div><div class="artifact-list">' + (cards || '<div class="empty">没有匹配的文件关系。</div>') + '</div>';
      }

      function renderWarnings() {
        var warnings = audit.warnings.filter(function (warning) { return matchesSearch([warning.kind, warning.summary, warning.source ? warning.source.file : ""]); });
        function cards(entries) {
          return entries.map(function (warning) {
            return '<article class="warning ' + (warning.severity === "info" ? "info" : "") + '">' + badge(warning.severity === "review" ? "需要人工确认" : "提示", warning.severity === "review" ? "judgment" : "entry") + '<p>' + escapeHtml(warning.summary) + '</p><div class="card-footer">' + (warning.source ? sourceButton(warning.source, warning.source.file + ":" + warning.source.line) : "") + '</div></article>';
          }).join("");
        }
        var reviews = warnings.filter(function (warning) { return warning.severity === "review"; });
        var info = warnings.filter(function (warning) { return warning.severity === "info"; });
        document.getElementById("main").innerHTML = '<div class="section-head"><div><h2>待确认</h2><p>这里只放无法从源码可靠确定的关系，不把推测混进明确执行线。</p></div></div><h3>需要人工确认 · ' + reviews.length + '</h3><div class="warning-list">' + (cards(reviews) || '<div class="empty">当前筛选下没有必须确认的项目。</div>') + '</div><h3 style="margin-top:28px">可能是最终交付物 · ' + info.length + '</h3><div class="warning-list">' + (cards(info) || '<div class="empty">当前筛选下没有提示。</div>') + '</div><div class="coverage" style="margin-top:25px">扫描 SKILL.md：' + audit.coverage.skillFiles + '；skill 脚本：' + audit.coverage.scriptFiles + '；工具：' + audit.coverage.toolFiles + '。排除：' + escapeHtml(audit.coverage.excludedDirectories.join(", ")) + '。</div>';
      }

      function renderMain() {
        document.querySelectorAll(".tab").forEach(function (tab) { tab.classList.toggle("active", tab.getAttribute("data-tab") === state.tab); });
        if (state.tab === "artifacts") { renderArtifacts(); return; }
        if (state.tab === "warnings") { renderWarnings(); return; }
        if (!state.selected) { renderOverview(); return; }
        var node = nodes.get(state.selected);
        if (!node) { state.selected = null; renderOverview(); return; }
        if (node.kind === "skill") renderSkillFlow(node); else renderCodeNode(node);
      }

      function drawFlowEdges() {
        var chart = document.querySelector(".execution-chart");
        if (!chart) return;
        var svg = chart.querySelector(".flow-svg");
        if (!svg) return;
        var chartRect = chart.getBoundingClientRect();
        var width = Math.max(chart.scrollWidth, chartRect.width);
        var height = Math.max(chart.scrollHeight, chartRect.height);
        svg.setAttribute("viewBox", "0 0 " + width + " " + height);
        svg.setAttribute("width", width);
        svg.setAttribute("height", height);
        svg.innerHTML = '<defs>' +
          '<marker id="arrow-main" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#6f91b5"/></marker>' +
          '<marker id="arrow-call" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#b8a1ff"/></marker>' +
          '<marker id="arrow-failure" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#fb7185"/></marker>' +
          '<marker id="arrow-retry" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#f4c66a"/></marker>' +
          '<marker id="arrow-pause" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#58d7c5"/></marker>' +
          '</defs>';
        var nodeElements = Array.from(chart.querySelectorAll("[data-flow-node-id]"));
        function findNode(id) { return nodeElements.find(function (element) { return element.getAttribute("data-flow-node-id") === id; }); }
        function blocksVerticalPath(x, fromY, toY, fromElement, toElement) {
          var top = Math.min(fromY, toY) + 8;
          var bottom = Math.max(fromY, toY) - 8;
          return nodeElements.some(function (element) {
            if (element === fromElement || element === toElement) return false;
            var rect = element.getBoundingClientRect();
            var crossesY = rect.bottom > top && rect.top < bottom;
            var crossesX = x > rect.left - 8 && x < rect.right + 8;
            return crossesY && crossesX;
          });
        }
        function point(rect, side) {
          if (side === "top") return { x: rect.left + rect.width / 2 - chartRect.left, y: rect.top - chartRect.top };
          if (side === "bottom") return { x: rect.left + rect.width / 2 - chartRect.left, y: rect.bottom - chartRect.top };
          if (side === "left") return { x: rect.left - chartRect.left, y: rect.top + rect.height / 2 - chartRect.top };
          return { x: rect.right - chartRect.left, y: rect.top + rect.height / 2 - chartRect.top };
        }
        Array.from(chart.querySelectorAll(".flow-edge-spec")).forEach(function (spec, index) {
          var fromElement = findNode(spec.getAttribute("data-from"));
          var toElement = findNode(spec.getAttribute("data-to"));
          if (!fromElement || !toElement) return;
          var fromRect = fromElement.getBoundingClientRect();
          var toRect = toElement.getBoundingClientRect();
          var fromCenterX = fromRect.left + fromRect.width / 2;
          var toCenterX = toRect.left + toRect.width / 2;
          var fromCenterY = fromRect.top + fromRect.height / 2;
          var toCenterY = toRect.top + toRect.height / 2;
          var start;
          var end;
          var d;
          var labelX;
          var labelY;
          if (toCenterX > fromCenterX + 170) {
            start = point(fromRect, "right");
            end = point(toRect, "left");
            var rightMid = (start.x + end.x) / 2;
            d = "M " + start.x + " " + start.y + " H " + rightMid + " V " + end.y + " H " + end.x;
            labelX = rightMid;
            labelY = Math.min(start.y, end.y) - 7;
          } else if (toCenterX < fromCenterX - 170) {
            start = point(fromRect, "left");
            end = point(toRect, "right");
            var leftMid = (start.x + end.x) / 2;
            d = "M " + start.x + " " + start.y + " H " + leftMid + " V " + end.y + " H " + end.x;
            labelX = leftMid;
            labelY = Math.min(start.y, end.y) - 7;
          } else if (toCenterY < fromCenterY - 20) {
            start = point(fromRect, "left");
            end = point(toRect, "left");
            var gutter = Math.max(13, Math.min(start.x, end.x) - 34 - (index % 5) * 10);
            d = "M " + start.x + " " + start.y + " H " + gutter + " V " + end.y + " H " + end.x;
            labelX = gutter + 8;
            labelY = (start.y + end.y) / 2;
          } else if (blocksVerticalPath(fromCenterX, fromRect.bottom, toRect.top, fromElement, toElement)) {
            start = point(fromRect, "left");
            end = point(toRect, "left");
            var forwardGutter = Math.max(13, Math.min(start.x, end.x) - 34 - (index % 5) * 10);
            d = "M " + start.x + " " + start.y + " H " + forwardGutter + " V " + end.y + " H " + end.x;
            labelX = forwardGutter + 8;
            labelY = (start.y + end.y) / 2;
          } else {
            start = point(fromRect, "bottom");
            end = point(toRect, "top");
            var verticalMid = (start.y + end.y) / 2;
            d = "M " + start.x + " " + start.y + " V " + verticalMid + " H " + end.x + " V " + end.y;
            labelX = (start.x + end.x) / 2;
            labelY = verticalMid - 6;
          }
          var kind = spec.getAttribute("data-kind") || "main";
          var markerKind = kind === "recovery" ? "pause" : (kind === "inferred" ? "main" : kind);
          if (["main", "call", "failure", "retry", "pause"].indexOf(markerKind) === -1) markerKind = "main";
          var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", d);
          path.setAttribute("class", "flow-edge " + kind + (spec.getAttribute("data-confidence") === "inferred" ? " inferred" : ""));
          path.setAttribute("marker-end", "url(#arrow-" + markerKind + ")");
          svg.appendChild(path);
          var label = spec.getAttribute("data-label");
          if (label) {
            var text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", String(labelX));
            text.setAttribute("y", String(labelY));
            text.setAttribute("class", "edge-label");
            text.textContent = label.length > 42 ? label.slice(0, 39) + "…" : label;
            svg.appendChild(text);
          }
        });
      }

      function render() { renderStats(); renderSidebar(); renderMain(); }

      function openSource(file, line) {
        var source = sourceIndex.get(file + ":" + line);
        var drawer = document.getElementById("source-drawer");
        document.getElementById("source-title").textContent = file;
        document.getElementById("source-subtitle").textContent = "第 " + line + " 行";
        document.getElementById("copy-path").textContent = "可复制位置：" + file + ":" + line;
        if (!source) {
          document.getElementById("source-code").innerHTML = '<div class="code-line highlight"><span class="line-no">' + line + '</span><span class="line-text">该位置没有嵌入上下文，请直接打开上面的文件与行号。</span></div>';
        } else {
          document.getElementById("source-code").innerHTML = source.context.map(function (entry) {
            return '<div class="code-line ' + (entry.line === line ? "highlight" : "") + '"><span class="line-no">' + entry.line + '</span><span class="line-text">' + escapeHtml(entry.text || " ") + '</span></div>';
          }).join("");
        }
        drawer.classList.add("open");
        drawer.setAttribute("aria-hidden", "false");
        history.replaceState(null, "", "#source=" + encodeURIComponent(file) + ":" + line);
      }
      window.openSource = openSource;

      function closeSource() {
        var drawer = document.getElementById("source-drawer");
        drawer.classList.remove("open");
        drawer.setAttribute("aria-hidden", "true");
        history.replaceState(null, "", location.pathname + location.search);
      }

      document.addEventListener("click", function (event) {
        var target = event.target.closest("[data-action]");
        if (!target) return;
        var action = target.getAttribute("data-action");
        if (action === "tab") { state.tab = target.getAttribute("data-tab"); state.selected = null; render(); return; }
        if (action === "select-node") { state.tab = "overview"; state.selected = target.getAttribute("data-node"); render(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
        if (action === "toggle-calls") {
          var step = target.getAttribute("data-step");
          if (state.openCalls.has(step)) state.openCalls.delete(step); else state.openCalls.add(step);
          renderMain();
          return;
        }
        if (action === "source") { event.stopPropagation(); openSource(target.getAttribute("data-file"), Number(target.getAttribute("data-line"))); return; }
        if (action === "close-source") { closeSource(); return; }
        if (action === "back-overview") { state.selected = null; render(); }
      });

      document.addEventListener("toggle", function () { requestAnimationFrame(drawFlowEdges); }, true);
      document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeSource(); });
      document.getElementById("search").addEventListener("input", function (event) { state.search = event.target.value.trim(); render(); });
      window.addEventListener("resize", function () { requestAnimationFrame(drawFlowEdges); });

      render();
      if (location.hash.startsWith("#source=")) {
        var raw = location.hash.slice("#source=".length);
        var split = raw.lastIndexOf(":");
        if (split > 0) openSource(decodeURIComponent(raw.slice(0, split)), Number(raw.slice(split + 1)));
      }
    })();
  </script>
</body>
</html>`;
}
