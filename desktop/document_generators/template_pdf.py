# -*- coding: utf-8 -*-
"""
PDF template filler using PyMuPDF (fitz).
Opens an existing PDF template and inserts text at specified coordinates.
"""
import sys, os, json
sys.stdout.reconfigure(encoding='utf-8')

import fitz


WINDIR = os.environ.get('WINDIR', r'C:\Windows')
FONTS_DIR = os.path.join(WINDIR, 'Fonts')

FONT_MAP = {
    'simhei': os.path.join(FONTS_DIR, 'simhei.ttf'),
    'msyh': os.path.join(FONTS_DIR, 'msyh.ttc'),
    'simsun': os.path.join(FONTS_DIR, 'simsun.ttc'),
    'yahei': os.path.join(FONTS_DIR, 'msyh.ttc'),
    'heiti': os.path.join(FONTS_DIR, 'simhei.ttf'),
    'songti': os.path.join(FONTS_DIR, 'simsun.ttc'),
}


def fill_pdf_template(data, output_path):
    """Fill a PDF template with text at specified positions.

    data fields:
        template_path: path to the template PDF
        fields: list of field definitions, each with:
            - page: page number (0-indexed)
            - x, y: position in points (72 points = 1 inch)
            - text: text to insert
            - size: font size (default 10)
            - font: font name (default 'msyh')
            - color: RGB tuple like [0, 0, 0] or hex string '#000000'
            - width: max width for text wrapping (optional)
            - bold: boolean (default False)
    """
    template_path = data.get('template_path', '')
    if not template_path or not os.path.exists(template_path):
        raise FileNotFoundError(f'Template not found: {template_path}')

    fields = data.get('fields', [])

    doc = fitz.open(template_path)

    for field in fields:
        page_num = field.get('page', 0)
        if page_num >= len(doc):
            continue

        page = doc[page_num]
        x = field.get('x', 0)
        y = field.get('y', 0)
        text = str(field.get('text', ''))
        size = field.get('size', 10)
        font_key = field.get('font', 'msyh').lower()
        color_val = field.get('color', [0, 0, 0])
        max_width = field.get('width', 0)
        bold = field.get('bold', False)

        # Resolve font
        font_file = FONT_MAP.get(font_key, FONT_MAP['msyh'])
        if not os.path.exists(font_file):
            font_file = FONT_MAP['msyh']

        # Resolve color
        if isinstance(color_val, str) and color_val.startswith('#'):
            r = int(color_val[1:3], 16) / 255
            g = int(color_val[3:5], 16) / 255
            b = int(color_val[5:7], 16) / 255
            color = (r, g, b)
        elif isinstance(color_val, (list, tuple)) and len(color_val) >= 3:
            if all(0 <= v <= 1 for v in color_val[:3]):
                color = tuple(color_val[:3])
            else:
                color = tuple(v / 255 for v in color_val[:3])
        else:
            color = (0, 0, 0)

        # Insert text
        if bold and 'msyh' in font_key:
            bold_font = os.path.join(FONTS_DIR, 'msyhbd.ttc')
            if os.path.exists(bold_font):
                font_file = bold_font

        if max_width > 0:
            # Multi-line text with wrapping
            rect = fitz.Rect(x, y, x + max_width, y + size * 50)
            page.insert_textbox(
                rect, text,
                fontsize=size,
                fontfile=font_file,
                fontname='zh',
                color=color,
                align=fitz.TEXT_ALIGN_LEFT,
            )
        else:
            # Single line text
            page.insert_text(
                (x, y), text,
                fontsize=size,
                fontfile=font_file,
                fontname='zh',
                color=color,
            )

    doc.save(output_path)
    doc.close()
    return output_path


# ─── Main ──────────────────────────────────────────────────────
def main():
    if len(sys.argv) < 3:
        print('Usage: template_pdf.py <data.json> <output.pdf>')
        sys.exit(1)

    data_file = sys.argv[1]
    output = sys.argv[2]

    with open(data_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    try:
        os.remove(data_file)
    except:
        pass

    fill_pdf_template(data, output)
    print('OK:' + output)


if __name__ == '__main__':
    main()
