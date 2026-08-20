import fs from "node:fs";
import path from "node:path";
import type {
  ArtifactDirection,
  ArtifactFlow,
  ArtifactUse,
  AuditWarning,
  AuthorityEvidence,
  AuthorityRole,
  CallEdge,
  CallRelation,
  CodeNode,
  Confidence,
  ControlKind,
  ControlMarker,
  FlowAudit,
  FlowRoute,
  FlowStep,
  InvocationParameter,
  RouteOccurrence,
  RouteKind,
  SkillClassification,
  SkillNode,
  SourceReference,
} from "./model.js";

const EXCLUDED_DIRECTORIES = [
  ".aris",
  ".git",
  "__pycache__",
  "dist",
  "legacy-python",
  "node_modules",
];
const CODE_EXTENSIONS = new Set([".bash", ".cjs", ".js", ".mjs", ".py", ".sh", ".ts"]);
const ARTIFACT_EXTENSION =
  "(?:bib|csv|html|jpeg|jpg|json|jsonl|log|md|npy|npz|parquet|pdf|png|pt|pth|svg|tex|tsv|txt|yaml|yml)";
const ARTIFACT_PATTERN = new RegExp(
  `[\\$A-Za-z0-9_.{}<>*\\/-]+\\.${ARTIFACT_EXTENSION}(?:#[A-Za-z0-9_.-]+)?`,
  "gi",
);
const CALL_WORDS =
  /\b(?:call|calls|chain|chains|create_agent|dispatch|dispatches|execute|executes|initialPrompt|invoke|invokes|route|routes|run|runs|spawn|spawns|then|use|uses|via)\b|调用|派发|运行|执行|随后|通过/i;
const REVERSE_CALL_WORDS =
  /\b(?:called by|invoked by|used by|input from|output for|caller|orchestrator)\b|由.+调用|被.+调用/i;
const PROHIBITION_WORDS =
  /\b(?:do not|does not|don't|never|must not|prohibit|prohibited|forbid|forbidden|skip|without)\b|不要|不得|禁止|跳过|不调用/i;
const DECISION_WORDS =
  /\b(?:accept|approve|audit|choose|close|decide|gate|judge|merge|prioriti[sz]e|rank|refute|reject|review|select|verify|verdict)\b|判断|裁决|审计|验证|验收|选择|合并|关闭|优先级|拒绝/i;
const EXECUTION_WORDS =
  /\b(?:collect|compile|create|execute|fetch|generate|implement|load|produce|read|render|run|save|search|sync|write)\b|执行|运行|实现|读取|写入|生成|渲染|搜索|收集/i;
const COORDINATION_WORDS =
  /\b(?:chain|coordinate|dispatch|end-to-end|full pipeline|full workflow|orchestrat|phase scheduling|pipeline|workflow)\b|编排|全流程|调度/i;
const EXECUTION_HEADING_WORDS =
  /^(?:(?:phase|stage|step|round|gate)\b|\d+(?:\.\d+)*[.)：:]?\s)|\b(?:audit|checkpoint|compile|compose|configure|decide|discover|dispatch|execute|experiment|failure|final|gate|generate|implement|initialize|load|loop|monitor|plan|preflight|recover|render|resume|retry|review|run|search|setup|startup|stop|validate|verify|write)\b|阶段|步骤|轮次|检查点|审计|验证|恢复|失败|执行|规划|生成|初始化|启动|停止/i;
const GENERIC_PARENT_HEADING = /^(?:pipeline|workflow|process|流程|工作流)$/i;

interface Heading {
  level: number;
  line: number;
  title: string;
}

interface StepRange {
  start: number;
  end: number;
  step: FlowStep;
}

interface SkillSource {
  node: SkillNode;
  lines: string[];
  bodyStart: number;
  ranges: StepRange[];
  fullText: string;
}

interface CodeSource {
  node: CodeNode;
  lines: string[];
  fullText: string;
}

interface CodeLookup {
  byFile: Map<string, CodeNode>;
  byStem: Map<string, CodeNode[]>;
}

export class FlowAuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowAuditInputError";
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function relativeFile(root: string, filePath: string): string {
  return toPosix(path.relative(root, filePath));
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.includes(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(target));
      continue;
    }
    if (entry.isFile()) files.push(target);
  }
  return files.sort();
}

function discoverSkillFiles(root: string): string[] {
  return walkFiles(path.join(root, "skills")).filter(
    (filePath) => path.basename(filePath) === "SKILL.md",
  );
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function discoverCodeFiles(root: string): string[] {
  const candidates = [
    ...walkFiles(path.join(root, "src", "tools")),
    ...walkFiles(path.join(root, "tools")),
    ...walkFiles(path.join(root, "skills")).filter((filePath) =>
      toPosix(filePath).includes("/scripts/"),
    ),
  ];
  return [...new Set(candidates.filter(isCodeFile))].sort();
}

function stripQuoted(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function parseFrontmatter(
  lines: string[],
  fallbackName: string,
): {
  name: string;
  description: string;
  argumentHint: string | null;
  bodyStart: number;
} {
  if (lines[0]?.trim() !== "---") {
    return { name: fallbackName, description: "", argumentHint: null, bodyStart: 0 };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    return { name: fallbackName, description: "", argumentHint: null, bodyStart: 0 };
  }
  let name = fallbackName;
  let description = "";
  let argumentHint: string | null = null;
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = stripQuoted(line.slice(separator + 1));
    if (key === "name" && value !== "") name = value;
    if (key === "description") description = value;
    if (key === "argument-hint" && value !== "") argumentHint = value;
  }
  return { name, description, argumentHint, bodyStart: end + 1 };
}

function cleanHeading(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function headings(lines: string[], bodyStart: number): Heading[] {
  const found: Heading[] = [];
  let fenceMarker: "`" | "~" | null = null;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker: "`" | "~" = fence[1].startsWith("`") ? "`" : "~";
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      continue;
    }
    if (fenceMarker !== null) continue;
    const match = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    found.push({ level: match[1].length, line: index + 1, title: cleanHeading(match[2]) });
  }
  return found;
}

function isExecutionHeading(title: string): boolean {
  if (
    /^(?:overview|constants?|arguments?|critical rules?|external dependencies|manifest|receipt|schema)/i.test(
      title,
    )
  ) {
    return false;
  }
  if (
    /\b(?:authority boundary|design rationale|diagram|dispatch pattern|lifecycle|responsibility boundary)\b|^why\b/i.test(
      title,
    )
  ) {
    return false;
  }
  return EXECUTION_HEADING_WORDS.test(title);
}

function executionHeadings(lines: string[], bodyStart: number): Heading[] {
  const all = headings(lines, bodyStart);
  const numbered = all.filter((heading) =>
    /^(?:(?:phase|stage|step|round|gate)\s+(?:\d+(?:\.\d+)*[a-z]?|[a-z])\b|(?:阶段|步骤|轮次)\s*\d+(?:\.\d+)*)/i.test(
      heading.title,
    ),
  );
  if (numbered.length > 0) {
    const topLevel = Math.min(...numbered.map((heading) => heading.level));
    return numbered.filter((heading) => heading.level === topLevel);
  }
  const candidates = all.filter((heading) => isExecutionHeading(heading.title));
  return candidates.filter((candidate, index) => {
    if (!GENERIC_PARENT_HEADING.test(candidate.title)) return true;
    const next = candidates[index + 1];
    if (!next) return true;
    const nextPeer = all.find(
      (heading) => heading.line > candidate.line && heading.level <= candidate.level,
    );
    const parentEnd = nextPeer?.line ?? Number.POSITIVE_INFINITY;
    return !(next.level > candidate.level && next.line < parentEnd);
  });
}

function sourceReference(file: string, line: number, lines: string[]): SourceReference {
  const start = Math.max(1, line - 2);
  const end = Math.min(lines.length, line + 2);
  const context = [];
  for (let current = start; current <= end; current += 1) {
    context.push({ line: current, text: lines[current - 1] ?? "" });
  }
  return { file, line, context };
}

function firstSummary(lines: string[], start: number, end: number, fallback: string): string {
  let fenceMarker: "`" | "~" | null = null;
  for (let line = start; line <= end; line += 1) {
    const text = (lines[line - 1] ?? "").trim();
    const fence = /^(`{3,}|~{3,})/.exec(text);
    if (fence) {
      const marker: "`" | "~" = fence[1].startsWith("`") ? "`" : "~";
      if (fenceMarker === null) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      continue;
    }
    if (fenceMarker !== null) continue;
    if (
      text === "" ||
      text.startsWith("#") ||
      text.startsWith("|") ||
      text === "---" ||
      /^(?:[A-Z_][A-Z0-9_]*=|(?:bash|cd|cp|echo|export|jq|mkdir|mv|node|npm|python3?|rm)\b|if\s+\[|fi\b|done\b|\})/.test(
        text,
      )
    ) {
      continue;
    }
    const cleaned = text
      .replace(/^[-*>\d.)\s]+/, "")
      .replace(/`/g, "")
      .replace(/\*\*/g, "")
      .trim();
    if (cleaned.length >= 8) {
      const paragraph = [cleaned];
      for (let next = line + 1; next <= end && paragraph.join(" ").length < 300; next += 1) {
        const continuation = (lines[next - 1] ?? "").trim();
        if (
          continuation === "" ||
          continuation.startsWith("#") ||
          continuation.startsWith("|") ||
          /^(`{3,}|~{3,})/.test(continuation) ||
          /^(?:[A-Z_][A-Z0-9_]*=|(?:bash|cd|cp|echo|export|jq|mkdir|mv|node|npm|python3?|rm)\b|if\s+\[|fi\b|done\b|\})/.test(
            continuation,
          )
        ) {
          break;
        }
        paragraph.push(
          continuation
            .replace(/^[-*>\d.)\s]+/, "")
            .replace(/`/g, "")
            .replace(/\*\*/g, "")
            .trim(),
        );
      }
      return truncateText(paragraph.join(" ").replace(/\s+/g, " "), 300);
    }
  }
  const fallbackFunction = fallback
    .replace(
      /^(?:(?:phase|stage|step|round|gate)\s+(?:\d+(?:\.\d+)*[a-z]?|[a-z])|(?:阶段|步骤|轮次)\s*\d+(?:\.\d+)*)\s*[:：-]?\s*/i,
      "",
    )
    .trim();
  return fallbackFunction ? `执行：${fallbackFunction}。` : "执行该节点定义的操作。";
}

function controlSummary(kind: ControlKind, line: string): string {
  const labels: Record<ControlKind, string> = {
    loop: "存在循环条件",
    retry: "失败后可能重试",
    pause: "会暂停或询问用户",
  };
  return `${labels[kind]}：${line.trim().slice(0, 150)}`;
}

function controlsForRange(
  file: string,
  lines: string[],
  start: number,
  end: number,
): ControlMarker[] {
  const found = new Map<ControlKind, ControlMarker>();
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    const matches: Array<[ControlKind, boolean]> = [
      [
        "retry",
        /\b(?:retry|re-run|re-audit|try again|repair loop)\b|重试|重新运行|重新审计/i.test(line),
      ],
      [
        "loop",
        /\b(?:each round|for each|iterations?|loop|repeat|until|while)\b|循环|直到|每轮|迭代/i.test(
          line,
        ),
      ],
      [
        "pause",
        /\b(?:ask (?:the )?user|checkpoint|human intervention|user chooses|wait for (?:the )?user)\b|询问用户|等待用户|用户选择|人工介入|暂停/i.test(
          line,
        ),
      ],
    ];
    for (const [kind, matched] of matches) {
      if (!matched || found.has(kind)) continue;
      found.set(kind, {
        kind,
        summary: controlSummary(kind, line),
        source: sourceReference(file, lineNumber, lines),
      });
    }
  }
  return [...found.values()];
}

function route(
  kind: RouteKind,
  destination: string,
  condition: string,
  conditional: boolean,
  file: string,
  lineNumber: number,
  line: string,
  lines: string[],
): FlowRoute {
  const occurrence: RouteOccurrence = {
    condition,
    conditional,
    summary: line.trim().slice(0, 180),
    source: sourceReference(file, lineNumber, lines),
  };
  return {
    kind,
    destination,
    targetStepId: null,
    condition,
    conditional,
    summary: occurrence.summary,
    source: occurrence.source,
    occurrences: [occurrence],
  };
}

function cleanRouteText(value: string): string {
  return value
    .replace(/^\s*(?:[-*]>|\d+[.)])\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function directStepDestination(line: string): { destination: string; index: number } | null {
  const patterns = [
    /(?:→|->)\s*((?:phase|stage|step)\s+(?:\d+(?:\.\d+)*[a-z]?|[a-z]))\b/i,
    /\b(?:proceed|continue|go|jump|loop|resume|return)(?:\s+back)?\s+(?:to|at|from)\s+((?:phase|stage|step)\s+(?:\d+(?:\.\d+)*[a-z]?|[a-z]))\b/i,
    /(?:进入|继续到|跳转到|回到|循环到|恢复到)\s*((?:阶段|步骤)\s*\d+(?:\.\d+)*)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match?.[1]) return { destination: match[1].trim(), index: match.index };
  }
  return null;
}

function isConditionalRoute(line: string): boolean {
  return /\b(?:if|when|unless|otherwise|else)\b|如果|若|当|否则/i.test(line);
}

function routeCondition(line: string, destinationIndex: number, fallback: string | null): string {
  const prefix = cleanRouteText(line.slice(0, destinationIndex))
    .replace(/(?:→|->)\s*$/, "")
    .replace(
      /\b(?:proceed|continue|go|jump|loop|resume|return)(?:\s+back)?\s+(?:to|at|from)\s*$/i,
      "",
    )
    .trim();
  if (fallback && !isConditionalRoute(prefix)) return fallback.slice(0, 180);
  if (prefix.length >= 3) return prefix.slice(0, 180);
  if (fallback) return fallback.slice(0, 180);
  return "完成当前操作";
}

function routesForRange(file: string, lines: string[], start: number, end: number): FlowRoute[] {
  const found: FlowRoute[] = [];
  let pendingCondition: { text: string; line: number } | null = null;
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    const cleanedLine = cleanRouteText(line);
    if (/^(?:if|when|unless|otherwise|else)\b|^(?:如果|若|当|否则)/i.test(cleanedLine)) {
      pendingCondition = { text: cleanedLine, line: lineNumber };
    }
    if (pendingCondition && lineNumber - pendingCondition.line > 12) pendingCondition = null;

    const hasRetry =
      /\b(?:retry|re-run|re-audit|try again|repair loop)\b|重试|重新运行|重新审计/i.test(line);
    const hasUserPause =
      /\b(?:ask (?:the )?user|human intervention|user chooses|wait for (?:the )?user)\b|询问用户|等待用户|用户选择|人工介入/i.test(
        line,
      );
    const hasFailure =
      /\b(?:abort|blocked|exit\s+1|failed receipt|hard-fails?|on [^.!]{0,40}fail(?:ed|ure)?|status[^.!]{0,30}failed|when [^.!]{0,40}fails?)\b|\bERROR:|发生错误|若.+失败|如果.+失败|失败时|阻塞后|中止/i.test(
        line,
      );
    const hasResume =
      /\b(?:on resume|resume (?:at|from|path|with)|when resuming|if [^.!]{0,40}ARG_RESUME|return to (?:phase|stage|step)|re-attach|recreate dead)\b|恢复时|续跑时|回到阶段|重新连接|重建已结束/i.test(
        line,
      );

    const directDestination = directStepDestination(line);
    if (directDestination) {
      const conditional = isConditionalRoute(line) || pendingCondition !== null;
      const condition = routeCondition(
        line,
        directDestination.index,
        conditional ? (pendingCondition?.text ?? null) : null,
      );
      const isRecovery = /\bresume\b|恢复/i.test(line);
      found.push(
        route(
          isRecovery ? "recovery" : "branch",
          directDestination.destination,
          condition,
          conditional,
          file,
          lineNumber,
          line,
          lines,
        ),
      );
    }

    if (hasRetry && !directDestination) {
      found.push(route("retry", "本步骤", cleanedLine, true, file, lineNumber, line, lines));
    }
    if (hasUserPause) {
      found.push(route("pause", "等待用户", cleanedLine, true, file, lineNumber, line, lines));
    }
    if (hasFailure && !hasUserPause && !hasRetry && !directDestination) {
      let destination = "停止并报告失败";
      if (
        /\b(?:fallback|continue|proceed)\b|后备|继续/i.test(line) &&
        !/\b(?:cannot|can't|do not|must not|never|refus(?:e|ing) to)\s+continue\b|不能继续|不得继续/i.test(
          line,
        )
      )
        destination = "后备路径或下一步";
      if (/\b(?:failed receipt|write.*failed)\b|失败收据/i.test(line))
        destination = "写入失败记录后停止";
      found.push(route("failure", destination, cleanedLine, true, file, lineNumber, line, lines));
    }
    if (hasResume && !directDestination) {
      const destinationMatch =
        /(?:return|resume|jump|恢复|回到).*?((?:phase|stage|step)\s+[\w.-]+|阶段\s*[\w.-]+|步骤\s*[\w.-]+)/i.exec(
          line,
        );
      const namedDestination = destinationMatch?.[1].replace(/[.,;:，。；：]+$/, "");
      let destination = "按已保存状态继续";
      if (/re-attach|重新连接/i.test(line)) destination = "重新连接仍在运行的子任务";
      if (/recreate dead|重建已结束/i.test(line)) destination = "重建已结束的子任务";
      if (namedDestination) destination = `恢复到 ${namedDestination}`;
      found.push(route("recovery", destination, cleanedLine, true, file, lineNumber, line, lines));
    }
  }
  const unique = new Map<string, FlowRoute>();
  for (const item of found) {
    const key = `${item.kind}:${item.destination.toLowerCase()}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, item);
      continue;
    }
    for (const occurrence of item.occurrences) {
      if (
        !existing.occurrences.some(
          (candidate) =>
            candidate.source.line === occurrence.source.line &&
            candidate.summary === occurrence.summary,
        )
      ) {
        existing.occurrences.push(occurrence);
      }
    }
    existing.conditional ||= item.conditional;
  }
  return [...unique.values()];
}

function inferAuthority(text: string, title = ""): AuthorityRole {
  const combined = `${title}\n${text}`;
  const explicitOwner =
    /\b(?:owns|sole authority|responsible for (?:the )?(?:decision|ruling|verdict))\b|负责裁决|唯一.*入口|拥有.*裁决/i.test(
      combined,
    );
  const thinCoordinator =
    /\b(?:thin (?:orchestrator|scheduler)|scheduling only|does not do .* work itself|never judges? .* verdicts?|no judgment of its own)\b|只负责编排|只负责调度|不自行判断/i.test(
      combined,
    );
  const hasDecision = DECISION_WORDS.test(combined);
  const hasExecution = EXECUTION_WORDS.test(combined);
  const hasCoordination = COORDINATION_WORDS.test(combined);
  if (thinCoordinator) return "coordination";
  if (explicitOwner) return "judgment";
  if (hasDecision && hasExecution) return "mixed";
  if (hasDecision) return "judgment";
  if (hasCoordination) return "coordination";
  if (hasExecution) return "execution";
  return "unclear";
}

function authorityEvidenceForRange(
  role: AuthorityRole,
  file: string,
  lines: string[],
  start: number,
  end: number,
): AuthorityEvidence[] {
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? "";
    const matchesRole =
      (role === "judgment" && DECISION_WORDS.test(line)) ||
      (role === "execution" && EXECUTION_WORDS.test(line)) ||
      (role === "coordination" && COORDINATION_WORDS.test(line)) ||
      (role === "mixed" && (DECISION_WORDS.test(line) || EXECUTION_WORDS.test(line)));
    if (!matchesRole) continue;
    return [
      {
        role,
        summary: line.trim().slice(0, 180),
        source: sourceReference(file, lineNumber, lines),
      },
    ];
  }
  return [];
}

function buildSteps(
  file: string,
  lines: string[],
  bodyStart: number,
  skillId: string,
): StepRange[] {
  const allHeadings = headings(lines, bodyStart);
  const selected = executionHeadings(lines, bodyStart);
  const effective =
    selected.length > 0
      ? selected
      : [
          {
            level: 2,
            line: Math.min(lines.length, bodyStart + 1),
            title: "整体任务",
          },
        ];
  const ranges = effective.map((heading, index) => {
    const start = heading.line;
    const boundary = allHeadings.find(
      (candidate) => candidate.line > heading.line && candidate.level <= heading.level,
    );
    const end = (boundary?.line ?? lines.length + 1) - 1;
    const sectionText = lines.slice(start - 1, end).join("\n");
    const authority = inferAuthority(sectionText, heading.title);
    const step: FlowStep = {
      id: `${skillId}:step:${heading.line}`,
      title: heading.title,
      order: index + 1,
      summary: firstSummary(lines, start + 1, end, heading.title),
      source: sourceReference(file, heading.line, lines),
      authority,
      authorityEvidence: authorityEvidenceForRange(authority, file, lines, start, end),
      controls: controlsForRange(file, lines, start, end),
      routes: routesForRange(file, lines, start, end),
    };
    return { start, end, step };
  });
  for (const range of ranges) {
    for (const item of range.step.routes) {
      if (item.destination === "本步骤") {
        item.targetStepId = range.step.id;
        continue;
      }
      const token =
        /(?:phase|stage|step)\s+((?:\d+(?:\.\d+)*[a-z]?)|[a-z])\b|(?:阶段|步骤)\s*(\d+(?:\.\d+)*)/i.exec(
          item.destination,
        );
      if (!token) continue;
      const value = (token[1] ?? token[2] ?? "").toLowerCase();
      const target = ranges.find((candidate) => {
        const candidateToken =
          /^(?:phase|stage|step)\s+((?:\d+(?:\.\d+)*[a-z]?)|[a-z])\b|^(?:阶段|步骤)\s*(\d+(?:\.\d+)*)/i.exec(
            candidate.step.title,
          );
        return (candidateToken?.[1] ?? candidateToken?.[2] ?? "").toLowerCase() === value;
      });
      item.targetStepId = target?.step.id ?? null;
    }
  }
  return ranges;
}

function stepAtLine(ranges: StepRange[], line: number): FlowStep | null {
  return ranges.find((range) => line >= range.start && line <= range.end)?.step ?? null;
}

function readSkill(root: string, filePath: string): SkillSource {
  const file = relativeFile(root, filePath);
  const fullText = fs.readFileSync(filePath, "utf8");
  const lines = fullText.split(/\r?\n/);
  const fallbackName = path.basename(path.dirname(filePath));
  const metadata = parseFrontmatter(lines, fallbackName);
  const id = `skill:${metadata.name}`;
  const ranges = buildSteps(file, lines, metadata.bodyStart, id);
  const authorityText = `${metadata.description}\n${lines.slice(metadata.bodyStart, metadata.bodyStart + 80).join("\n")}`;
  const node: SkillNode = {
    id,
    kind: "skill",
    name: metadata.name,
    description: metadata.description,
    argumentHint: metadata.argumentHint,
    file,
    classification: "standalone",
    authority: inferAuthority(authorityText, metadata.name),
    steps: ranges.map((range) => range.step),
    inbound: 0,
    outbound: 0,
  };
  return { node, lines, bodyStart: metadata.bodyStart, ranges, fullText };
}

function codeKind(file: string): "script" | "tool" {
  return file.startsWith("skills/") && file.includes("/scripts/") ? "script" : "tool";
}

function codeOwner(file: string): string | null {
  const match = /^skills\/([^/]+)\/scripts\//.exec(file);
  return match?.[1] ?? null;
}

function lineForOffset(fullText: string, offset: number): number {
  return fullText.slice(0, offset).split("\n").length;
}

function normalizeCodeDescription(value: string): string {
  return truncateText(
    value
      .replace(/^\s*(?:\/\*+|\*+\/|\*|\/\/|#)\s?/gm, "")
      .replace(/\s+/g, " ")
      .trim(),
    360,
  );
}

function codeDescription(
  file: string,
  fullText: string,
  lines: string[],
): { description: string; source: SourceReference } | null {
  const explicitPatterns = [
    /createCli\(\s*(["'`])[^"'`]+\1\s*,\s*(["'`])([\s\S]*?)\2\s*[,)]/m,
    /ArgumentParser\([\s\S]{0,500}?description\s*=\s*(["'])([\s\S]*?)\1/m,
    /\.description\(\s*(["'`])([\s\S]*?)\1\s*,?\s*\)/m,
  ];
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(fullText);
    if (!match) continue;
    const raw = match[3] ?? match[2] ?? "";
    const description = normalizeCodeDescription(raw);
    if (description.length < 4) continue;
    const line = lineForOffset(fullText, match.index);
    return { description, source: sourceReference(file, line, lines) };
  }

  const docstring = /^\s*(?:#![^\n]*\n)?\s*(?:[rubf]*)?("""|''')([\s\S]*?)\1/m.exec(fullText);
  if (docstring) {
    const beforeUsage = docstring[2].split(/\n\s*(?:Usage|Arguments?|Options?):/i)[0] ?? "";
    const description = normalizeCodeDescription(beforeUsage);
    if (description.length >= 4) {
      const line = lineForOffset(fullText, docstring.index);
      return { description, source: sourceReference(file, line, lines) };
    }
  }

  for (let index = 0; index < Math.min(lines.length, 50); index += 1) {
    if (!/^\s*(?:\/\/|#(?!\!)|\/\*)/.test(lines[index] ?? "")) continue;
    const block: string[] = [];
    let cursor = index;
    while (cursor < Math.min(lines.length, index + 24)) {
      const candidate = lines[cursor] ?? "";
      if (/^\s*(?:\/\/|#(?!\!)|\/\*|\*)/.test(candidate) || candidate.trim() === "") {
        block.push(candidate);
        cursor += 1;
        continue;
      }
      break;
    }
    const description = normalizeCodeDescription(block.join("\n").split(/\bUsage:/i)[0] ?? "");
    if (description.length >= 12 && !/^copyright\b/i.test(description)) {
      return {
        description,
        source: sourceReference(file, index + 1, lines),
      };
    }
  }
  return null;
}

function parameterName(syntax: string): string {
  const longOption = /--[a-z0-9][\w-]*/i.exec(syntax)?.[0];
  if (longOption) return longOption;
  const positional = /[<[]([^>\]]+)[>\]]/.exec(syntax)?.[1];
  if (positional) return positional;
  return syntax.trim().split(/[\s,|]+/)[0] ?? syntax;
}

function parameterValueHint(syntax: string): string | null {
  return /(?:<[^>]+>|\[[^\]]+\])/.exec(syntax)?.[0] ?? null;
}

function codeParameters(file: string, fullText: string, lines: string[]): InvocationParameter[] {
  const parameters: InvocationParameter[] = [];
  const commander =
    /\.(requiredOption|option|argument)\(\s*(["'`])([^"'`]*?)\2(?:\s*,\s*(["'`])([^"'`]*?)\4)?/gm;
  for (const match of fullText.matchAll(commander)) {
    const syntax = (match[3] ?? "").trim();
    if (!syntax) continue;
    const line = lineForOffset(fullText, match.index ?? 0);
    const kind = match[1];
    parameters.push({
      name: parameterName(syntax),
      syntax,
      valueHint: parameterValueHint(syntax),
      description: normalizeCodeDescription(match[5] ?? "") || "源码未单独说明。",
      required: kind === "requiredOption" || (kind === "argument" && syntax.includes("<")),
      source: sourceReference(file, line, lines),
    });
  }

  const pythonArgument = /\.add_argument\(([\s\S]{0,800}?)\)\s*(?:\n|$)/gm;
  for (const match of fullText.matchAll(pythonArgument)) {
    const body = match[1] ?? "";
    const literals = [...body.matchAll(/(["'])([^"']+)\1/g)].map((entry) => entry[2]);
    const syntaxParts = literals.filter(
      (entry, index) => index === 0 || (entry.startsWith("-") && literals[0]?.startsWith("-")),
    );
    const syntax = syntaxParts.join(", ");
    if (!syntax) continue;
    const help = /\bhelp\s*=\s*(["'])([\s\S]*?)\1/.exec(body)?.[2] ?? "";
    const line = lineForOffset(fullText, match.index ?? 0);
    parameters.push({
      name: parameterName(syntax),
      syntax,
      valueHint: parameterValueHint(syntax),
      description: normalizeCodeDescription(help) || "源码未单独说明。",
      required: !syntax.startsWith("-") || /\brequired\s*=\s*True\b/.test(body),
      source: sourceReference(file, line, lines),
    });
  }

  for (let index = 0; index < Math.min(lines.length, 180); index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s*#/.test(line) && !/\busage\b|\becho\b/i.test(line)) continue;
    for (const match of line.matchAll(/--[a-z0-9][\w-]*(?:[ =](?:<[^>]+>|[A-Z][A-Z0-9_-]*))?/gi)) {
      const syntax = match[0];
      parameters.push({
        name: parameterName(syntax),
        syntax,
        valueHint: parameterValueHint(syntax),
        description: "见脚本用法说明。",
        required: /<[^>]+>/.test(syntax),
        source: sourceReference(file, index + 1, lines),
      });
    }
  }

  const unique = new Map<string, InvocationParameter>();
  for (const parameter of parameters) {
    const key = parameter.name.toLowerCase();
    const existing = unique.get(key);
    if (!existing || existing.description === "源码未单独说明。") unique.set(key, parameter);
  }
  return [...unique.values()];
}

function humanizeCodeName(file: string): string {
  return path.basename(file, path.extname(file)).replace(/[-_]+/g, " ").trim();
}

function structuralCodeDescription(fullText: string): string | null {
  const forwardedTarget =
    /\btarget\s*=\s*path\.(?:resolve|join)\([\s\S]{0,240}?["']([^"']+\.(?:js|py|sh|ts))["']\s*\)/m.exec(
      fullText,
    )?.[1];
  if (forwardedTarget && /\bexec\s*\(/.test(fullText)) {
    return `将收到的命令行参数转发给 ${path.basename(forwardedTarget)} 执行。`;
  }

  const exportedClass = /export\s+class\s+([A-Za-z_$][\w$]*)/.exec(fullText)?.[1];
  if (exportedClass) {
    const methods = [
      ...fullText.matchAll(
        /^\s{2}(?!private\b|protected\b)(?:async\s+)?([a-z][\w]*)\s*\([^)]*\)\s*(?::[^\{]+)?\{/gm,
      ),
    ]
      .map((match) => match[1])
      .filter((name) => name !== "constructor")
      .slice(0, 8);
    if (methods.length > 0) {
      return `提供 ${exportedClass} 模块，包含 ${methods.join("、")} 等操作。`;
    }
    return `提供 ${exportedClass} 模块供其他工具调用。`;
  }

  const namedExports = /export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/.exec(fullText);
  if (namedExports) {
    const names = namedExports[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .slice(0, 8);
    return `统一导出 ${names.join("、")}，供其他模块调用。`;
  }
  const forwardedModule = /export\s+\*\s+from\s+["']([^"']+)["']/.exec(fullText)?.[1];
  if (forwardedModule) return `转发 ${forwardedModule} 提供的接口。`;
  return null;
}

function readCode(root: string, filePath: string): CodeSource {
  const file = relativeFile(root, filePath);
  const kind = codeKind(file);
  const fullText = fs.readFileSync(filePath, "utf8");
  const lines = fullText.split(/\r?\n/);
  const extractedDescription = codeDescription(file, fullText, lines);
  const structuralDescription = structuralCodeDescription(fullText);
  const node: CodeNode = {
    id: `${kind}:${file}`,
    kind,
    name: path.basename(file),
    file,
    description:
      extractedDescription?.description ??
      structuralDescription ??
      `执行 ${humanizeCodeName(file)} 辅助操作。`,
    descriptionConfidence: extractedDescription ? "explicit" : "inferred",
    descriptionSource: extractedDescription?.source ?? null,
    parameters: codeParameters(file, fullText, lines),
    ownerSkill: codeOwner(file),
    authority: "execution",
    inbound: 0,
    outbound: 0,
  };
  return { node, lines, fullText };
}

function codeLookup(code: CodeSource[]): CodeLookup {
  const byFile = new Map<string, CodeNode>();
  const byStem = new Map<string, CodeNode[]>();
  for (const source of code) {
    byFile.set(source.node.file, source.node);
    const stem = path.basename(source.node.file, path.extname(source.node.file));
    const aliases = new Set([stem, stem.replaceAll("_", "-"), stem.replaceAll("-", "_")]);
    for (const alias of aliases) {
      const existing = byStem.get(alias) ?? [];
      existing.push(source.node);
      byStem.set(alias, existing);
    }
  }
  return { byFile, byStem };
}

function normalizeReferencedCodePath(rawPath: string): string {
  let normalized = rawPath.replaceAll("\\", "/");
  normalized = normalized.replace(/^\.aris\//, "").replace(/^\.\//, "");
  normalized = normalized.replace(/^["']|["']$/g, "");
  if (normalized.startsWith("dist/tools/") && normalized.endsWith(".js")) {
    normalized = `src/tools/${normalized.slice("dist/tools/".length, -3)}.ts`;
  }
  return normalized;
}

function resolveCodeTarget(
  rawPath: string,
  originFile: string,
  lookup: CodeLookup,
): CodeNode | null {
  const normalized = normalizeReferencedCodePath(rawPath);
  const direct = lookup.byFile.get(normalized);
  if (direct) return direct;

  if (normalized.startsWith(".")) {
    const fromOrigin = toPosix(path.normalize(path.join(path.dirname(originFile), normalized)));
    const candidates = [
      fromOrigin,
      fromOrigin.replace(/\.js$/, ".ts"),
      `${fromOrigin}.ts`,
      `${fromOrigin}.py`,
    ];
    for (const candidate of candidates) {
      const found = lookup.byFile.get(candidate);
      if (found) return found;
    }
  }

  const filename = path.basename(normalized);
  const stem = filename.replace(/\.(?:bash|cjs|js|mjs|py|sh|ts)$/i, "");
  const matches = lookup.byStem.get(stem) ?? [];
  if (matches.length === 1) return matches[0] ?? null;
  const ownerMatch = /^skills\/([^/]+)\//.exec(originFile)?.[1];
  if (ownerMatch) {
    const owned = matches.find((node) => node.ownerSkill === ownerMatch);
    if (owned) return owned;
  }
  const topLevel = matches.find((node) => node.file.startsWith("src/tools/"));
  return topLevel ?? null;
}

function callSummary(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 190);
}

function classifySkillMention(
  line: string,
  name: string,
): {
  relation: CallRelation;
  confidence: Confidence;
} | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicitForm = new RegExp(`(?:[/\\$]${escaped}\\b|skills/${escaped}/SKILL\\.md)`, "i").test(
    line,
  );
  const trimmed = line.trim();
  if (/^(?:echo|printf)\b/i.test(trimmed)) return null;
  if (PROHIBITION_WORDS.test(line)) {
    return explicitForm ? { relation: "prohibited", confidence: "explicit" } : null;
  }
  if (REVERSE_CALL_WORDS.test(line)) return null;
  const directArrow = new RegExp(`(?:→|->|⇒)\\s*[/\\$]?${escaped}\\b`, "i").test(line);
  if (directArrow) {
    return { relation: "call", confidence: explicitForm ? "explicit" : "inferred" };
  }
  const renderedWorker = new RegExp(`--skill\\s+[^\\s]*skills/${escaped}/SKILL\\.md`, "i").test(
    line,
  );
  const initialPrompt = new RegExp(`initialPrompt\\s*:\\s*["']/${escaped}\\b`, "i").test(line);
  const directVerb = new RegExp(
    `(?:invoke|dispatch|call|run|spawn|via|调用|派发|运行|通过)[^\\n]{0,45}[/\\$]${escaped}\\b`,
    "i",
  ).test(line);
  if (renderedWorker || initialPrompt || directVerb) {
    return { relation: "call", confidence: "explicit" };
  }
  if (CALL_WORDS.test(line) && explicitForm) {
    return { relation: "reference", confidence: "inferred" };
  }
  return null;
}

function callEdge(
  from: string,
  to: string,
  stepId: string | null,
  relation: CallRelation,
  confidence: Confidence,
  source: SourceReference,
  summary: string,
): CallEdge {
  return {
    id: `call:${from}:${to}:${relation}:${stepId ?? "root"}:${source.line}`,
    from,
    to,
    stepId,
    relation,
    confidence,
    summary,
    source,
  };
}

function scanSkillCalls(skill: SkillSource, skillsByName: Map<string, SkillNode>): CallEdge[] {
  const found: CallEdge[] = [];
  for (let index = skill.bodyStart; index < skill.lines.length; index += 1) {
    const line = skill.lines[index] ?? "";
    for (const [name, target] of skillsByName) {
      if (target.id === skill.node.id || !line.toLowerCase().includes(name.toLowerCase())) continue;
      const classification = classifySkillMention(line, name);
      if (!classification) continue;
      const lineNumber = index + 1;
      found.push(
        callEdge(
          skill.node.id,
          target.id,
          stepAtLine(skill.ranges, lineNumber)?.id ?? null,
          classification.relation,
          classification.confidence,
          sourceReference(skill.node.file, lineNumber, skill.lines),
          callSummary(line),
        ),
      );
    }
  }
  return found;
}

function variableTargets(
  lines: string[],
  originFile: string,
  lookup: CodeLookup,
): Map<string, CodeNode> {
  const targets = new Map<string, CodeNode>();
  for (const line of lines) {
    const match = /\b([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+\.(?:bash|cjs|js|mjs|py|sh|ts))["']/.exec(
      line,
    );
    if (!match) continue;
    const target = resolveCodeTarget(match[2], originFile, lookup);
    if (target) targets.set(match[1], target);
  }
  return targets;
}

function scanToolInvocations(
  ownerId: string,
  file: string,
  lines: string[],
  ranges: StepRange[] | null,
  lookup: CodeLookup,
): CallEdge[] {
  const found: CallEdge[] = [];
  const variables = variableTargets(lines, file, lookup);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const stepId = ranges ? (stepAtLine(ranges, lineNumber)?.id ?? null) : null;
    const variableInvocation =
      /\b(?:bash|node|python|python3|tsx)\s+["']?\$\{?([A-Z][A-Z0-9_]*)\}?["']?/.exec(line);
    if (variableInvocation) {
      const target = variables.get(variableInvocation[1]);
      if (target && target.id !== ownerId) {
        found.push(
          callEdge(
            ownerId,
            target.id,
            stepId,
            "call",
            "explicit",
            sourceReference(file, lineNumber, lines),
            callSummary(line),
          ),
        );
      }
    }

    const directInvocation =
      /\b(?:bash|node|python|python3|tsx)\s+["']?([^"'\s]+\.(?:bash|cjs|js|mjs|py|sh|ts))["']?/.exec(
        line,
      );
    if (directInvocation) {
      const target = resolveCodeTarget(directInvocation[1], file, lookup);
      if (target && target.id !== ownerId) {
        found.push(
          callEdge(
            ownerId,
            target.id,
            stepId,
            "call",
            "explicit",
            sourceReference(file, lineNumber, lines),
            callSummary(line),
          ),
        );
      }
    }

    const importMatch = /(?:\bfrom\s+|\brequire\(|\bimport\s+[^"']*?from\s+)["']([^"']+)["']/.exec(
      line,
    );
    if (importMatch) {
      const target = resolveCodeTarget(importMatch[1], file, lookup);
      if (target && target.id !== ownerId) {
        found.push(
          callEdge(
            ownerId,
            target.id,
            stepId,
            "import",
            "explicit",
            sourceReference(file, lineNumber, lines),
            callSummary(line),
          ),
        );
      }
    }
  }
  return found;
}

function dedupeCalls(calls: CallEdge[]): CallEdge[] {
  const unique = new Map<string, CallEdge>();
  for (const call of calls) {
    const key = `${call.from}:${call.to}:${call.relation}:${call.stepId ?? "root"}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, call);
      continue;
    }
    const isBetterConfidence = existing.confidence === "inferred" && call.confidence === "explicit";
    const isEarlierSameConfidence =
      existing.confidence === call.confidence && call.source.line < existing.source.line;
    if (isBetterConfidence || isEarlierSameConfidence) unique.set(key, call);
  }
  return [...unique.values()].sort((left, right) => {
    const byFrom = left.from.localeCompare(right.from);
    if (byFrom !== 0) return byFrom;
    const byLine = left.source.line - right.source.line;
    if (byLine !== 0) return byLine;
    return left.to.localeCompare(right.to);
  });
}

function shouldIgnoreArtifact(rawPath: string, line: string): boolean {
  const normalized = rawPath.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1)?.split("#")[0] ?? "";
  if (basename === "skill.md" || basename === "readme.md") return true;
  const isReferenceMaterial =
    normalized.includes("shared-references/") ||
    normalized.startsWith("docs/") ||
    normalized.includes("/docs/");
  const isMarkdownLinkTarget = line.includes(`](${rawPath}`) || line.includes(`](../${rawPath}`);
  const lineNamesReferenceMaterial = /(?:docs|shared-references)\//i.test(line);
  return isReferenceMaterial || isMarkdownLinkTarget || lineNamesReferenceMaterial;
}

function artifactKey(rawPath: string): string | null {
  const withoutFragment = rawPath.split("#")[0] ?? rawPath;
  const basename = withoutFragment.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = basename
    .replace(/[{}<>*]/g, "")
    .replace(/^\$[A-Z_]+/, "")
    .trim();
  if (cleaned === "" || cleaned.startsWith(".")) return null;
  return cleaned.toLowerCase();
}

function artifactDisplayName(rawPath: string): string {
  const withoutFragment = rawPath.split("#")[0] ?? rawPath;
  const basename = withoutFragment.replaceAll("\\", "/").split("/").at(-1) ?? rawPath;
  return basename.replace(/^[`'*_<{]+/, "").replace(/[`'*>}]+$/, "");
}

function classifyArtifactDirection(
  line: string,
  matchIndex: number,
  surroundingText: string,
): { direction: ArtifactDirection; confidence: Confidence } {
  const prefix = line.slice(0, matchIndex).toLowerCase();
  const inputOption = Math.max(prefix.lastIndexOf("--input"), prefix.lastIndexOf("--source"));
  const outputOption = Math.max(prefix.lastIndexOf("--output"), prefix.lastIndexOf("--dest"));
  if (inputOption >= 0 || outputOption >= 0) {
    return inputOption > outputOption
      ? { direction: "input", confidence: "explicit" }
      : { direction: "output", confidence: "explicit" };
  }

  const beforePath = prefix.slice(Math.max(0, prefix.length - 90));
  const explicitInput =
    /(?:readfilesync|read_text|read_csv|json\.load|\binput\b|\bload\b|\bread\b|\brequire\b|\bconsume\b|读取|输入|加载|依赖)/i.test(
      beforePath,
    );
  const explicitOutput =
    /(?:writefilesync|write_text|to_csv|json\.dump|primary_output|\bcomposes?\b|\boutput\b|\bwrite\b|\bproduce\b|\bgenerate\b|\bcreate\b|\bsave\b|\bemit\b|写入|输出|生成|保存|产出|组合)/i.test(
      beforePath,
    );
  if (explicitInput && !explicitOutput) return { direction: "input", confidence: "explicit" };
  if (explicitOutput && !explicitInput) return { direction: "output", confidence: "explicit" };

  const contextInput =
    /\b(?:inputs?|read|requires?|consumes?|loads?|provided)\b|输入|读取|加载|依赖/i.test(
      surroundingText,
    );
  const contextOutput =
    /\b(?:outputs?|writes?|produces?|generates?|creates?|saves?|deliverables?)\b|输出|写入|生成|保存|产出/i.test(
      surroundingText,
    );
  if (contextInput && !contextOutput) return { direction: "input", confidence: "inferred" };
  if (contextOutput && !contextInput) return { direction: "output", confidence: "inferred" };
  return { direction: "unknown", confidence: "inferred" };
}

function artifactSemanticContext(lines: string[], index: number): string {
  const selected: string[] = [];
  const earliest = Math.max(0, index - 18);
  for (let cursor = index; cursor >= earliest; cursor -= 1) {
    const line = lines[cursor] ?? "";
    const isHeading = /^#{1,4}\s+/.test(line);
    const namesDirection =
      /(?:^|\|)\s*(?:deliverables?|inputs?|outputs?|produces?|consumes?)\s*(?:\||:|$)|["'](?:inputs?|outputs?)["']\s*:|\bcomposes?\b|\b(?:read|write) (?:these|the following) files\b|输入文件|输出文件|产出文件|组合成/i.test(
        line,
      );
    const isNearby = cursor >= index - 3;
    if (isNearby || isHeading || namesDirection) selected.push(line);
    if (isHeading || namesDirection) break;
  }
  const pathPattern = new RegExp(
    `[\\$A-Za-z0-9_.{}<>*\\/-]+\\.${ARTIFACT_EXTENSION}(?:#[A-Za-z0-9_.-]+)?`,
    "gi",
  );
  return selected.reverse().join("\n").replace(pathPattern, "");
}

function artifactUses(
  owner: string,
  file: string,
  lines: string[],
  ranges: StepRange[] | null,
  startLine: number,
): Array<{ key: string; displayName: string; use: ArtifactUse }> {
  const found: Array<{ key: string; displayName: string; use: ArtifactUse }> = [];
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    ARTIFACT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ARTIFACT_PATTERN.exec(line)) !== null) {
      const rawPath = match[0];
      if (shouldIgnoreArtifact(rawPath, line)) continue;
      const key = artifactKey(rawPath);
      if (!key) continue;
      const surroundingText = artifactSemanticContext(lines, index);
      const classification = classifyArtifactDirection(line, match.index, surroundingText);
      const lineNumber = index + 1;
      const use: ArtifactUse = {
        id: `artifact-use:${owner}:${key}:${classification.direction}:${lineNumber}`,
        owner,
        stepId: ranges ? (stepAtLine(ranges, lineNumber)?.id ?? null) : null,
        direction: classification.direction,
        rawPath,
        confidence: classification.confidence,
        source: sourceReference(file, lineNumber, lines),
      };
      found.push({ key, displayName: artifactDisplayName(rawPath), use });
    }
  }
  return found;
}

function buildArtifactFlows(
  skills: SkillSource[],
  code: CodeSource[],
  calls: CallEdge[],
): ArtifactFlow[] {
  const grouped = new Map<string, { names: string[]; uses: ArtifactUse[] }>();
  const allUses = [
    ...skills.flatMap((skill) =>
      artifactUses(skill.node.id, skill.node.file, skill.lines, skill.ranges, skill.bodyStart + 1),
    ),
    ...code.flatMap((source) =>
      artifactUses(source.node.id, source.node.file, source.lines, null, 1),
    ),
  ];
  for (const item of allUses) {
    const group = grouped.get(item.key) ?? { names: [], uses: [] };
    group.names.push(item.displayName);
    const duplicate = group.uses.some(
      (use) =>
        use.owner === item.use.owner &&
        use.direction === item.use.direction &&
        use.source.file === item.use.source.file &&
        use.source.line === item.use.source.line,
    );
    if (!duplicate) group.uses.push(item.use);
    grouped.set(item.key, group);
  }

  const flows: ArtifactFlow[] = [];
  for (const [key, group] of grouped) {
    const rankedNames = [...group.names].sort((left, right) => {
      const uppercaseLeft = left === left.toUpperCase() ? 0 : 1;
      const uppercaseRight = right === right.toUpperCase() ? 0 : 1;
      return uppercaseLeft - uppercaseRight || left.localeCompare(right);
    });
    flows.push({
      key,
      displayName: rankedNames[0] ?? key,
      producers: group.uses.filter((use) => use.direction === "output"),
      consumers: group.uses.filter((use) => use.direction === "input"),
      unknownUses: group.uses.filter((use) => use.direction === "unknown"),
    });
  }
  const explicitTargetsByStep = new Map<string, Set<string>>();
  const authorityByOwner = new Map(skills.map((skill) => [skill.node.id, skill.node.authority]));
  const infrastructureArtifacts = new Set([
    "dashboard.json",
    "input-manifest.json",
    "progress_error.md",
    "receipt.json",
  ]);
  for (const call of calls) {
    const isExplicitSkillCall =
      call.relation === "call" &&
      call.confidence === "explicit" &&
      call.stepId !== null &&
      call.to.startsWith("skill:");
    if (!isExplicitSkillCall || call.stepId === null) continue;
    const targets = explicitTargetsByStep.get(call.stepId) ?? new Set<string>();
    targets.add(call.to);
    explicitTargetsByStep.set(call.stepId, targets);
  }

  for (const flow of flows) {
    const uses = [...flow.producers, ...flow.consumers];
    for (const use of uses) {
      if (use.stepId === null) continue;
      const targets = explicitTargetsByStep.get(use.stepId);
      if (!targets || targets.size !== 1) continue;
      const exactLine =
        use.source.context.find((entry) => entry.line === use.source.line)?.text ?? "";
      const isWiringDeclaration =
        /^\s*\|/.test(exactLine) || /\b(?:input|output|produces?|consumes?)\s*:/i.test(exactLine);
      const isCoordinatorArtifact =
        authorityByOwner.get(use.owner) === "coordination" &&
        !infrastructureArtifacts.has(flow.key) &&
        !/\b(?:create|save|update|write)\b|创建|保存|更新|写入/i.test(exactLine);
      if (!isWiringDeclaration && !isCoordinatorArtifact) continue;
      const target = [...targets][0];
      if (!target) continue;
      use.owner = target;
      use.id = `artifact-use:${target}:${flow.key}:${use.direction}:${use.source.line}`;
    }
  }

  return flows.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function classifySkill(
  skill: SkillSource,
  outboundSkillCalls: number,
  inbound: number,
): SkillClassification {
  const firstH2 = skill.lines.findIndex(
    (line, index) => index >= skill.bodyStart && /^##\s+/.test(line),
  );
  const introEnd = firstH2 === -1 ? Math.min(skill.lines.length, skill.bodyStart + 60) : firstH2;
  const intro = skill.lines.slice(skill.bodyStart, introEnd).join("\n");
  const opening = skill.lines.slice(skill.bodyStart, skill.bodyStart + 80).join("\n");
  const combined = `${skill.node.name}\n${skill.node.description}\n${intro}`;
  const soleEntry = /\bsole entry point\b|唯一入口/i.test(combined);
  const explicitEntry =
    /\b(?:top-level (?:flow|workflow)|end-to-end|full pipeline|full workflow|workflow\s+\d+(?:\.\d+)?)\b|顶层流程|全流程/i.test(
      combined,
    );
  const explicitChain = /\bchains? sub-skills? into .{0,60}pipeline\b|把.+子任务.+串联/i.test(
    opening,
  );
  const selfContainedLoop = /\b(?:autonomous|outer)-loop\b|自主循环|外层循环/i.test(combined);
  const flowName = /(?:pipeline|loop|manager)(?:-[a-z0-9]+)?$/.test(skill.node.name);
  if (
    soleEntry ||
    flowName ||
    selfContainedLoop ||
    (outboundSkillCalls > 0 && (explicitEntry || explicitChain))
  ) {
    return "entry";
  }
  if (inbound > 0) return "subtask";
  return "standalone";
}

function missingTargetWarnings(skills: SkillSource[], knownNames: Set<string>): AuditWarning[] {
  const warnings: AuditWarning[] = [];
  for (const skill of skills) {
    for (let index = skill.bodyStart; index < skill.lines.length; index += 1) {
      const line = skill.lines[index] ?? "";
      const pattern =
        /\b(?:call|dispatch|invoke|run|spawn|调用|派发|运行)\s+\/([a-z][a-z0-9-]{2,})/gi;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (knownNames.has(match[1])) continue;
        const source = sourceReference(skill.node.file, index + 1, skill.lines);
        warnings.push({
          id: `warning:missing-target:${skill.node.id}:${index + 1}:${match[1]}`,
          kind: "missing-call-target",
          severity: "review",
          summary: `${skill.node.name} 看起来调用 /${match[1]}，但当前 skills/ 中没有这个目标。`,
          source,
        });
      }
    }
  }
  return warnings;
}

function cycleWarnings(skills: SkillNode[], calls: CallEdge[]): AuditWarning[] {
  const adjacency = new Map<string, string[]>();
  for (const skill of skills) adjacency.set(skill.id, []);
  for (const call of calls) {
    if (call.relation !== "call" || !call.to.startsWith("skill:")) continue;
    const targets = adjacency.get(call.from);
    if (targets && !targets.includes(call.to)) targets.push(call.to);
  }

  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indexes = new Map<string, number>();
  const lows = new Map<string, number>();
  const components: string[][] = [];

  function visit(node: string): void {
    indexes.set(node, nextIndex);
    lows.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lows.set(node, Math.min(lows.get(node) ?? 0, lows.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lows.set(node, Math.min(lows.get(node) ?? 0, indexes.get(target) ?? 0));
      }
    }

    if (lows.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  }

  for (const skill of skills) {
    if (!indexes.has(skill.id)) visit(skill.id);
  }

  const names = new Map(skills.map((skill) => [skill.id, skill.name]));
  return components
    .filter((component) => component.length > 1)
    .map(
      (component, index): AuditWarning => ({
        id: `warning:call-cycle:${index}`,
        kind: "call-cycle",
        severity: "review",
        summary: `检测到相互调用环：${component.map((id) => names.get(id) ?? id).join(" → ")}。请确认这是有界循环，不是意外回跳。`,
        source: null,
      }),
    );
}

function buildWarnings(
  skills: SkillSource[],
  calls: CallEdge[],
  artifacts: ArtifactFlow[],
): AuditWarning[] {
  const warnings: AuditWarning[] = [];
  for (const call of calls) {
    if (call.relation !== "call" || call.confidence !== "inferred") continue;
    warnings.push({
      id: `warning:inferred:${call.id}`,
      kind: "inferred-call",
      severity: "review",
      summary: `这条调用由文字推测，需人工确认：${call.summary}`,
      source: call.source,
    });
  }
  for (const artifact of artifacts) {
    if (artifact.consumers.length > 0 && artifact.producers.length === 0) {
      warnings.push({
        id: `warning:artifact-source:${artifact.key}`,
        kind: "artifact-source",
        severity: "review",
        summary: `${artifact.displayName} 有读取方，但没有找到明确的产出方。`,
        source: artifact.consumers[0]?.source ?? null,
      });
    }
    if (artifact.producers.length > 0 && artifact.consumers.length === 0) {
      warnings.push({
        id: `warning:artifact-consumer:${artifact.key}`,
        kind: "artifact-consumer",
        severity: "info",
        summary: `${artifact.displayName} 有产出方，但没有找到后续读取方；它也可能是最终交付物。`,
        source: artifact.producers[0]?.source ?? null,
      });
    }
  }
  for (const skill of skills) {
    if (skill.node.authority !== "unclear") continue;
    warnings.push({
      id: `warning:unclear-role:${skill.node.id}`,
      kind: "unclear-role",
      severity: "info",
      summary: `${skill.node.name} 的说明不足以判断它负责裁决、执行还是编排。`,
      source: skill.node.steps[0]?.source ?? null,
    });
  }
  return warnings;
}

function updateNodeCounts(skills: SkillSource[], code: CodeSource[], calls: CallEdge[]): void {
  const nodes = new Map<string, SkillNode | CodeNode>();
  for (const skill of skills) nodes.set(skill.node.id, skill.node);
  for (const source of code) nodes.set(source.node.id, source.node);
  for (const call of calls) {
    if (call.relation !== "call" && call.relation !== "import") continue;
    const from = nodes.get(call.from);
    const to = nodes.get(call.to);
    if (from) from.outbound += 1;
    if (to) to.inbound += 1;
  }
  for (const skill of skills) {
    const calledSkills = new Set(
      calls
        .filter(
          (call) =>
            call.from === skill.node.id && call.relation === "call" && call.to.startsWith("skill:"),
        )
        .map((call) => call.to),
    );
    skill.node.classification = classifySkill(skill, calledSkills.size, skill.node.inbound);
    if (skill.node.classification === "entry" && skill.node.authority === "unclear") {
      skill.node.authority = "coordination";
    }
  }
}

function enrichInferredCodeDescriptions(
  code: CodeSource[],
  artifacts: ArtifactFlow[],
  calls: CallEdge[],
): void {
  for (const source of code) {
    if (source.node.descriptionConfidence === "explicit") continue;
    if (!source.node.description.startsWith("执行 ")) continue;
    const inputs = artifacts
      .filter((artifact) => artifact.consumers.some((use) => use.owner === source.node.id))
      .map((artifact) => artifact.displayName);
    const outputs = artifacts
      .filter((artifact) => artifact.producers.some((use) => use.owner === source.node.id))
      .map((artifact) => artifact.displayName);
    const called = calls
      .filter((call) => call.from === source.node.id && call.relation === "call")
      .map((call) => path.basename(call.to));
    const name = humanizeCodeName(source.node.file);
    if (inputs.length > 0 && outputs.length > 0) {
      source.node.description = `执行 ${name}：读取 ${inputs.slice(0, 3).join("、")}，生成 ${outputs.slice(0, 3).join("、")}。`;
    } else if (outputs.length > 0) {
      source.node.description = `执行 ${name}，生成 ${outputs.slice(0, 3).join("、")}。`;
    } else if (inputs.length > 0) {
      source.node.description = `执行 ${name}，读取并处理 ${inputs.slice(0, 3).join("、")}。`;
    } else if (called.length > 0) {
      source.node.description = `执行 ${name}，并调用 ${called.slice(0, 3).join("、")}。`;
    }
  }
}

export function extractFlowAudit(rootInput: string): FlowAudit {
  const root = path.resolve(rootInput);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new FlowAuditInputError(`ARIS root is not a directory: ${root}`);
  }
  const skillFiles = discoverSkillFiles(root);
  if (skillFiles.length === 0) {
    throw new FlowAuditInputError(`No SKILL.md files found under ${path.join(root, "skills")}`);
  }

  const skillSources = skillFiles.map((filePath) => readSkill(root, filePath));
  const duplicateNames = new Set<string>();
  const skillsByName = new Map<string, SkillNode>();
  for (const skill of skillSources) {
    if (skillsByName.has(skill.node.name)) duplicateNames.add(skill.node.name);
    skillsByName.set(skill.node.name, skill.node);
  }
  if (duplicateNames.size > 0) {
    throw new FlowAuditInputError(
      `Duplicate skill names: ${[...duplicateNames].sort().join(", ")}`,
    );
  }

  const codeSources = discoverCodeFiles(root).map((filePath) => readCode(root, filePath));
  const lookup = codeLookup(codeSources);
  const skillCalls = skillSources.flatMap((skill) => scanSkillCalls(skill, skillsByName));
  const skillToolCalls = skillSources.flatMap((skill) =>
    scanToolInvocations(skill.node.id, skill.node.file, skill.lines, skill.ranges, lookup),
  );
  const codeCalls = codeSources.flatMap((source) =>
    scanToolInvocations(source.node.id, source.node.file, source.lines, null, lookup),
  );
  const calls = dedupeCalls([...skillCalls, ...skillToolCalls, ...codeCalls]);
  updateNodeCounts(skillSources, codeSources, calls);

  const artifacts = buildArtifactFlows(skillSources, codeSources, calls);
  enrichInferredCodeDescriptions(codeSources, artifacts, calls);
  const warnings = [
    ...missingTargetWarnings(skillSources, new Set(skillsByName.keys())),
    ...buildWarnings(skillSources, calls, artifacts),
    ...cycleWarnings(
      skillSources.map((skill) => skill.node),
      calls,
    ),
  ].sort((left, right) => {
    const severityOrder = { review: 0, info: 1 };
    const bySeverity = severityOrder[left.severity] - severityOrder[right.severity];
    return bySeverity || left.id.localeCompare(right.id);
  });

  const skills = skillSources
    .map((skill) => skill.node)
    .sort((left, right) => left.name.localeCompare(right.name));
  const code = codeSources
    .map((source) => source.node)
    .sort((left, right) => left.file.localeCompare(right.file));
  const entryCount = skills.filter((skill) => skill.classification === "entry").length;
  const subtaskCount = skills.filter((skill) => skill.classification === "subtask").length;
  const standaloneCount = skills.filter((skill) => skill.classification === "standalone").length;
  const explicitCalls = calls.filter((call) => call.relation === "call");

  return {
    schemaVersion: 2,
    rootName: path.basename(root),
    coverage: {
      skillFiles: skills.length,
      scriptFiles: code.filter((node) => node.kind === "script").length,
      toolFiles: code.filter((node) => node.kind === "tool").length,
      excludedDirectories: [...EXCLUDED_DIRECTORIES].sort(),
    },
    stats: {
      entries: entryCount,
      subtasks: subtaskCount,
      standalone: standaloneCount,
      calls: explicitCalls.length,
      inferredCalls: explicitCalls.filter((call) => call.confidence === "inferred").length,
      artifacts: artifacts.length,
      warnings: warnings.length,
      reviewWarnings: warnings.filter((warning) => warning.severity === "review").length,
      infoWarnings: warnings.filter((warning) => warning.severity === "info").length,
    },
    skills,
    code,
    calls,
    artifacts,
    warnings,
  };
}
