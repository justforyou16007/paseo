---
name: "office-powerpoint"
description: "Read and write Microsoft PowerPoint (.pptx) files. Use when the user asks to read, analyze, create, or convert PowerPoint presentations."
---

Resolve the skill-local script path first:

```bash
OFFICE_POWERPOINT_DIR=""
if [ -n "${CLAUDE_SKILL_DIR:-}" ]; then
  OFFICE_POWERPOINT_DIR="$CLAUDE_SKILL_DIR"
else
  OFFICE_POWERPOINT_DIR=".claude/skills/office-powerpoint"
fi
```

## Read a PowerPoint file

Converts a `.pptx` to Markdown:

```bash
uv run --with python-pptx "$OFFICE_POWERPOINT_DIR/scripts/read_pptx.py" "<path_to_pptx>"
```

Save as `.md` file:

```bash
uv run --with python-pptx "$OFFICE_POWERPOINT_DIR/scripts/read_pptx.py" "<path_to_pptx>" "<output.md>"
```

## Write a PowerPoint file

### Preferred: Directly from markdown content (no intermediate file)

Pipe markdown content directly using `--stdin`:

```bash
echo '<markdown_content>' | uv run --with python-pptx "$OFFICE_POWERPOINT_DIR/scripts/write_pptx.py" --stdin "<output.pptx>"
```

For multi-line content, use a heredoc:

```bash
uv run --with python-pptx "$OFFICE_POWERPOINT_DIR/scripts/write_pptx.py" --stdin "<output.pptx>" <<'EOF'
# Slide Title
## Subtitle
- Bullet point 1
- Bullet point 2
> Speaker notes here
---
# Second Slide
- More content
EOF
```

### From an existing Markdown file

```bash
uv run --with python-pptx "$OFFICE_POWERPOINT_DIR/scripts/write_pptx.py" "<input.md>" "<output.pptx>"
```

If you had to create the `.md` file as an intermediate step, delete it after generating the pptx.

### Markdown format for slides

- `---` separates slides
- `# Title` becomes the slide title
- `## Subtitle` becomes a subtitle (bold, larger font)
- `- item` becomes bullet points
- `> text` becomes speaker notes
- `| col | col |` tables are rendered as slide tables
- Other text becomes body content

## What gets extracted (read)

- Slide titles and text content with hierarchy
- Slide layout names
- Tables within slides as Markdown tables
- Speaker notes as blockquotes
- Bullet point levels preserved as nested lists
