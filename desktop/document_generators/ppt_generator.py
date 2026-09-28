# -*- coding: utf-8 -*-
"""
Professional PowerPoint generator using python-pptx.
Generates modern, well-designed presentations.
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')

from pptx import Presentation
from pptx.util import Inches, Pt, Cm, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

# ─── Color Palette ──────────────────────────────────────────────
COLORS = {
    'primary': RGBColor(0x1a, 0x1a, 0x2e),
    'accent': RGBColor(0x0f, 0x34, 0x60),
    'highlight': RGBColor(0x16, 0x21, 0x3e),
    'gradient_end': RGBColor(0x53, 0x3a, 0x7d),
    'text': RGBColor(0x2c, 0x2c, 0x2c),
    'text_light': RGBColor(0x66, 0x66, 0x66),
    'white': RGBColor(0xff, 0xff, 0xff),
    'divider': RGBColor(0xe0, 0xe0, 0xe0),
    'bullet_accent': RGBColor(0x34, 0x98, 0xdb),
    'bg_light': RGBColor(0xf5, 0xf7, 0xfa),
}

# 16:9 slide dimensions
SLIDE_WIDTH = Inches(13.333)
SLIDE_HEIGHT = Inches(7.5)


# ─── Helper Functions ──────────────────────────────────────────
def add_shape(slide, left, top, width, height, fill_color=None):
    """Add a rectangle shape."""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.line.fill.background()
    if fill_color:
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill_color
    return shape


def add_textbox(slide, left, top, width, height):
    """Add a text box."""
    return slide.shapes.add_textbox(left, top, width, height)


def set_text(textframe, text, font_name='微软雅黑', size=18, bold=False,
             color=None, alignment=PP_ALIGN.LEFT, line_spacing=1.2):
    """Set text in a text frame with formatting."""
    textframe.clear()
    textframe.word_wrap = True
    p = textframe.paragraphs[0]
    p.alignment = alignment
    p.line_spacing = line_spacing

    parts = re.split(r'(\*\*.*?\*\*)', text)
    for part in parts:
        run = p.add_run()
        if part.startswith('**') and part.endswith('**'):
            run.text = part[2:-2]
            run.font.bold = True
        else:
            run.text = part
            run.font.bold = bold
        run.font.name = font_name
        run.font.size = Pt(size)
        if color:
            run.font.color.rgb = color
        # Set East Asian font
        rPr = run._r.get_or_add_rPr()
        rFonts = rPr.find(qn('a:latin'))
        ea = rPr.find(qn('a:ea'))
        if ea is None:
            ea = rPr.makeelement(qn('a:ea'), {})
            rPr.append(ea)
        ea.set('typeface', font_name)

    return textframe


def add_bullet_text(textframe, text, font_name='微软雅黑', size=16, color=None,
                    bullet_color=None, level=0, spacing_before=Pt(6)):
    """Add a bullet point to an existing text frame."""
    p = textframe.add_paragraph()
    p.level = level
    p.space_before = spacing_before
    p.line_spacing = 1.3

    # Bullet character
    run = p.add_run()
    run.text = '\u25cf  ' if level == 0 else '  \u25cb  '
    run.font.name = font_name
    run.font.size = Pt(size - 2)
    run.font.color.rgb = bullet_color or COLORS['bullet_accent']

    # Text content with inline bold
    parts = re.split(r'(\*\*.*?\*\*)', text)
    for part in parts:
        r = p.add_run()
        if part.startswith('**') and part.endswith('**'):
            r.text = part[2:-2]
            r.font.bold = True
        else:
            r.text = part
        r.font.name = font_name
        r.font.size = Pt(size)
        r.font.color.rgb = color or COLORS['text']
        # East Asian font
        rPr = r._r.get_or_add_rPr()
        ea = rPr.find(qn('a:ea'))
        if ea is None:
            ea = rPr.makeelement(qn('a:ea'), {})
            rPr.append(ea)
        ea.set('typeface', font_name)

    return p


# ─── Slide Builders ────────────────────────────────────────────
def build_title_slide(prs, title, subtitle=''):
    """Build a modern title slide with gradient background."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank layout

    # Background gradient
    bg = slide.background
    fill = bg.fill
    fill.gradient()
    fill.gradient_stops[0].color.rgb = COLORS['primary']
    fill.gradient_stops[0].position = 0.0
    fill.gradient_stops[1].color.rgb = COLORS['gradient_end']
    fill.gradient_stops[1].position = 1.0

    # Decorative accent bar
    add_shape(slide, Inches(1), Inches(3.0), Inches(2), Pt(4), COLORS['bullet_accent'])

    # Title text
    txBox = add_textbox(slide, Inches(1), Inches(3.2), Inches(11), Inches(1.5))
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    run = p.add_run()
    run.text = title
    run.font.name = '微软雅黑'
    run.font.size = Pt(40)
    run.font.bold = True
    run.font.color.rgb = COLORS['white']
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find(qn('a:ea'))
    if ea is None:
        ea = rPr.makeelement(qn('a:ea'), {})
        rPr.append(ea)
    ea.set('typeface', '微软雅黑')

    # Subtitle
    if subtitle:
        txBox2 = add_textbox(slide, Inches(1), Inches(4.8), Inches(11), Inches(0.8))
        set_text(txBox2.text_frame, subtitle, '微软雅黑', 18,
                 color=RGBColor(0xcc, 0xcc, 0xcc), alignment=PP_ALIGN.LEFT)

    # Bottom accent line
    add_shape(slide, Inches(0), Inches(7.2), SLIDE_WIDTH, Pt(4), COLORS['bullet_accent'])


def build_content_slide(prs, title, content_lines, slide_number=0):
    """Build a content slide with modern styling."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # Blank layout

    # White background with subtle top bar
    add_shape(slide, Inches(0), Inches(0), SLIDE_WIDTH, Inches(1.2), COLORS['primary'])

    # Title area
    txBox = add_textbox(slide, Inches(0.8), Inches(0.15), Inches(11), Inches(0.9))
    set_text(txBox.text_frame, title, '微软雅黑', 28, bold=True,
             color=COLORS['white'], alignment=PP_ALIGN.LEFT)

    # Accent line under header
    add_shape(slide, Inches(0.8), Inches(1.2), Inches(3), Pt(3), COLORS['bullet_accent'])

    # Content area
    txBox = add_textbox(slide, Inches(0.8), Inches(1.6), Inches(11.5), Inches(5.4))
    tf = txBox.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE

    first = True
    for line in content_lines:
        line = line.strip()
        if not line:
            continue

        if first:
            set_text(tf, line, '微软雅黑', 16, color=COLORS['text'])
            first = False
        else:
            add_bullet_text(tf, line, '微软雅黑', 16, color=COLORS['text'])

    # Page number
    if slide_number > 0:
        txBox2 = add_textbox(slide, Inches(12.3), Inches(7.0), Inches(0.8), Inches(0.4))
        set_text(txBox2.text_frame, str(slide_number), '微软雅黑', 10,
                 color=COLORS['text_light'], alignment=PP_ALIGN.RIGHT)

    # Bottom accent
    add_shape(slide, Inches(0), Inches(7.35), SLIDE_WIDTH, Pt(3), COLORS['primary'])


def build_section_slide(prs, title, subtitle=''):
    """Build a section divider slide."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # Dark background
    bg = slide.background
    fill = bg.fill
    fill.solid()
    fill.fore_color.rgb = COLORS['highlight']

    # Centered content
    txBox = add_textbox(slide, Inches(1), Inches(2.5), Inches(11), Inches(1.5))
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = title
    run.font.name = '微软雅黑'
    run.font.size = Pt(36)
    run.font.bold = True
    run.font.color.rgb = COLORS['white']
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find(qn('a:ea'))
    if ea is None:
        ea = rPr.makeelement(qn('a:ea'), {})
        rPr.append(ea)
    ea.set('typeface', '微软雅黑')

    if subtitle:
        txBox2 = add_textbox(slide, Inches(1), Inches(4.2), Inches(11), Inches(0.8))
        set_text(txBox2.text_frame, subtitle, '微软雅黑', 18,
                 color=RGBColor(0xbb, 0xbb, 0xbb), alignment=PP_ALIGN.CENTER)

    # Accent line
    add_shape(slide, Inches(5.5), Inches(3.9), Inches(2.3), Pt(3), COLORS['bullet_accent'])


def build_end_slide(prs, title='Thank You', subtitle=''):
    """Build an ending slide."""
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    bg = slide.background
    fill = bg.fill
    fill.gradient()
    fill.gradient_stops[0].color.rgb = COLORS['primary']
    fill.gradient_stops[0].position = 0.0
    fill.gradient_stops[1].color.rgb = COLORS['gradient_end']
    fill.gradient_stops[1].position = 1.0

    txBox = add_textbox(slide, Inches(1), Inches(2.5), Inches(11), Inches(1.5))
    tf = txBox.text_frame
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = title
    run.font.name = '微软雅黑'
    run.font.size = Pt(44)
    run.font.bold = True
    run.font.color.rgb = COLORS['white']
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find(qn('a:ea'))
    if ea is None:
        ea = rPr.makeelement(qn('a:ea'), {})
        rPr.append(ea)
    ea.set('typeface', '微软雅黑')

    if subtitle:
        txBox2 = add_textbox(slide, Inches(1), Inches(4.2), Inches(11), Inches(0.8))
        set_text(txBox2.text_frame, subtitle, '微软雅黑', 18,
                 color=RGBColor(0xbb, 0xbb, 0xbb), alignment=PP_ALIGN.CENTER)

    add_shape(slide, Inches(5.5), Inches(3.9), Inches(2.3), Pt(3), COLORS['bullet_accent'])


# ─── Main Generator ────────────────────────────────────────────
def generate_ppt(data, output_path):
    """Generate a professional presentation."""
    prs = Presentation()
    prs.slide_width = SLIDE_WIDTH
    prs.slide_height = SLIDE_HEIGHT

    title = data.get('title', 'Presentation')
    slides_data = data.get('slides', [])
    subtitle = data.get('subtitle', '')

    # Title slide
    build_title_slide(prs, title, subtitle or 'Generated by CC Desktop')

    # Content slides
    for i, slide_data in enumerate(slides_data, 1):
        s_title = slide_data.get('title', '')
        s_content = slide_data.get('content', '')
        content_lines = [l.strip() for l in s_content.split('\n') if l.strip()]

        # If title contains section markers, build a section divider
        if s_title.startswith('---') or s_title.startswith('==='):
            build_section_slide(prs, s_title.strip('-= '), slide_data.get('subtitle', ''))
        else:
            build_content_slide(prs, s_title, content_lines, slide_number=i)

    # End slide
    build_end_slide(prs, 'Thank You', 'Generated by CC Desktop')

    prs.save(output_path)
    return output_path


# ─── Main ──────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print('Usage: ppt_generator.py <data.json> <output.pptx>')
        sys.exit(1)

    data_file = sys.argv[1]
    output = sys.argv[2]

    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    try:
        os.remove(data_file)
    except:
        pass

    generate_ppt(data, output)
    print('OK:' + output)


if __name__ == '__main__':
    main()
