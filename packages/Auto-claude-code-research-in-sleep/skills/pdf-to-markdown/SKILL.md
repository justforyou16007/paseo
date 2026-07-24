---
name: "pdf-to-markdown"
description: "Convert PDF files to Markdown format and create PDFs from Markdown. Use when the user asks to read, analyze, extract content from PDFs, or generate PDF documents."
---

Resolve the skill-local script path first:

```bash
PDF_TO_MARKDOWN_DIR=""
if [ -n "${CLAUDE_SKILL_DIR:-}" ]; then
  PDF_TO_MARKDOWN_DIR="$CLAUDE_SKILL_DIR"
else
  PDF_TO_MARKDOWN_DIR=".claude/skills/pdf-to-markdown"
fi
```

## Read a PDF file

Converts a PDF to Markdown and prints to stdout:

```bash
uv run --with pymupdf4llm "$PDF_TO_MARKDOWN_DIR/scripts/pdf_to_markdown.py" "<path_to_pdf>"
```

Save as `.md` file:

```bash
uv run --with pymupdf4llm "$PDF_TO_MARKDOWN_DIR/scripts/pdf_to_markdown.py" "<path_to_pdf>" "<output.md>"
```

## Write a PDF file

### Preferred: Directly from markdown content (no intermediate file)

Pipe markdown content directly using `--stdin`:

```bash
echo '<markdown_content>' | uv run --with pymupdf "$PDF_TO_MARKDOWN_DIR/scripts/markdown_to_pdf.py" --stdin "<output.pdf>"
```

For multi-line content, use a heredoc:

```bash
uv run --with pymupdf "$PDF_TO_MARKDOWN_DIR/scripts/markdown_to_pdf.py" --stdin "<output.pdf>" <<'EOF'
# Title

Some paragraph with content.

- Bullet point 1
- Bullet point 2

1. Numbered item
2. Another item
EOF
```

### From an existing Markdown file

```bash
uv run --with pymupdf "$PDF_TO_MARKDOWN_DIR/scripts/markdown_to_pdf.py" "<input.md>" "<output.pdf>"
```

If you had to create the `.md` file as an intermediate step, delete it after generating the PDF.

## Notes

- Read uses pymupdf4llm for high-quality text extraction preserving structure, tables, and image references.
- Write uses pymupdf (fitz) to generate styled A4 PDFs with headings, bullets, numbered lists, blockquotes, and horizontal rules.
- Dependencies are auto-installed via uv run.
- IMPORTANT: Do NOT create intermediate markdown files if you can pipe content directly via `--stdin`. If you must create one, always delete it after.

