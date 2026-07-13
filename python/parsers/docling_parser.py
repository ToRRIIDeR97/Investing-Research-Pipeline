#!/usr/bin/env python3
"""
Docling Parser Wrapper for Research OS.

Usage: python3 docling_parser.py <file_path>

Outputs JSON with: chunks[], tables[], metadata{}, warnings[]
Falls back to basic text extraction if Docling is not installed.
"""

import json
import sys
import os

def parse_with_docling(file_path: str) -> dict:
    """Parse document using Docling."""
    try:
        from docling.document_converter import DocumentConverter

        converter = DocumentConverter()
        result = converter.convert(file_path)
        doc = result.document

        chunks = []
        tables = []
        warnings = []

        # Extract text chunks
        chunk_index = 0
        char_offset = 0
        for item in doc.texts:
            text = item.text if hasattr(item, 'text') else str(item)
            if text.strip():
                chunks.append({
                    "chunkIndex": chunk_index,
                    "text": text,
                    "tokenCount": len(text.split()) * 4 // 3,  # rough estimate
                    "sectionTitle": getattr(item, 'label', None),
                    "pageStart": getattr(item, 'prov', [{}])[0].get('page_no') if hasattr(item, 'prov') and item.prov else None,
                    "charStart": char_offset,
                    "charEnd": char_offset + len(text),
                })
                chunk_index += 1
                char_offset += len(text)

        # Extract tables
        for i, table in enumerate(doc.tables):
            try:
                table_df = table.export_to_dataframe()
                tables.append({
                    "tableIndex": i,
                    "title": getattr(table, 'label', f'Table {i+1}'),
                    "tableJson": {
                        "headers": list(table_df.columns),
                        "rows": table_df.values.tolist(),
                    },
                    "confidence": 0.9,
                    "pageStart": getattr(table, 'prov', [{}])[0].get('page_no') if hasattr(table, 'prov') and table.prov else None,
                })
            except Exception as e:
                warnings.append(f"Failed to extract table {i}: {str(e)}")

        return {
            "chunks": chunks,
            "tables": tables,
            "metadata": {
                "parser": "docling",
                "pages": len(doc.pages) if hasattr(doc, 'pages') else None,
            },
            "warnings": warnings,
        }

    except ImportError:
        return None


def parse_basic(file_path: str) -> dict:
    """Basic text extraction fallback."""
    with open(file_path, 'r', errors='replace') as f:
        content = f.read()

    chunk_size = 2000
    chunks = []
    for i in range(0, len(content), chunk_size):
        text = content[i:i+chunk_size]
        chunks.append({
            "chunkIndex": i // chunk_size,
            "text": text,
            "tokenCount": len(text) // 4,
            "charStart": i,
            "charEnd": min(len(content), i + chunk_size),
        })

    return {
        "chunks": chunks,
        "tables": [],
        "metadata": {"parser": "basic_fallback"},
        "warnings": ["Docling not available, using basic text extraction"],
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: docling_parser.py <file_path>"}))
        sys.exit(1)

    file_path = sys.argv[1]

    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(1)

    # Try Docling first
    result = parse_with_docling(file_path)

    # Fall back to basic extraction
    if result is None:
        result = parse_basic(file_path)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
