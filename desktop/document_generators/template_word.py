# -*- coding: utf-8 -*-
"""
Word template filler using python-docx.
Opens an existing .docx template and replaces {{placeholder}} markers
with actual content throughout paragraphs, runs, and table cells.
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')

from docx import Document
from docx.shared import Pt, RGBColor
from docx.oxml.ns import qn


def replace_in_paragraph(paragraph, replacements):
    """Replace {{placeholders}} in a paragraph, preserving formatting.

    Handles cases where placeholders are split across multiple runs.
    """
    full_text = paragraph.text
    if '{{' not in full_text:
        return False

    # Check if any placeholder matches
    changed = False
    for key, value in replacements.items():
        placeholder = '{{' + key + '}}'
        if placeholder in full_text:
            changed = True

    if not changed:
        return False

    # Strategy: rebuild paragraph by merging all runs into one text,
    # doing replacements, then re-distributing across runs
    runs = paragraph.runs
    if not runs:
        return False

    # Get the first run's formatting as template
    template_run = runs[0]
    font_name = template_run.font.name or '微软雅黑'
    font_size = template_run.font.size
    font_bold = template_run.font.bold
    font_color = template_run.font.color.rgb if template_run.font.color and template_run.font.color.rgb else None

    # Merge all run text
    merged = ''.join(r.text for r in runs)

    # Apply replacements
    for key, value in replacements.items():
        merged = merged.replace('{{' + key + '}}', str(value))

    # Clear all runs and set new text
    for i, run in enumerate(runs):
        if i == 0:
            run.text = merged
        else:
            run.text = ''

    return True


def replace_in_cell(cell, replacements):
    """Replace {{placeholders}} in all paragraphs of a table cell."""
    changed = False
    for paragraph in cell.paragraphs:
        if replace_in_paragraph(paragraph, replacements):
            changed = True
    return changed


def fill_word_template(data, output_path):
    """Fill a Word template with content by replacing placeholders.

    data fields:
        template_path: path to the template .docx
        replacements: dict of {placeholder_name: value}
            e.g., {"name": "张三", "phone": "13800138000", ...}
    """
    template_path = data.get('template_path', '')
    if not template_path or not os.path.exists(template_path):
        raise FileNotFoundError(f'Template not found: {template_path}')

    replacements = data.get('replacements', {})
    if not replacements:
        raise ValueError('No replacements provided')

    # Convert all values to strings
    replacements = {k: str(v) for k, v in replacements.items()}

    doc = Document(template_path)

    # Replace in regular paragraphs
    for paragraph in doc.paragraphs:
        replace_in_paragraph(paragraph, replacements)

    # Replace in table cells
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                replace_in_cell(cell, replacements)

    # Replace in headers and footers
    for section in doc.sections:
        for header in [section.header, section.first_page_header, section.even_page_header]:
            if header and header.is_linked_to_previous is False:
                for paragraph in header.paragraphs:
                    replace_in_paragraph(paragraph, replacements)
                for table in header.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            replace_in_cell(cell, replacements)

        for footer in [section.footer, section.first_page_footer, section.even_page_footer]:
            if footer and footer.is_linked_to_previous is False:
                for paragraph in footer.paragraphs:
                    replace_in_paragraph(paragraph, replacements)

    doc.save(output_path)
    return output_path


# ─── Main ──────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print('Usage: template_word.py <data.json> <output.docx>')
        sys.exit(1)

    data_file = sys.argv[1]
    output = sys.argv[2]

    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    try:
        os.remove(data_file)
    except:
        pass

    fill_word_template(data, output)
    print('OK:' + output)


if __name__ == '__main__':
    main()
