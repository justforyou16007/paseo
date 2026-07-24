---
name: "office-word"
description: "Read and write Microsoft Word (.docx) files. Use when the user asks to read, analyze, create, or convert Word documents."
---

Resolve the skill-local script path first:

```bash
OFFICE_WORD_DIR=""
if [ -n "${CLAUDE_SKILL_DIR:-}" ]; then
  OFFICE_WORD_DIR="$CLAUDE_SKILL_DIR"
else
  OFFICE_WORD_DIR=".claude/skills/office-word"
fi
```

## Read a Word file

Converts a `.docx` to Markdown:

```bash
uv run --with python-docx "$OFFICE_WORD_DIR/scripts/read_docx.py" "<path_to_docx>"
```

Save as `.md` file:

```bash
uv run --with python-docx "$OFFICE_WORD_DIR/scripts/read_docx.py" "<path_to_docx>" "<output.md>"
```

## Write a Word file

### Preferred: Directly from markdown content (no intermediate file)

Pipe markdown content directly into the script using `--stdin`:

```bash
echo '<markdown_content>' | uv run --with python-docx "$OFFICE_WORD_DIR/scripts/write_docx.py" --stdin "<output.docx>"
```

For multi-line content, use a heredoc:

```bash
uv run --with python-docx "$OFFICE_WORD_DIR/scripts/write_docx.py" --stdin "<output.docx>" <<'EOF'
# Title

Some paragraph with **bold** text.
EOF
```

### From an existing Markdown file

If a `.md` file already exists, use it directly:

```bash
uv run --with python-docx "$OFFICE_WORD_DIR/scripts/write_docx.py" "<input.md>" "<output.docx>"
```

If you had to create the `.md` file as an intermediate step (it didn't exist before), delete it after generating the docx.

### Workflow to create a Word document

1. Prefer piping content via `--stdin` to avoid intermediate files.
2. If content is too large for a heredoc, create a temporary `.md` file, convert, then delete it.

## Supported formatting

- Headings (H1-H4), bullet lists, numbered lists, tables
- Bold, italic, and bold-italic inline formatting
- Tables are converted bidirectionally between Markdown and Word Table Grid style
