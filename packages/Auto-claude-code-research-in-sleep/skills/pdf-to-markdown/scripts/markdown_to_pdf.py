#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Create a PDF file from Markdown content using pymupdf (fitz)."""
import sys
import os
import re


def markdown_content_to_pdf(content: str, output_path: str):
    """Convert markdown content to a styled PDF."""
    import fitz  # PyMuPDF

    doc = fitz.open()
    page_width = 595  # A4
    page_height = 842
    margin = 50
    usable_width = page_width - 2 * margin
    y = margin
    page = doc.new_page(width=page_width, height=page_height)

    # Font settings
    fonts = {
        "h1": ("helv", 22, True),
        "h2": ("helv", 18, True),
        "h3": ("helv", 14, True),
        "h4": ("helv", 12, True),
        "body": ("helv", 11, False),
        "bold": ("helv", 11, True),
        "bullet": ("helv", 11, False),
    }

    def new_page():
        nonlocal page, y
        page = doc.new_page(width=page_width, height=page_height)
        y = margin

    def check_space(needed):
        nonlocal y
        if y + needed > page_height - margin:
            new_page()

    def draw_text(text, font_name, font_size, bold=False, indent=0, spacing=4):
        nonlocal y
        if not text.strip():
            return
        # Simple word wrap
        words = text.split()
        lines_out = []
        current_line = ""
        for word in words:
            test = f"{current_line} {word}".strip()
            tw = fitz.get_text_length(test, fontname=font_name, fontsize=font_size)
            if tw > usable_width - indent:
                if current_line:
                    lines_out.append(current_line)
                current_line = word
            else:
                current_line = test
        if current_line:
            lines_out.append(current_line)

        for line in lines_out:
            check_space(font_size + spacing)
            page.insert_text(
                fitz.Point(margin + indent, y + font_size),
                line,
                fontname=font_name,
                fontsize=font_size,
            )
            y += font_size + spacing

    def draw_hr():
        nonlocal y
        check_space(10)
        y += 5
        page.draw_line(
            fitz.Point(margin, y), fitz.Point(page_width - margin, y),
            color=(0.7, 0.7, 0.7), width=0.5
        )
        y += 5

    for line in content.split("\n"):
        stripped = line.strip()

        if not stripped:
            y += 6
            continue

        if stripped == "---":
            draw_hr()
            continue

        if stripped.startswith("#### "):
            y += 4
            draw_text(stripped[5:], *fonts["h4"], spacing=6)
        elif stripped.startswith("### "):
            y += 6
            draw_text(stripped[4:], *fonts["h3"], spacing=8)
        elif stripped.startswith("## "):
            y += 8
            draw_text(stripped[3:], *fonts["h2"], spacing=10)
        elif stripped.startswith("# "):
            y += 10
            draw_text(stripped[2:], *fonts["h1"], spacing=12)
        elif stripped.startswith("- ") or stripped.startswith("* "):
            text = stripped[2:]
            clean = re.sub(r"\*\*\*(.+?)\*\*\*", r"\1", text)
            clean = re.sub(r"\*\*(.+?)\*\*", r"\1", clean)
            clean = re.sub(r"\*(.+?)\*", r"\1", clean)
            draw_text(f"•  {clean}", *fonts["bullet"], indent=15, spacing=4)
        elif re.match(r"^\d+\.\s", stripped):
            num_match = re.match(r"^(\d+\.)\s(.+)", stripped)
            if num_match:
                text = num_match.group(2)
                clean = re.sub(r"\*\*\*(.+?)\*\*\*", r"\1", text)
                clean = re.sub(r"\*\*(.+?)\*\*", r"\1", clean)
                clean = re.sub(r"\*(.+?)\*", r"\1", clean)
                draw_text(f"{num_match.group(1)} {clean}", *fonts["body"], indent=15, spacing=4)
        elif stripped.startswith("> "):
            text = stripped[2:]
            draw_text(text, "helv", 10, False, indent=20, spacing=4)
        else:
            clean = re.sub(r"\*\*\*(.+?)\*\*\*", r"\1", stripped)
            clean = re.sub(r"\*\*(.+?)\*\*", r"\1", clean)
            clean = re.sub(r"\*(.+?)\*", r"\1", clean)
            draw_text(clean, *fonts["body"], spacing=4)

    doc.save(output_path)
    doc.close()
    print(f"PDF saved to: {output_path}")


def markdown_to_pdf(md_path: str, output_path: str):
    """Convert a markdown file to PDF."""
    if not os.path.exists(md_path):
        print(f"Error: File not found: {md_path}", file=sys.stderr)
        sys.exit(1)
    with open(md_path, "r", encoding="utf-8") as f:
        content = f.read()
    markdown_content_to_pdf(content, output_path)


if __name__ == "__main__":
    # Mode 1: stdin -> pdf
    if len(sys.argv) >= 3 and sys.argv[1] == "--stdin":
        output_path = sys.argv[2]
        md_content = sys.stdin.read()
        if not md_content.strip():
            print("Error: No content received from stdin", file=sys.stderr)
            sys.exit(1)
        markdown_content_to_pdf(md_content, output_path)
    # Mode 2: file -> pdf
    elif len(sys.argv) >= 3:
        markdown_to_pdf(sys.argv[1], sys.argv[2])
    else:
        print("Usage:", file=sys.stderr)
        print("  markdown_to_pdf.py <input.md> <output.pdf>", file=sys.stderr)
        print("  echo 'md content' | markdown_to_pdf.py --stdin <output.pdf>", file=sys.stderr)
        sys.exit(1)
