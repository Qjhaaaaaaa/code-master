# -*- coding: utf-8 -*-
"""
Professional resume/report PDF generator using reportlab.
Matches the exact layout of reference Chinese resumes:
- Top/bottom dark teal decorative bars
- Photo placeholder in top-right
- Personal info in dual-column layout
- Section headers: SimHei 14pt, color #214361
- Body: MicrosoftYaHei 9.5pt
- Project titles bold + time right-aligned
- Numbered work items with bold numbers
- Skills with bold category labels
"""
import sys, os, json, re
sys.stdout.reconfigure(encoding='utf-8')

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether, Flowable, BaseDocTemplate,
    PageTemplate, Frame, NextPageTemplate
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ─── Colors ────────────────────────────────────────────────────
TEAL = HexColor('#224460')
SECTION_COLOR = HexColor('#214361')
TEXT_COLOR = HexColor('#0F1115')
TEXT_LIGHT = HexColor('#555555')
WHITE = HexColor('#FFFFFF')

WINDIR = os.environ.get('WINDIR', r'C:\Windows')
FONTS_DIR = os.path.join(WINDIR, 'Fonts')


# ─── Font Registration ─────────────────────────────────────────
def register_fonts():
    """Register SimHei and MicrosoftYaHei fonts."""
    font_map = {
        'SimHei': [
            os.path.join(FONTS_DIR, 'simhei.ttf'),
        ],
        'YaHei': [
            os.path.join(FONTS_DIR, 'msyh.ttc'),
            os.path.join(FONTS_DIR, 'msyh.ttf'),
        ],
        'YaHeiBold': [
            os.path.join(FONTS_DIR, 'msyhbd.ttc'),
            os.path.join(FONTS_DIR, 'msyhbd.ttf'),
        ],
    }

    registered = {}
    for name, paths in font_map.items():
        for fp in paths:
            if os.path.exists(fp):
                try:
                    pdfmetrics.registerFont(TTFont(name, fp))
                    registered[name] = True
                    break
                except:
                    continue

    # Fallbacks
    if 'SimHei' not in registered:
        if 'YaHei' in registered:
            registered['SimHei'] = True  # Use YaHei as fallback
        else:
            registered['SimHei'] = False
    if 'YaHei' not in registered:
        registered['YaHei'] = registered.get('SimHei', False)
    if 'YaHeiBold' not in registered:
        registered['YaHeiBold'] = registered.get('YaHei', False)

    return registered


# ─── Custom Flowables ──────────────────────────────────────────
class TealBar(Flowable):
    """A colored bar (decorative top/bottom strip)."""
    def __init__(self, width, height, color=TEAL):
        super().__init__()
        self.width = width
        self.height = height
        self.bar_color = color

    def draw(self):
        self.canv.setFillColor(self.bar_color)
        self.canv.rect(0, 0, self.width, self.height, fill=1, stroke=0)


class PhotoPlaceholder(Flowable):
    """A photo placeholder rectangle."""
    def __init__(self, width=28*mm, height=38*mm):
        super().__init__()
        self.width = width
        self.height = height

    def draw(self):
        self.canv.setStrokeColor(HexColor('#cccccc'))
        self.canv.setFillColor(HexColor('#f0f0f0'))
        self.canv.rect(0, 0, self.width, self.height, fill=1, stroke=1)
        self.canv.setFillColor(HexColor('#999999'))
        self.canv.setFont('YaHei', 8)
        self.canv.drawCentredString(self.width/2, self.height/2, '照片')


class SectionHeader(Flowable):
    """Section header with colored left bar."""
    def __init__(self, text, width, font_name='SimHei'):
        super().__init__()
        self.text = text
        self.full_width = width
        self.font_name = font_name
        self.width = width
        self.height = 5*mm

    def draw(self):
        c = self.canv
        # Section title
        c.setFillColor(SECTION_COLOR)
        c.setFont(self.font_name, 13)
        c.drawString(0, 1*mm, self.text)


# ─── Resume PDF Generator ─────────────────────────────────────
def generate_resume(data, output_path):
    """Generate a professional resume PDF matching reference layout."""
    fonts = register_fonts()

    heiti = 'SimHei' if fonts.get('SimHei') else 'YaHei'
    yahei = 'YaHei' if fonts.get('YaHei') else 'Helvetica'
    yahei_bold = 'YaHeiBold' if fonts.get('YaHeiBold') else yahei

    page_w, page_h = A4
    margin_lr = 12*mm
    margin_top = 8*mm
    margin_bottom = 6*mm

    # ── Build document with canvas callbacks for decorative bars ──
    doc = BaseDocTemplate(
        output_path,
        pagesize=A4,
        topMargin=margin_top,
        bottomMargin=margin_bottom,
        leftMargin=margin_lr,
        rightMargin=margin_lr,
    )

    usable_w = page_w - 2 * margin_lr

    # Page template with decorative bars
    def on_page(canvas, doc):
        canvas.saveState()
        # Top bar
        canvas.setFillColor(TEAL)
        canvas.rect(-margin_lr, page_h - 6*mm, page_w, 6*mm, fill=1, stroke=0)
        # Bottom bar
        canvas.rect(-margin_lr, -2*mm, page_w, 6*mm, fill=1, stroke=0)
        canvas.restoreState()

    frame = Frame(margin_lr, margin_bottom, usable_w, page_h - margin_top - margin_bottom,
                  id='main', topPadding=2*mm, bottomPadding=0,
                  leftPadding=0, rightPadding=0)
    doc.addPageTemplates([PageTemplate(id='resume', frames=[frame], onPage=on_page)])

    story = []

    # ── Styles (compact to fit single page, all left-aligned at x=0) ──
    contact_style = ParagraphStyle('Contact', fontName=yahei, fontSize=9.5,
                                    textColor=TEXT_COLOR, leading=13,
                                    leftIndent=0, firstLineIndent=0)
    body_style = ParagraphStyle('Body', fontName=yahei, fontSize=9.5,
                                 textColor=TEXT_COLOR, leading=13, spaceAfter=0.5*mm,
                                 leftIndent=0, firstLineIndent=0)
    bullet_style = ParagraphStyle('Bullet', fontName=yahei, fontSize=9.5,
                                   textColor=TEXT_COLOR, leading=13,
                                   leftIndent=12, firstLineIndent=-12, spaceAfter=0.3*mm)
    proj_title_style = ParagraphStyle('ProjTitle', fontName=yahei_bold, fontSize=9.5,
                                       textColor=TEXT_COLOR, leading=13, spaceBefore=1.5*mm,
                                       leftIndent=0, firstLineIndent=0)
    proj_time_style = ParagraphStyle('ProjTime', fontName=yahei, fontSize=9,
                                      textColor=TEXT_COLOR, leading=13, alignment=TA_RIGHT)
    tech_style = ParagraphStyle('Tech', fontName=yahei, fontSize=9.5,
                                 textColor=TEXT_COLOR, leading=13, spaceAfter=0.3*mm,
                                 leftIndent=0, firstLineIndent=0)

    # ── Parse sections from content ──
    content = data.get('content', '')
    sections = parse_sections(content)

    # ── Personal Info Area (photo + info dual-column) ──
    name = data.get('name', data.get('title', ''))

    # Build left column info
    left_info = []
    right_info = []
    info_fields_left = [
        ('姓       名', data.get('name', '')),
        ('出生年月', data.get('birth', '')),
        ('专       业', data.get('major', '')),
        ('毕业院校', data.get('university', '')),
        ('联系电话', data.get('phone', '')),
    ]
    info_fields_right = [
        ('性       别', data.get('gender', '')),
        ('类       型', data.get('type', '')),
        ('现居住地', data.get('location', '')),
        ('时       间', data.get('graduation_year', '')),
        ('邮       箱', data.get('email', '')),
    ]

    # Only include non-empty fields
    left_rows = [[f'{k}：{v}'] for k, v in info_fields_left if v]
    right_rows = [[f'{k}：{v}'] for k, v in info_fields_right if v]

    # Photo placeholder
    photo_path = data.get('photo_path', '')
    if photo_path and os.path.exists(photo_path):
        from reportlab.lib.utils import ImageReader
        photo_flowable = ImageReader(photo_path)
    else:
        photo_flowable = None

    # Build personal info table - all content left-aligned at same x
    info_col_w = usable_w * 0.40
    photo_col_w = usable_w * 0.20

    left_cell_paras = []
    for row in left_rows:
        left_cell_paras.append(Paragraph(row[0], contact_style))
        left_cell_paras.append(Spacer(1, 1.5*mm))

    right_cell_paras = []
    for row in right_rows:
        right_cell_paras.append(Paragraph(row[0], contact_style))
        right_cell_paras.append(Spacer(1, 1.5*mm))

    left_cell_content = left_cell_paras
    right_cell_content = right_cell_paras

    # Photo cell
    if photo_flowable:
        from reportlab.platypus import Image
        photo_img = Image(photo_path, width=28*mm, height=38*mm)
        photo_cell = [photo_img]
    else:
        photo_cell = [PhotoPlaceholder(28*mm, 38*mm)]

    info_table = Table(
        [[left_cell_content, right_cell_content, photo_cell]],
        colWidths=[info_col_w, info_col_w, photo_col_w],
        rowHeights=None,
    )
    info_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))

    story.append(info_table)
    story.append(Spacer(1, 1*mm))

    # ── Render Sections ──
    for section in sections:
        title = section['title']
        items = section['items']

        # Section header
        if title:
            header = SectionHeader(title, usable_w, heiti)
            story.append(header)
            story.append(Spacer(1, 0.5*mm))

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
                    # Check if rest contains time pattern like （2025.07-至今）
                    time_match = re.search(r'[（(][\d.]+[-~][^)）]*[)）]', rest)
                    if time_match:
                        time_str = time_match.group()
                        desc = rest[:time_match.start()].strip()
                        # Use table for title + time alignment
                        title_para = Paragraph(
                            f'<font name="{yahei_bold}">{bold_text}</font>'
                            f'<font name="{yahei}">{desc}</font>',
                            proj_title_style
                        )
                        time_para = Paragraph(time_str, proj_time_style)
                        t = Table([[title_para, time_para]],
                                  colWidths=[usable_w*0.82, usable_w*0.18])
                        t.setStyle(TableStyle([
                            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                            ('LEFTPADDING', (0, 0), (-1, -1), 0),
                            ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                            ('TOPPADDING', (0, 0), (-1, -1), 0),
                            ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                        ]))
                        story.append(t)
                        continue

                # Regular bold text line
                story.append(Paragraph(item, body_style))
                continue

            # "技术栈：" line
            if item.startswith('技术栈') or item.startswith('Tech Stack'):
                text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', item)
                story.append(Paragraph(f'<font name="{yahei_bold}">{text[:4]}</font>{text[4:]}', tech_style))
                continue

            # "项目背景：" line
            if item.startswith('项目背景'):
                text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', item)
                story.append(Paragraph(f'<font name="{yahei_bold}">项目背景</font>{text[4:]}', body_style))
                continue

            # "主要工作：" header
            if item == '主要工作：' or item == '主要工作:':
                story.append(Paragraph(f'<font name="{yahei_bold}">主要工作：</font>', body_style))
                continue

            # Numbered items (1. 2. 3. ...) with bold number, indented under "主要工作"
            num_match = re.match(r'^(\d+)[.\、](.+)', item)
            if num_match:
                num = num_match.group(1)
                text = num_match.group(2).strip()
                text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', text)
                # Indent: number starts at ~14pt from left, text follows
                indent_style = ParagraphStyle('NumItem', parent=body_style,
                                              leftIndent=14, firstLineIndent=-14)
                para = Paragraph(
                    f'<font name="{yahei_bold}">{num}.</font> {text}',
                    indent_style
                )
                story.append(para)
                continue

            # Skills category: **大模型：**xxx or **大模型：**xxx
            if item.startswith('**'):
                match = re.match(r'\*\*(.+?)\*\*(.*)', item)
                if match and '：' in match.group(1)[:20]:
                    cat = match.group(1)
                    desc = match.group(2)
                    desc = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', desc)
                    story.append(Paragraph(
                        f'<font name="{yahei_bold}">{cat}</font>{desc}',
                        body_style
                    ))
                    continue

            # Bullet points
            if item.startswith('- ') or item.startswith('* '):
                text = item[2:]
                text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', text)
                story.append(Paragraph(text, body_style))
                continue

            # Regular text with inline bold
            text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', item)
            story.append(Paragraph(text, body_style))

    doc.build(story)
    return output_path


# ─── Report PDF Generator ──────────────────────────────────────
def generate_report(data, output_path):
    """Generate a multi-page report PDF."""
    fonts = register_fonts()
    heiti = 'SimHei' if fonts.get('SimHei') else 'YaHei'
    yahei = 'YaHei' if fonts.get('YaHei') else 'Helvetica'
    yahei_bold = 'YaHeiBold' if fonts.get('YaHeiBold') else yahei

    page_w, page_h = A4
    margin = 20*mm
    usable_w = page_w - 2 * margin

    doc = BaseDocTemplate(
        output_path, pagesize=A4,
        topMargin=margin, bottomMargin=margin,
        leftMargin=margin, rightMargin=margin,
    )

    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(TEAL)
        canvas.rect(-margin, page_h - 5*mm, page_w, 5*mm, fill=1, stroke=0)
        canvas.rect(-margin, -1*mm, page_w, 5*mm, fill=1, stroke=0)
        canvas.restoreState()

    frame = Frame(margin, margin, usable_w, page_h - 2*margin, id='main')
    doc.addPageTemplates([PageTemplate(id='report', frames=[frame], onPage=on_page)])

    story = []
    content = data.get('content', '')
    title = data.get('title', '')
    sections = parse_sections(content)

    title_style = ParagraphStyle('Title', fontName=yahei_bold, fontSize=22,
                                  textColor=SECTION_COLOR, leading=28, alignment=TA_CENTER,
                                  spaceAfter=6*mm)
    h1_style = ParagraphStyle('H1', fontName=yahei_bold, fontSize=16,
                               textColor=SECTION_COLOR, leading=22,
                               spaceBefore=6*mm, spaceAfter=3*mm)
    h2_style = ParagraphStyle('H2', fontName=yahei_bold, fontSize=13,
                               textColor=TEXT_COLOR, leading=18,
                               spaceBefore=4*mm, spaceAfter=2*mm)
    body_style = ParagraphStyle('Body', fontName=yahei, fontSize=11,
                                 textColor=TEXT_COLOR, leading=18, spaceAfter=2*mm)
    bullet_style = ParagraphStyle('Bullet', fontName=yahei, fontSize=11,
                                   textColor=TEXT_COLOR, leading=18,
                                   leftIndent=8*mm, firstLineIndent=-5*mm, spaceAfter=1*mm)

    # Title
    story.append(Spacer(1, 4*mm))
    story.append(Paragraph(title, title_style))
    story.append(HRFlowable(width='100%', thickness=1.5, color=TEAL,
                             spaceBefore=0, spaceAfter=4*mm))

    for section in sections:
        if section['title']:
            level = section.get('level', 1)
            style = h1_style if level <= 1 else h2_style
            story.append(Paragraph(section['title'], style))

        for item in section['items']:
            item = item.strip()
            if not item:
                continue
            if item.startswith('- ') or item.startswith('* '):
                text = item[2:]
                text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', text)
                story.append(Paragraph(f'\u2022  {text}', bullet_style))
            else:
                text = re.sub(r'\*\*(.+?)\*\*', rf'<font name="{yahei_bold}">\1</font>', item)
                story.append(Paragraph(text, body_style))

    doc.build(story)
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
        print('Usage: pdf_generator.py <data.json> <output.pdf>')
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
