# -*- coding: utf-8 -*-
"""
Professional resume/report Word document generator using python-docx.
Matches the exact layout of reference Chinese resumes:
- A4 page with minimal margins
- Top/bottom dark teal decorative bars
- Photo in top-right (via table layout)
- Personal info in dual-column table (left info + right info + photo)
- Section headers: SimHei 14pt, color #214361
- Body: MicrosoftYaHei 9.5pt
- Project titles bold + time right-aligned via tab stops
- Numbered work items with bold numbers
- Skills with bold category labels
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')

from docx import Document
from docx.shared import Pt, Cm, Inches, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn, nsdecls
from docx.oxml import parse_xml

# ─── Colors ────────────────────────────────────────────────────
TEAL = RGBColor(0x22, 0x44, 0x60)
SECTION_COLOR = RGBColor(0x21, 0x43, 0x61)
TEXT_COLOR = RGBColor(0x0F, 0x11, 0x15)
TEXT_LIGHT = RGBColor(0x55, 0x55, 0x55)


# ─── Helpers ───────────────────────────────────────────────────
def set_cell_shading(cell, color_hex):
    shading = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{color_hex}"/>')
    cell._tc.get_or_add_tcPr().append(shading)


def set_cell_margins(cell, top=0, bottom=0, left=0, right=0):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcMar = parse_xml(
        f'<w:tcMar {nsdecls("w")}>'
        f'  <w:top w:w="{top}" w:type="dxa"/>'
        f'  <w:bottom w:w="{bottom}" w:type="dxa"/>'
        f'  <w:left w:w="{left}" w:type="dxa"/>'
        f'  <w:right w:w="{right}" w:type="dxa"/>'
        f'</w:tcMar>'
    )
    tcMar_existing = tcPr.find(qn('w:tcMar'))
    if tcMar_existing is not None:
        tcPr.remove(tcMar_existing)
    tcPr.append(tcMar)


def set_cell_width(cell, width_cm):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcW = parse_xml(f'<w:tcW {nsdecls("w")} w:w="{int(width_cm * 567)}" w:type="dxa"/>')
    existing = tcPr.find(qn('w:tcW'))
    if existing is not None:
        tcPr.remove(existing)
    tcPr.append(tcW)


def remove_table_borders(table):
    tbl = table._tbl
    tblPr = tbl.find(qn('w:tblPr'))
    if tblPr is None:
        tblPr = parse_xml(f'<w:tblPr {nsdecls("w")}/>')
        tbl.insert(0, tblPr)
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'  <w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        f'  <w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        f'  <w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        f'  <w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        f'  <w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        f'  <w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>'
        f'</w:tblBorders>'
    )
    existing = tblPr.find(qn('w:tblBorders'))
    if existing is not None:
        tblPr.remove(existing)
    tblPr.append(borders)


def add_run(paragraph, text, font_name='微软雅黑', size=9.5, bold=False, color=None, italic=False):
    run = paragraph.add_run(text)
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    if color:
        run.font.color.rgb = color
    run.font.name = font_name
    r = run._element
    rPr = r.find(qn('w:rPr'))
    if rPr is None:
        rPr = parse_xml(f'<w:rPr {nsdecls("w")}/>')
        r.insert(0, rPr)
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = parse_xml(f'<w:rFonts {nsdecls("w")} w:eastAsia="{font_name}"/>')
        rPr.insert(0, rFonts)
    else:
        rFonts.set(qn('w:eastAsia'), font_name)
    return run


def set_paragraph_spacing(paragraph, before=0, after=0, line_spacing=None):
    pf = paragraph.paragraph_format
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if line_spacing:
        pf.line_spacing = Pt(line_spacing)


def add_teal_bar(doc, position='top'):
    """Add a colored bar using a single-cell table."""
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.cell(0, 0)
    set_cell_shading(cell, '224460')
    set_cell_margins(cell, 0, 0, 0, 0)
    p = cell.paragraphs[0]
    p.clear()
    run = p.add_run(' ')
    run.font.size = Pt(2)
    # Set table width to full page
    tbl = table._tbl
    tblPr = tbl.find(qn('w:tblPr'))
    if tblPr is None:
        tblPr = parse_xml(f'<w:tblPr {nsdecls("w")}/>')
        tbl.insert(0, tblPr)
    tblW = parse_xml(f'<w:tblW {nsdecls("w")} w:w="5000" w:type="pct"/>')
    existing = tblPr.find(qn('w:tblW'))
    if existing is not None:
        tblPr.remove(existing)
    tblPr.append(tblW)
    remove_table_borders(table)
    return table


def _add_formatted_text(paragraph, text, font_name='微软雅黑', size=9.5, color=None):
    """Add text with inline **bold** formatting."""
    parts = re.split(r'(\*\*.*?\*\*)', text)
    for part in parts:
        if part.startswith('**') and part.endswith('**'):
            add_run(paragraph, part[2:-2], font_name, size, bold=True, color=color)
        else:
            add_run(paragraph, part, font_name, size, color=color)


# ─── Resume Generator ──────────────────────────────────────────
def generate_resume(data, output_path):
    """Generate a professional resume matching reference layout."""
    doc = Document()

    # ── Page setup: A4, minimal margins ──
    for section in doc.sections:
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(0.5)
        section.bottom_margin = Cm(0.3)
        section.left_margin = Cm(1.0)
        section.right_margin = Cm(1.0)

    content = data.get('content', '')
    sections = parse_sections(content)

    # ── Top decorative bar ──
    add_teal_bar(doc, 'top')

    # ── Personal Info Area: table with 3 columns [left_info | right_info | photo] ──
    info_table = doc.add_table(rows=1, cols=3)
    info_table.alignment = WD_TABLE_ALIGNMENT.LEFT
    remove_table_borders(info_table)

    # Column widths: left=7cm, right=7cm, photo=3.5cm
    for row in info_table.rows:
        set_cell_width(row.cells[0], 7.0)
        set_cell_width(row.cells[1], 7.0)
        set_cell_width(row.cells[2], 3.5)

    left_cell = info_table.cell(0, 0)
    right_cell = info_table.cell(0, 1)
    photo_cell = info_table.cell(0, 2)

    # Set all cells to top alignment and zero margins
    for cell in [left_cell, right_cell, photo_cell]:
        set_cell_margins(cell, top=0, bottom=0, left=0, right=0)
        tc = cell._tc
        tcPr = tc.get_or_add_tcPr()
        vAlign = parse_xml(f'<w:vAlign {nsdecls("w")} w:val="top"/>')
        existing = tcPr.find(qn('w:vAlign'))
        if existing is not None:
            tcPr.remove(existing)
        tcPr.append(vAlign)

    # Left column fields
    left_fields = [
        ('姓       名', data.get('name', '')),
        ('出生年月', data.get('birth', '')),
        ('专       业', data.get('major', '')),
        ('毕业院校', data.get('university', '')),
        ('联系电话', data.get('phone', '')),
    ]
    right_fields = [
        ('性       别', data.get('gender', '')),
        ('类       型', data.get('type', '')),
        ('现居住地', data.get('location', '')),
        ('时       间', data.get('graduation_year', '')),
        ('邮       箱', data.get('email', '')),
    ]

    # Clear default paragraph and add fields
    def add_info_fields(cell, fields):
        first = True
        for label, value in fields:
            if not value:
                continue
            if first:
                p = cell.paragraphs[0]
                first = False
            else:
                p = cell.add_paragraph()
            set_paragraph_spacing(p, before=3, after=1)
            add_run(p, f'{label}：', '微软雅黑', 9.5, color=TEXT_COLOR)
            add_run(p, value, '微软雅黑', 9.5, color=TEXT_COLOR)

    add_info_fields(left_cell, left_fields)
    add_info_fields(right_cell, right_fields)

    # Photo placeholder
    p = photo_cell.paragraphs[0]
    set_paragraph_spacing(p, before=0, after=0)
    photo_path = data.get('photo_path', '')
    if photo_path and os.path.exists(photo_path):
        run = p.add_run()
        run.add_picture(photo_path, width=Cm(2.8), height=Cm(3.8))
    else:
        add_run(p, '[照片]', '微软雅黑', 9, color=TEXT_LIGHT)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # ── Render Sections ──
    for section_data in sections:
        title = section_data['title']
        items = section_data['items']

        # Section header
        if title:
            p = doc.add_paragraph()
            set_paragraph_spacing(p, before=4, after=2)
            add_run(p, title, '黑体', 14, bold=True, color=SECTION_COLOR)

        # Section content
        for item in items:
            item = item.strip()
            if not item:
                continue

            # Project title with time: **项目名**（时间）
            if item.startswith('**') and '**' in item[2:]:
                match = re.match(r'\*\*(.+?)\*\*(.*)', item)
                if match:
                    bold_text = match.group(1)
                    rest = match.group(2).strip()
                    time_match = re.search(r'[（(][\d.]+[-~][^)）]*[)）]', rest)
                    if time_match:
                        time_str = time_match.group()
                        desc = rest[:time_match.start()].strip()
                        p = doc.add_paragraph()
                        set_paragraph_spacing(p, before=3, after=1)
                        # Add tab stop at right margin for time alignment
                        tab_stops = p.paragraph_format.tab_stops
                        tab_stops.add_tab_stop(Cm(19.0), WD_TAB_ALIGNMENT.RIGHT)
                        add_run(p, bold_text, '微软雅黑', 9.5, bold=True, color=TEXT_COLOR)
                        if desc:
                            add_run(p, desc, '微软雅黑', 9.5, color=TEXT_COLOR)
                        add_run(p, f'\t{time_str}', '微软雅黑', 9, color=TEXT_COLOR)
                        continue

            # "技术栈：" line
            if item.startswith('技术栈') or item.startswith('Tech Stack'):
                p = doc.add_paragraph()
                set_paragraph_spacing(p, before=1, after=0.5)
                text = item
                add_run(p, text[:4], '微软雅黑', 9.5, bold=True, color=TEXT_COLOR)
                add_run(p, text[4:], '微软雅黑', 9.5, color=TEXT_COLOR)
                continue

            # "项目背景：" line
            if item.startswith('项目背景'):
                p = doc.add_paragraph()
                set_paragraph_spacing(p, before=1, after=0.5)
                add_run(p, '项目背景', '微软雅黑', 9.5, bold=True, color=TEXT_COLOR)
                _add_formatted_text(p, item[4:], '微软雅黑', 9.5, TEXT_COLOR)
                continue

            # "主要工作：" header
            if item == '主要工作：' or item == '主要工作:':
                p = doc.add_paragraph()
                set_paragraph_spacing(p, before=1, after=0.5)
                add_run(p, '主要工作：', '微软雅黑', 9.5, bold=True, color=TEXT_COLOR)
                continue

            # Numbered items (1. 2. 3. ...) with bold number, consistent indent
            num_match = re.match(r'^(\d+)[.\、](.+)', item)
            if num_match:
                num = num_match.group(1)
                text = num_match.group(2).strip()
                p = doc.add_paragraph()
                set_paragraph_spacing(p, before=0, after=0.5)
                p.paragraph_format.left_indent = Cm(0.45)
                p.paragraph_format.first_line_indent = Cm(-0.45)
                add_run(p, f'{num}.', '微软雅黑', 9.5, bold=True, color=TEXT_COLOR)
                _add_formatted_text(p, text, '微软雅黑', 9.5, TEXT_COLOR)
                continue

            # Skills category: **大模型：**xxx
            if item.startswith('**') and '：' in item[:20]:
                match = re.match(r'\*\*(.+?：)\*\*(.*)', item)
                if match:
                    cat = match.group(1)
                    desc = match.group(2)
                    p = doc.add_paragraph()
                    set_paragraph_spacing(p, before=0, after=0.5)
                    add_run(p, cat, '微软雅黑', 9.5, bold=True, color=TEXT_COLOR)
                    _add_formatted_text(p, desc, '微软雅黑', 9.5, TEXT_COLOR)
                    continue

            # Bullet points - same left edge as numbered items
            if item.startswith('- ') or item.startswith('* '):
                text = item[2:]
                p = doc.add_paragraph()
                set_paragraph_spacing(p, before=0, after=0.5)
                p.paragraph_format.left_indent = Cm(0.45)
                p.paragraph_format.first_line_indent = Cm(-0.45)
                add_run(p, '  \u2022 ', '微软雅黑', 9.5, color=TEXT_COLOR)
                _add_formatted_text(p, text, '微软雅黑', 9.5, TEXT_COLOR)
                continue

            # Regular text with inline bold - no indent, aligns with section headers
            p = doc.add_paragraph()
            set_paragraph_spacing(p, before=0, after=0.5)
            _add_formatted_text(p, item, '微软雅黑', 9.5, TEXT_COLOR)

    # ── Bottom decorative bar ──
    add_teal_bar(doc, 'bottom')

    doc.save(output_path)
    return output_path


# ─── Report Generator ──────────────────────────────────────────
def generate_report(data, output_path):
    """Generate a multi-page report."""
    doc = Document()

    for section in doc.sections:
        section.page_width = Cm(21.0)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(2.0)
        section.bottom_margin = Cm(2.0)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    title = data.get('title', '')
    content = data.get('content', '')
    sections = parse_sections(content)

    # Title
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_paragraph_spacing(p, before=0, after=6)
    add_run(p, title, '微软雅黑', 22, bold=True, color=SECTION_COLOR)

    # Divider
    p = doc.add_paragraph()
    set_paragraph_spacing(p, before=0, after=4)
    pPr = p._p.get_or_add_pPr()
    pBdr = parse_xml(
        f'<w:pBdr {nsdecls("w")}>'
        f'  <w:bottom w:val="single" w:sz="12" w:space="1" w:color="224460"/>'
        f'</w:pBdr>'
    )
    pPr.append(pBdr)

    for section_data in sections:
        title_text = section_data['title']
        items = section_data['items']
        level = section_data.get('level', 1)

        if title_text:
            p = doc.add_paragraph()
            font_size = 16 if level <= 1 else 13
            set_paragraph_spacing(p, before=6 if level <= 1 else 4, after=2)
            add_run(p, title_text, '微软雅黑', font_size, bold=True, color=SECTION_COLOR)
            if level <= 1:
                pPr = p._p.get_or_add_pPr()
                pBdr = parse_xml(
                    f'<w:pBdr {nsdecls("w")}>'
                    f'  <w:bottom w:val="single" w:sz="8" w:space="1" w:color="224460"/>'
                    f'</w:pBdr>'
                )
                pPr.append(pBdr)

        for item in items:
            item = item.strip()
            if not item:
                continue
            p = doc.add_paragraph()
            set_paragraph_spacing(p, before=0, after=2, line_spacing=18)

            if item.startswith('- ') or item.startswith('* '):
                text = item[2:]
                p.paragraph_format.left_indent = Cm(0.8)
                p.paragraph_format.first_line_indent = Cm(-0.4)
                add_run(p, '\u2022  ', '微软雅黑', 11, color=TEAL)
                _add_formatted_text(p, text, '微软雅黑', 11, TEXT_COLOR)
            elif re.match(r'^\d+[\.\)] ', item):
                text = re.sub(r'^\d+[\.\)] ', '', item)
                num = re.match(r'^(\d+)', item).group(1)
                p.paragraph_format.left_indent = Cm(0.8)
                p.paragraph_format.first_line_indent = Cm(-0.4)
                add_run(p, f'{num}. ', '微软雅黑', 11, bold=True, color=TEAL)
                _add_formatted_text(p, text, '微软雅黑', 11, TEXT_COLOR)
            else:
                _add_formatted_text(p, item, '微软雅黑', 11, TEXT_COLOR)

    doc.save(output_path)
    return output_path


# ─── Section Parser ────────────────────────────────────────────
def parse_sections(content):
    sections = []
    current = None
    for line in content.split('\n'):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith('## '):
            if current:
                sections.append(current)
            current = {'title': stripped[3:], 'items': [], 'level': 1}
        elif stripped.startswith('### '):
            if current:
                sections.append(current)
            current = {'title': stripped[4:], 'items': [], 'level': 2}
        elif stripped.startswith('# '):
            if current:
                sections.append(current)
            current = {'title': stripped[2:], 'items': [], 'level': 1}
        elif re.match(r'^\*\*(.+?)\*\*$', stripped) and len(stripped) < 80:
            if current:
                sections.append(current)
            current = {'title': stripped[2:-2], 'items': []}
        else:
            if current is None:
                current = {'title': '', 'items': []}
            current['items'].append(stripped)
    if current:
        sections.append(current)
    return sections


# ─── Smart Detection ────────────────────────────────────────────
def detect_document_type(data):
    content = data.get('content', '')
    has_resume_fields = any([data.get('phone'), data.get('email'), data.get('position'),
                            data.get('birth'), data.get('major'), data.get('university')])
    resume_kw = ['教育', '工作', '项目', '技能', '经历', '实习', '获奖', '证书',
                 '精通技能', '综合能力', '个人信息',
                 'education', 'experience', 'project', 'skill', 'work']
    content_lower = content.lower()
    has_resume_sections = sum(1 for kw in resume_kw if kw in content_lower) >= 2
    return 'resume' if (has_resume_fields or has_resume_sections) else 'report'


# ─── Main ──────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print('Usage: word_generator.py <data.json> <output.docx>')
        sys.exit(1)

    data_file = sys.argv[1]
    output = sys.argv[2]

    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    try:
        os.remove(data_file)
    except:
        pass

    doc_type = detect_document_type(data)
    if doc_type == 'resume':
        generate_resume(data, output)
    else:
        generate_report(data, output)

    print('OK:' + output)


if __name__ == '__main__':
    main()
