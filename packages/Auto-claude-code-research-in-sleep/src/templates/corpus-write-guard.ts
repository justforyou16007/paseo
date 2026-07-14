#!/usr/bin/env node

/**
 * PreToolUse guard: deny Bash writes to the ARIS skill corpus.
 *
 * Reads JSON from stdin (Claude Code hook protocol), writes JSON to stdout.
 * Exit 0 = allow, exit 2 = block (show stderr to the model).
 */

const CORPUS = String.raw`(?:\./)?(?:skills|shared-references|tools|templates|plugins)/`;

const WRITE_OPS: RegExp[] = [
  new RegExp(String.raw`>>?\s*"?'?` + CORPUS),
  new RegExp(String.raw`\btee\s+(?:-a\s+)?"?'?` + CORPUS),
  new RegExp(String.raw`\bsed\s+(?:-[a-zA-Z]*\s+)*-i\b[^|;&]*` + CORPUS),
  new RegExp(String.raw`\bdd\b[^|;&]*\bof="?'?` + CORPUS),
  new RegExp(String.raw`\b(?:cp|mv|install|rsync|ln)\b[^|;&]*\s"?'?` + CORPUS),
  new RegExp(String.raw`\btruncate\b[^|;&]*` + CORPUS),
  new RegExp(String.raw`\btouch\s+[^|;&]*` + CORPUS),
  new RegExp(String.raw`\.write_(?:text|bytes)\b[^|;&]*` + CORPUS),
  new RegExp(CORPUS + String.raw`[^'"]*['"]\s*\)\s*\.write_(?:text|bytes)`),
  new RegExp(String.raw`\b(?:python3?|perl|ruby|node)\b[^|;&]*open\([^)]*` + CORPUS),
];

function violates(command: string): string | null {
  for (const rx of WRITE_OPS) {
    const m = rx.exec(command);
    if (m) {
      return command.slice(m.index, m.index + 80);
    }
  }
  return null;
}

function main(): Promise<number> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw);
      } catch {
        resolve(0);
        return;
      }

      if (data.tool_name !== "Bash") {
        resolve(0);
        return;
      }

      const toolInput = (data.tool_input as Record<string, unknown>) ?? {};
      const command = (toolInput.command as string) ?? "";
      const hit = violates(command);

      if (hit) {
        process.stderr.write(
          "BLOCKED by corpus_write_guard: Bash may not WRITE the skill corpus " +
            `(matched: ${JSON.stringify(hit)}). Corpus mutation must go through the Write/Edit tools ` +
            "(reviewable, attributable). A read-only producer (meta-optimize / corpus-" +
            "audit) stages patches to .aris/meta/ and hands off to /meta-apply, which " +
            "lands them with the Write/Edit tools after the cross-model jury + human gate.\n",
        );
        resolve(2);
        return;
      }

      resolve(0);
    });
  });
}

main().then((code) => process.exit(code));
