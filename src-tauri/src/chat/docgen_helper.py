"""conduit_docgen — styled document builders for the generate_document tool.

This module is placed on the Python path automatically for every
``generate_document`` run. Import it to produce professionally themed DOCX and
PPTX files without hand-writing low-level python-docx / python-pptx styling.
Everything is saved to the path in the ``CONDUIT_OUTPUT`` environment variable.

DOCX
----
    import conduit_docgen as cd
    doc = cd.Doc(title="Quarterly Report", subtitle="FY2025 · Q2", theme="blue")
    doc.heading("Overview")
    doc.paragraph("Body text ...")
    doc.bullets(["First point", "Second point"])
    doc.numbered(["Step one", "Step two"])
    doc.table(["Metric", "Value"], [["Revenue", "$1.2M"], ["Growth", "18%"]])
    doc.callout("Key takeaway goes here.")
    doc.save()

PPTX
----
    import conduit_docgen as cd
    deck = cd.Deck(title="Product Launch", subtitle="2025 Roadmap", theme="blue")
    deck.section("Introduction")
    deck.bullets("Why now?", ["Market ready", "Tech mature"])
    deck.two_column("Comparison", "Option A", ["fast", "cheap"],
                    "Option B", ["robust", "scalable"])
    deck.table_slide("Numbers", ["Q", "Rev"], [["Q1", "1.0"], ["Q2", "1.2"]])
    deck.closing("Thank you", "questions@example.com")
    deck.save()

Available themes: "blue" (default), "slate", "emerald", "plum", "amber".
You may still drop down to raw python-docx / python-pptx on the objects
(``doc.document`` / ``deck.prs``) for anything the helpers don't cover.
"""

import os

# ---------------------------------------------------------------------------
# Themes: (primary, dark, light-accent, text) as hex strings.
# ---------------------------------------------------------------------------
THEMES = {
    "blue":    {"primary": "2563EB", "dark": "1E3A8A", "accent": "DBEAFE", "text": "1F2937"},
    "slate":   {"primary": "475569", "dark": "1E293B", "accent": "E2E8F0", "text": "0F172A"},
    "emerald": {"primary": "059669", "dark": "064E3B", "accent": "D1FAE5", "text": "1F2937"},
    "plum":    {"primary": "7C3AED", "dark": "4C1D95", "accent": "EDE9FE", "text": "1F2937"},
    "amber":   {"primary": "D97706", "dark": "92400E", "accent": "FEF3C7", "text": "1F2937"},
}

HEAD_FONT = "Calibri"
BODY_FONT = "Calibri"


def _theme(name):
    return THEMES.get((name or "blue").lower(), THEMES["blue"])


def _out_path(fallback):
    return os.environ.get("CONDUIT_OUTPUT", fallback)


# ===========================================================================
# DOCX
# ===========================================================================
class Doc:
    def __init__(self, title="", subtitle="", theme="blue", author=""):
        from docx import Document
        from docx.shared import Pt, RGBColor, Inches

        self.document = Document()
        self.t = _theme(theme)
        self._Pt = Pt
        self._RGB = RGBColor
        self._Inches = Inches

        # Base body style.
        normal = self.document.styles["Normal"]
        normal.font.name = BODY_FONT
        normal.font.size = Pt(11)
        normal.font.color.rgb = RGBColor.from_string(self.t["text"])
        pf = normal.paragraph_format
        pf.space_after = Pt(6)
        pf.line_spacing = 1.15

        if title:
            self._cover(title, subtitle, author)

    # -- internal helpers ---------------------------------------------------
    def _rgb(self, hexstr):
        return self._RGB.from_string(hexstr)

    def _shade(self, cell, hexstr):
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement
        tcpr = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:fill"), hexstr)
        tcpr.append(shd)

    def _cover(self, title, subtitle, author):
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        Pt = self._Pt

        # Accent bar.
        bar = self.document.add_paragraph()
        bar.paragraph_format.space_after = Pt(2)
        r = bar.add_run("▍" * 12)
        r.font.color.rgb = self._rgb(self.t["primary"])
        r.font.size = Pt(14)

        p = self.document.add_paragraph()
        p.paragraph_format.space_before = Pt(24)
        p.paragraph_format.space_after = Pt(4)
        run = p.add_run(title)
        run.bold = True
        run.font.name = HEAD_FONT
        run.font.size = Pt(30)
        run.font.color.rgb = self._rgb(self.t["dark"])

        if subtitle:
            sp = self.document.add_paragraph()
            sr = sp.add_run(subtitle)
            sr.font.size = Pt(15)
            sr.font.color.rgb = self._rgb(self.t["primary"])

        meta = []
        if author:
            meta.append(author)
        import datetime
        meta.append(datetime.date.today().strftime("%B %d, %Y"))
        mp = self.document.add_paragraph()
        mr = mp.add_run("   ·   ".join(meta))
        mr.font.size = Pt(10)
        mr.italic = True
        mr.font.color.rgb = self._rgb("6B7280")

        self.document.add_paragraph()  # spacing under the cover block

    # -- public API ---------------------------------------------------------
    def heading(self, text, level=1):
        Pt = self._Pt
        p = self.document.add_paragraph()
        pf = p.paragraph_format
        pf.space_before = Pt(14 if level == 1 else 10)
        pf.space_after = Pt(4)
        run = p.add_run(text)
        run.bold = True
        run.font.name = HEAD_FONT
        run.font.size = Pt(18 if level == 1 else 14)
        run.font.color.rgb = self._rgb(self.t["dark"] if level == 1 else self.t["primary"])
        return p

    def paragraph(self, text):
        return self.document.add_paragraph(text)

    def bullets(self, items):
        for it in items:
            self.document.add_paragraph(str(it), style="List Bullet")

    def numbered(self, items):
        for it in items:
            self.document.add_paragraph(str(it), style="List Number")

    def callout(self, text):
        """A shaded single-cell box for a highlighted note."""
        table = self.document.add_table(rows=1, cols=1)
        cell = table.cell(0, 0)
        self._shade(cell, self.t["accent"])
        cell.paragraphs[0].text = ""
        run = cell.paragraphs[0].add_run(text)
        run.bold = True
        run.font.color.rgb = self._rgb(self.t["dark"])
        return table

    def table(self, headers, rows):
        Pt = self._Pt
        table = self.document.add_table(rows=1, cols=len(headers))
        table.style = "Table Grid"
        hdr = table.rows[0].cells
        for i, h in enumerate(headers):
            self._shade(hdr[i], self.t["primary"])
            para = hdr[i].paragraphs[0]
            para.text = ""
            run = para.add_run(str(h))
            run.bold = True
            run.font.color.rgb = self._rgb("FFFFFF")
            run.font.size = Pt(11)
        for ri, row in enumerate(rows):
            cells = table.add_row().cells
            for ci, val in enumerate(row):
                if ci < len(cells):
                    cells[ci].text = str(val)
                    if ri % 2 == 1:
                        self._shade(cells[ci], self.t["accent"])
        return table

    def page_break(self):
        self.document.add_page_break()

    def save(self, path=None):
        self.document.save(_out_path(path or "document.docx"))


# ===========================================================================
# PPTX
# ===========================================================================
class Deck:
    def __init__(self, title="", subtitle="", theme="blue", footer=""):
        from pptx import Presentation
        from pptx.util import Inches, Pt, Emu
        from pptx.dml.color import RGBColor
        from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

        self.prs = Presentation()
        self.prs.slide_width = Inches(13.333)
        self.prs.slide_height = Inches(7.5)
        self.t = _theme(theme)
        self.footer = footer
        self._Inches = Inches
        self._Pt = Pt
        self._RGB = RGBColor
        self._PP_ALIGN = PP_ALIGN
        self._ANCHOR = MSO_ANCHOR
        self._blank = self.prs.slide_layouts[6]

        if title:
            self.title_slide(title, subtitle)

    # -- internal helpers ---------------------------------------------------
    def _rgb(self, hexstr):
        return self._RGB.from_string(hexstr)

    def _slide(self):
        return self.prs.slides.add_slide(self._blank)

    def _rect(self, slide, x, y, w, h, fill):
        from pptx.enum.shapes import MSO_SHAPE
        shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
        shp.fill.solid()
        shp.fill.fore_color.rgb = self._rgb(fill)
        shp.line.fill.background()
        shp.shadow.inherit = False
        return shp

    def _text(self, slide, x, y, w, h, text, size, color, bold=False,
              align=None, anchor=None):
        box = slide.shapes.add_textbox(x, y, w, h)
        tf = box.text_frame
        tf.word_wrap = True
        if anchor is not None:
            tf.vertical_anchor = anchor
        p = tf.paragraphs[0]
        if align is not None:
            p.alignment = align
        run = p.add_run()
        run.text = text
        run.font.size = self._Pt(size)
        run.font.bold = bold
        run.font.name = HEAD_FONT
        run.font.color.rgb = self._rgb(color)
        return box

    def _footer(self, slide, index):
        Inches, Pt = self._Inches, self._Pt
        if self.footer:
            self._text(slide, Inches(0.4), Inches(7.0), Inches(9), Inches(0.4),
                       self.footer, 10, "9CA3AF")
        self._text(slide, Inches(12.4), Inches(7.0), Inches(0.7), Inches(0.4),
                   str(index), 10, "9CA3AF", align=self._PP_ALIGN.RIGHT)

    def _title_bar(self, slide, title):
        Inches = self._Inches
        self._rect(slide, 0, 0, self.prs.slide_width, Inches(1.15), self.t["primary"])
        self._text(slide, Inches(0.6), Inches(0.15), Inches(12), Inches(0.85),
                   title, 28, "FFFFFF", bold=True, anchor=self._ANCHOR.MIDDLE)

    def _bullets_frame(self, slide, items, top=None):
        Inches, Pt = self._Inches, self._Pt
        box = slide.shapes.add_textbox(Inches(0.7), top or Inches(1.5),
                                       Inches(12), Inches(5.2))
        tf = box.text_frame
        tf.word_wrap = True
        for i, it in enumerate(items):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.text = "•  " + str(it)
            p.space_after = Pt(10)
            for run in p.runs:
                run.font.size = Pt(20)
                run.font.name = BODY_FONT
                run.font.color.rgb = self._rgb(self.t["text"])
        return box

    # -- public API ---------------------------------------------------------
    def title_slide(self, title, subtitle=""):
        Inches = self._Inches
        slide = self._slide()
        self._rect(slide, 0, 0, self.prs.slide_width, self.prs.slide_height, self.t["dark"])
        self._rect(slide, 0, Inches(5.1), self.prs.slide_width, Inches(0.18), self.t["primary"])
        self._text(slide, Inches(0.9), Inches(2.4), Inches(11.5), Inches(1.8),
                   title, 44, "FFFFFF", bold=True)
        if subtitle:
            self._text(slide, Inches(0.95), Inches(4.1), Inches(11.5), Inches(0.9),
                       subtitle, 22, "C7D2FE")
        return slide

    def section(self, title):
        Inches = self._Inches
        slide = self._slide()
        self._rect(slide, 0, 0, self.prs.slide_width, self.prs.slide_height, self.t["primary"])
        self._text(slide, Inches(0.9), Inches(3.0), Inches(11.5), Inches(1.5),
                   title, 40, "FFFFFF", bold=True, anchor=self._ANCHOR.MIDDLE)
        return slide

    def bullets(self, title, items):
        slide = self._slide()
        self._title_bar(slide, title)
        self._bullets_frame(slide, items)
        self._footer(slide, len(self.prs.slides._sldIdLst))
        return slide

    def two_column(self, title, left_head, left_items, right_head, right_items):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide()
        self._title_bar(slide, title)
        for x, head, items in (
            (Inches(0.7), left_head, left_items),
            (Inches(6.9), right_head, right_items),
        ):
            self._text(slide, x, Inches(1.5), Inches(5.7), Inches(0.6),
                       head, 22, self.t["primary"], bold=True)
            box = slide.shapes.add_textbox(x, Inches(2.2), Inches(5.7), Inches(4.4))
            tf = box.text_frame
            tf.word_wrap = True
            for i, it in enumerate(items):
                p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                p.text = "•  " + str(it)
                p.space_after = Pt(8)
                for run in p.runs:
                    run.font.size = Pt(18)
                    run.font.name = BODY_FONT
                    run.font.color.rgb = self._rgb(self.t["text"])
        self._footer(slide, len(self.prs.slides._sldIdLst))
        return slide

    def table_slide(self, title, headers, rows):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide()
        self._title_bar(slide, title)
        nrows, ncols = len(rows) + 1, len(headers)
        gt = slide.shapes.add_table(nrows, ncols, Inches(0.7), Inches(1.6),
                                    Inches(12), Inches(0.5 + 0.45 * nrows)).table
        for c, h in enumerate(headers):
            cell = gt.cell(0, c)
            cell.text = str(h)
            cell.fill.solid()
            cell.fill.fore_color.rgb = self._rgb(self.t["primary"])
            para = cell.text_frame.paragraphs[0]
            para.runs[0].font.bold = True
            para.runs[0].font.color.rgb = self._rgb("FFFFFF")
            para.runs[0].font.size = Pt(16)
        for r, row in enumerate(rows, start=1):
            for c in range(ncols):
                cell = gt.cell(r, c)
                cell.text = str(row[c]) if c < len(row) else ""
                cell.fill.solid()
                cell.fill.fore_color.rgb = self._rgb(
                    self.t["accent"] if r % 2 == 0 else "FFFFFF")
                if cell.text_frame.paragraphs[0].runs:
                    cell.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
                    cell.text_frame.paragraphs[0].runs[0].font.color.rgb = \
                        self._rgb(self.t["text"])
        self._footer(slide, len(self.prs.slides._sldIdLst))
        return slide

    def closing(self, title, subtitle=""):
        Inches = self._Inches
        slide = self._slide()
        self._rect(slide, 0, 0, self.prs.slide_width, self.prs.slide_height, self.t["dark"])
        self._text(slide, Inches(0.9), Inches(2.8), Inches(11.5), Inches(1.5),
                   title, 40, "FFFFFF", bold=True, anchor=self._ANCHOR.MIDDLE)
        if subtitle:
            self._text(slide, Inches(0.95), Inches(4.2), Inches(11.5), Inches(0.8),
                       subtitle, 20, "C7D2FE")
        return slide

    def save(self, path=None):
        self.prs.save(_out_path(path or "deck.pptx"))
