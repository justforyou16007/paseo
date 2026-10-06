---
name: paper-compile
description: 'Compile LaTeX paper to PDF and verify output. Use when user says "编译论文", "compile paper", "build PDF", "生成PDF", or wants to compile LaTeX into a submission-ready PDF.'
argument-hint: [paper-directory]
allowed-tools: Bash(*), Read, Write, Edit, Grep, Glob
---

# Paper Compile

Compile `$ARGUMENTS` (default `paper/`) using the project's declared engine, default `pdflatex`. Use `latexmk`, retain `compile.log`, and produce `main.pdf`. Do not modify or delete source files.

## Build and failure contract

Run one compilation attempt with noninteractive, halt-on-error settings. Missing dependencies or a nonzero build stops this invocation: retain the log and report the first actionable error. Do not install packages, switch engines, edit source or retry here; a fixed source/environment needs a new invocation.

## Output checks

Check that the PDF is readable, figures render, references/citations resolve, fonts are embedded and the layout has no visible overflow. Report warnings without suppressing them. Unused section files are warnings, not permission to delete them.

Apply the venue rules provided by the project or owner for anonymity, page counting, appendix/references, file size and remaining `[VERIFY]` markers. Do not infer submission limits from a hardcoded venue/year table. If the rules are missing, report readiness as unverified.

Report status, PDF/log paths, body/reference/appendix page counts, page-limit result, unresolved references/citations and remaining warnings. A successful compile alone does not establish submission readiness.
