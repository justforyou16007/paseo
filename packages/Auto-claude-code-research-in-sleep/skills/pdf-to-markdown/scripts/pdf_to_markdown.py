#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Convert a PDF file to Markdown format using pymupdf4llm."""
import sys
import os

def convert_pdf_to_markdown(pdf_path: str, output_path: str | None = None) -> str:
    """Convert a PDF file to markdown text."""
    import pymupdf4llm

    if not os.path.exists(pdf_path):
        print(f"Error: File not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    md_text = pymupdf4llm.to_markdown(pdf_path)

    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(md_text)
        print(f"Markdown saved to: {output_path}")
    else:
        print(md_text)

    return md_text


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: pdf_to_markdown.py <input.pdf> [output.md]", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    convert_pdf_to_markdown(pdf_path, output_path)
