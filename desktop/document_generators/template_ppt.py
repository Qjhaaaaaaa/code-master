# -*- coding: utf-8 -*-
"""
PPT template filler using python-pptx.
Opens an existing .pptx template and adds new slides while preserving
the template's master slides, themes, fonts, colors, and backgrounds.
Also supports {{placeholder}} replacement in existing template slides.
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')

from pptx import Presentation
from pptx.util import Inches, Pt, Cm, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.oxml.ns import qn


# ─── Helper Functions ──────────────────────────────────────────
def _set_run_font(run, font_name='微软雅黑', size=None, bold=None, color=None):
    """Set font properties on a run."""
    run.font.name = font_name
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        if isinstance(color, str) and color.startswith('#'):
            r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
            run.font.color.rgb = RGBColor(r, g, b)
        elif isinstance(color, (list, tuple)):
            run.font.color.rgb = RGBColor(*color[:3])
    # Set East Asian font
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find(qn('a:ea'))
    if ea is None:
        ea = rPr.makeelement(qn('a:ea'), {})
        rPr.append(ea)
    ea.set('typeface', font_name)


def _add_formatted_paragraph(textframe, text, font_name='微软雅黑', size=18,
                              bold=False, color=None, alignment=PP_ALIGN.LEFT,
                              spacing_before=Pt(6)):
    """Add a paragraph with inline **bold** support."""
    p = textframe.add_paragraph()
    p.alignment = alignment
    p.space_before = spacing_before
    p.line_spacing = 1.3

    parts = re.split(r'(\*\*.*?\*\*)', text)
    for part in parts:
        run = p.add_run()
        if part.startswith('**') and part.endswith('**'):
            run.text = part[2:-2]
            _set_run_font(run, font_name, size, True, color)
        else:
            run.text = part
            _set_run_font(run, font_name, size, bold, color)

    return p


def _replace_in_text_frame(textframe, replacements):
    """Replace {{placeholders}} in a text frame, handling split runs."""
    for paragraph in textframe.paragraphs:
        full_text = paragraph.text
        if '{{' not in full_text:
            continue

        changed = False
        for key, value in replacements.items():
            if '{{' + key + '}}' in full_text:
                changed = True
        if not changed:
            continue

        # Get formatting from first run
        runs = paragraph.runs
        if not runs:
            continue

        template_run = runs[0]
        font_name = template_run.font.name or '微软雅黑'
        font_size = template_run.font.size
        font_bold = template_run.font.bold
        font_color = None
        try:
            font_color = template_run.font.color.rgb
        except (AttributeError, TypeError):
            pass

        # Merge all text, replace, redistribute
        merged = ''.join(r.text for r in runs)
        for key, value in replacements.items():
            merged = merged.replace('{{' + key + '}}', str(value))

        for i, run in enumerate(runs):
            if i == 0:
                run.text = merged
            else:
                run.text = ''


# ─── Main Generator ────────────────────────────────────────────
def fill_ppt_template(data, output_path):
    """Fill a PPT template: add new slides and/or replace placeholders.

    data fields:
        template_path: path to the template .pptx
        slides: array of slide definitions:
            - title: slide title text
            - content: bullet points (newline-separated)
            - layout_index: which template layout to use (default 1 = title+content)
            - subtitle: optional subtitle text
        replacements: dict of {{key}}: value to replace in existing template slides
        default_layout: default layout index (default 1)
    """
    template_path = data.get('template_path', '')
    if not template_path or not os.path.exists(template_path):
        raise FileNotFoundError(f'Template not found: {template_path}')

    slides_data = data.get('slides', [])
    replacements = data.get('replacements', {})
    default_layout = data.get('default_layout', 1)

    prs = Presentation(template_path)

    # ── Step 1: Replace placeholders in existing template slides ──
    if replacements:
        replacements = {k: str(v) for k, v in replacements.items()}
        for slide in prs.slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    _replace_in_text_frame(shape.text_frame, replacements)
                if shape.has_table:
                    for row in shape.table.rows:
                        for cell in row.cells:
                            _replace_in_text_frame(cell.text_frame, replacements)

    # ── Step 2: Add new slides ──
    available_layouts = prs.slide_layouts
    num_layouts = len(available_layouts)

    for slide_def in slides_data:
        title = slide_def.get('title', '')
        content = slide_def.get('content', '')
        subtitle = slide_def.get('subtitle', '')
        layout_idx = slide_def.get('layout_index', default_layout)

        # Clamp layout index
        if layout_idx >= num_layouts:
            layout_idx = min(layout_idx, num_layouts - 1)
        if layout_idx < 0:
            layout_idx = 0

        layout = available_layouts[layout_idx]
        slide = prs.slides.add_slide(layout)

        # Try to set title
        if title and slide.shapes.title:
            slide.shapes.title.text = title

        # Try to find content placeholder (usually placeholder[1])
        content_ph = None
        for ph in slide.placeholders:
            if ph.placeholder_format.idx == 1 and ph != slide.shapes.title:
                content_ph = ph
                break

        if content_ph and content:
            tf = content_ph.text_frame
            tf.clear()
            tf.word_wrap = True

            lines = [l.strip() for l in content.split('\n') if l.strip()]
            first = True
            for line in lines:
                if first:
                    # First line uses the existing paragraph
                    if tf.paragraphs:
                        p = tf.paragraphs[0]
                        parts = re.split(r'(\*\*.*?\*\*)', line)
                        for part in parts:
                            run = p.add_run()
                            if part.startswith('**') and part.endswith('**'):
                                run.text = part[2:-2]
                                run.font.bold = True
                            else:
                                run.text = part
                            run.font.size = Pt(16)
                            run.font.name = '微软雅黑'
                            rPr = run._r.get_or_add_rPr()
                            ea = rPr.find(qn('a:ea'))
                            if ea is None:
                                ea = rPr.makeelement(qn('a:ea'), {})
                                rPr.append(ea)
                            ea.set('typeface', '微软雅黑')
                    first = False
                else:
                    _add_formatted_paragraph(tf, line, '微软雅黑', 16,
                                             spacing_before=Pt(6))

        # If subtitle provided and there's a subtitle placeholder
        if subtitle:
            for ph in slide.placeholders:
                if ph.placeholder_format.idx == 1 and ph != slide.shapes.title and ph != content_ph:
                    ph.text = subtitle
                    break
            # Also try placeholder[1] if content_ph was used for content
            if not content_ph:
                for ph in slide.placeholders:
                    if ph.placeholder_format.idx == 1:
                        ph.text = subtitle
                        break

    # ── Step 3: Available layouts info ──
    layout_info = []
    for i, layout in enumerate(available_layouts):
        name = layout.name
        ph_count = len(layout.placeholders)
        layout_info.append({'index': i, 'name': name, 'placeholders': ph_count})

    prs.save(output_path)
    return output_path, layout_info


# ─── List layouts without modifying ─────────────────────────────
def list_layouts(template_path):
    """List available slide layouts in a template."""
    prs = Presentation(template_path)
    layouts = []
    for i, layout in enumerate(prs.slide_layouts):
        phs = []
        for ph in layout.placeholders:
            phs.append({
                'idx': ph.placeholder_format.idx,
                'type': str(ph.placeholder_format.type),
                'name': ph.name,
            })
        layouts.append({
            'index': i,
            'name': layout.name,
            'placeholders': phs,
        })
    return layouts


# ─── Main ──────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print('Usage: template_ppt.py <data.json> <output.pptx>')
        sys.exit(1)

    data_file = sys.argv[1]
    output = sys.argv[2]

    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    try:
        os.remove(data_file)
    except:
        pass

    output_path, layout_info = fill_ppt_template(data, output)
    layouts_json = json.dumps(layout_info, ensure_ascii=False)
    print(f'OK:{output_path}|{layouts_json}')


if __name__ == '__main__':
    main()
