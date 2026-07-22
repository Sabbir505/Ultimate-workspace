"""conduit_docgen — frontier-quality styled document builders.

Auto-placed on the Python path for every ``generate_document`` run. Import it to
produce professionally designed DOCX, PPTX and PDF files (the kind of output
ChatGPT / Claude / Gemini ship) with a handful of high-level calls, instead of
hand-writing low-level python-docx / python-pptx / reportlab styling.

Everything saves to the path in the ``CONDUIT_OUTPUT`` environment variable.

DOCX
----
    import conduit_docgen as cd
    doc = cd.Doc(title="Quarterly Report", subtitle="FY2025 · Q2",
                 theme="blue", author="Acme Analytics")
    doc.heading("Overview")
    doc.paragraph("Body text ...")
    doc.bullets(["First point", "Second point"])
    doc.numbered(["Step one", "Step two"])
    doc.callout("Key takeaway goes here.")
    doc.table(["Metric", "Value"], [["Revenue", "$1.2M"], ["Growth", "18%"]])
    doc.save()

PPTX
----
    import conduit_docgen as cd
    deck = cd.Deck(title="Product Launch", subtitle="2025 Roadmap",
                   theme="blue", footer="Acme Inc")
    deck.section("Introduction")
    deck.bullets("Why now?", ["Market ready", "Tech mature"])
    deck.two_column("Comparison", "Option A", ["fast"], "Option B", ["robust"])
    deck.table_slide("Numbers", ["Q", "Rev"], [["Q1", "1.0"], ["Q2", "1.2"]])
    deck.closing("Thank you", "questions@acme.com")
    deck.save()

PDF
---
    import conduit_docgen as cd
    pdf = cd.Pdf(title="Research Brief", subtitle="On-device inference",
                 theme="plum", author="Acme Labs")
    pdf.heading("Summary")
    pdf.paragraph("...")
    pdf.bullets(["a", "b"])
    pdf.table(["Model", "Latency"], [["A", "12ms"], ["B", "9ms"]])
    pdf.callout("Bottom line: it works.")
    pdf.save()

Themes: "blue" (default), "slate", "emerald", "plum", "amber".
Drop to the raw objects (doc.document / deck.prs) for anything not covered.
"""

import datetime
import os

# ---------------------------------------------------------------------------
# Design tokens. Hex strings (no leading '#').
# ---------------------------------------------------------------------------
THEMES = {
    "blue":    {"primary": "2563EB", "dark": "172554", "accent": "EFF4FF",
                "muted": "64748B", "border": "E2E8F0", "text": "1E293B", "band": "1E3A8A"},
    "slate":   {"primary": "0F172A", "dark": "020617", "accent": "F1F5F9",
                "muted": "64748B", "border": "E2E8F0", "text": "0F172A", "band": "334155"},
    "emerald": {"primary": "059669", "dark": "064E3B", "accent": "ECFDF5",
                "muted": "6B7280", "border": "D1FAE5", "text": "1F2937", "band": "065F46"},
    "plum":    {"primary": "7C3AED", "dark": "3B0764", "accent": "F5F3FF",
                "muted": "6B7280", "border": "EDE9FE", "text": "1F2937", "band": "5B21B6"},
    "amber":   {"primary": "D97706", "dark": "7C2D12", "accent": "FFFBEB",
                "muted": "78716C", "border": "FDE68A", "text": "1C1917", "band": "92400E"},
}

HEAD_FONT = "Calibri"
BODY_FONT = "Calibri"
WHITE = "FFFFFF"


def _theme(name):
    return THEMES.get((name or "blue").lower(), THEMES["blue"])


def _out_path(fallback):
    return os.environ.get("CONDUIT_OUTPUT", fallback)


def _today():
    return datetime.date.today().strftime("%B %d, %Y")


# ===========================================================================
# DOCX
# ===========================================================================
class Doc:
    def __init__(self, title="", subtitle="", theme="blue", author=""):
        from docx import Document
        from docx.shared import Pt, RGBColor

        self.document = Document()
        self.t = _theme(theme)
        self._Pt = Pt
        self._RGB = RGBColor

        section = self.document.sections[0]
        from docx.shared import Inches
        section.top_margin = Inches(1.0)
        section.bottom_margin = Inches(1.0)
        section.left_margin = Inches(1.1)
        section.right_margin = Inches(1.1)

        normal = self.document.styles["Normal"]
        normal.font.name = BODY_FONT
        normal.font.size = Pt(10.5)
        normal.font.color.rgb = RGBColor.from_string(self.t["text"])
        pf = normal.paragraph_format
        pf.space_after = Pt(7)
        pf.line_spacing = 1.28

        self._footer_brand(author or title)

        if title:
            self._cover(title, subtitle, author)

    # -- low-level helpers --------------------------------------------------
    def _rgb(self, hexstr):
        return self._RGB.from_string(hexstr)

    def _el(self, tag):
        from docx.oxml import OxmlElement
        return OxmlElement(tag)

    def _q(self, name):
        from docx.oxml.ns import qn
        return qn(name)

    def _shade(self, cell, hexstr):
        shd = self._el("w:shd")
        shd.set(self._q("w:val"), "clear")
        shd.set(self._q("w:fill"), hexstr)
        cell._tc.get_or_add_tcPr().append(shd)

    def _cell_margins(self, cell, top=60, bottom=60, left=110, right=110):
        tcPr = cell._tc.get_or_add_tcPr()
        m = self._el("w:tcMar")
        for edge, val in (("top", top), ("bottom", bottom), ("start", left), ("end", right)):
            e = self._el(f"w:{edge}")
            e.set(self._q("w:w"), str(val))
            e.set(self._q("w:type"), "dxa")
            m.append(e)
        tcPr.append(m)

    def _no_borders(self, table):
        tblPr = table._tbl.tblPr
        borders = self._el("w:tblBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            e = self._el(f"w:{edge}")
            e.set(self._q("w:val"), "none")
            borders.append(e)
        tblPr.append(borders)

    def _bottom_rule(self, paragraph, hexstr, size=12):
        pPr = paragraph._p.get_or_add_pPr()
        pbdr = self._el("w:pBdr")
        bottom = self._el("w:bottom")
        bottom.set(self._q("w:val"), "single")
        bottom.set(self._q("w:sz"), str(size))
        bottom.set(self._q("w:space"), "6")
        bottom.set(self._q("w:color"), hexstr)
        pbdr.append(bottom)
        pPr.append(pbdr)

    def _left_bar(self, cell, hexstr, size=28):
        tcPr = cell._tc.get_or_add_tcPr()
        borders = self._el("w:tcBorders")
        left = self._el("w:left")
        left.set(self._q("w:val"), "single")
        left.set(self._q("w:sz"), str(size))
        left.set(self._q("w:space"), "0")
        left.set(self._q("w:color"), hexstr)
        borders.append(left)
        tcPr.append(borders)

    def _run(self, p, text, size, color, bold=False, italic=False, font=BODY_FONT, spacing=None):
        r = p.add_run(text)
        r.bold = bold
        r.italic = italic
        r.font.name = font
        r.font.size = self._Pt(size)
        r.font.color.rgb = self._rgb(color)
        if spacing is not None:
            rPr = r._element.get_or_add_rPr()
            sp = self._el("w:spacing")
            sp.set(self._q("w:val"), str(spacing))
            rPr.append(sp)
        return r

    def _footer_brand(self, brand):
        from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
        Pt = self._Pt
        footer = self.document.sections[0].footer
        p = footer.paragraphs[0]
        p.text = ""
        # left brand + right page number via tab stops.
        from docx.shared import Inches
        tabs = p.paragraph_format.tab_stops
        tabs.add_tab_stop(Inches(6.3), WD_TAB_ALIGNMENT.RIGHT)
        self._run(p, (brand or ""), 8, self.t["muted"])
        self._run(p, "\t", 8, self.t["muted"])
        run = p.add_run()
        run.font.size = Pt(8)
        run.font.color.rgb = self._rgb(self.t["muted"])
        fld = self._el("w:fldSimple")
        fld.set(self._q("w:instr"), "PAGE")
        run._r.append(fld)

    def _cover(self, title, subtitle, author):
        Pt = self._Pt
        # Eyebrow / kicker.
        k = self.document.add_paragraph()
        k.paragraph_format.space_after = Pt(2)
        self._run(k, "REPORT", 10, self.t["primary"], bold=True, font=HEAD_FONT, spacing=40)

        p = self.document.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(4)
        self._run(p, title, 32, self.t["dark"], bold=True, font=HEAD_FONT)

        if subtitle:
            sp = self.document.add_paragraph()
            sp.paragraph_format.space_after = Pt(8)
            self._run(sp, subtitle, 15, self.t["primary"], font=HEAD_FONT)

        rule = self.document.add_paragraph()
        rule.paragraph_format.space_after = Pt(6)
        self._bottom_rule(rule, self.t["primary"], size=18)

        meta = self.document.add_paragraph()
        meta.paragraph_format.space_after = Pt(18)
        parts = [x for x in (author, _today()) if x]
        self._run(meta, "     ·     ".join(parts), 9.5, self.t["muted"], italic=True)

    # -- public API ---------------------------------------------------------
    def heading(self, text, level=1):
        Pt = self._Pt
        p = self.document.add_paragraph()
        pf = p.paragraph_format
        pf.space_before = Pt(16 if level == 1 else 11)
        pf.space_after = Pt(5 if level == 1 else 3)
        pf.keep_with_next = True
        if level == 1:
            self._run(p, text, 16, self.t["dark"], bold=True, font=HEAD_FONT)
            self._bottom_rule(p, self.t["border"], size=8)
        else:
            self._run(p, text, 13, self.t["primary"], bold=True, font=HEAD_FONT)
        return p

    def paragraph(self, text):
        return self.document.add_paragraph(str(text))

    def bullets(self, items):
        for it in items:
            self.document.add_paragraph(str(it), style="List Bullet")

    def numbered(self, items):
        for it in items:
            self.document.add_paragraph(str(it), style="List Number")

    def callout(self, text, label="KEY POINT"):
        Pt = self._Pt
        table = self.document.add_table(rows=1, cols=1)
        table.autofit = True
        self._no_borders(table)
        cell = table.cell(0, 0)
        self._shade(cell, self.t["accent"])
        self._left_bar(cell, self.t["primary"], size=30)
        self._cell_margins(cell, top=120, bottom=120, left=180, right=160)
        cell.paragraphs[0].text = ""
        if label:
            lp = cell.paragraphs[0]
            lp.paragraph_format.space_after = Pt(2)
            self._run(lp, label, 8.5, self.t["primary"], bold=True, spacing=30)
            bp = cell.add_paragraph()
        else:
            bp = cell.paragraphs[0]
        self._run(bp, text, 10.5, self.t["text"])
        self.document.add_paragraph().paragraph_format.space_after = Pt(2)
        return table

    def table(self, headers, rows):
        Pt = self._Pt
        table = self.document.add_table(rows=1, cols=len(headers))
        table.style = "Table Grid"
        # Thin light borders.
        tblPr = table._tbl.tblPr
        borders = self._el("w:tblBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            e = self._el(f"w:{edge}")
            e.set(self._q("w:val"), "single")
            e.set(self._q("w:sz"), "4")
            e.set(self._q("w:color"), self.t["border"])
            borders.append(e)
        tblPr.append(borders)

        hdr = table.rows[0].cells
        for i, h in enumerate(headers):
            self._shade(hdr[i], self.t["primary"])
            self._cell_margins(hdr[i])
            para = hdr[i].paragraphs[0]
            para.text = ""
            self._run(para, str(h), 10, WHITE, bold=True, font=HEAD_FONT)
        for ri, row in enumerate(rows):
            cells = table.add_row().cells
            for ci in range(len(headers)):
                self._cell_margins(cells[ci])
                if ci < len(row):
                    para = cells[ci].paragraphs[0]
                    para.text = ""
                    self._run(para, str(row[ci]), 10, self.t["text"])
                if ri % 2 == 1:
                    self._shade(cells[ci], self.t["accent"])
        self.document.add_paragraph().paragraph_format.space_after = Pt(2)
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
        from pptx.util import Inches, Pt
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

    # -- helpers ------------------------------------------------------------
    def _rgb(self, hexstr):
        return self._RGB.from_string(hexstr)

    def _slide(self, bg=WHITE):
        slide = self.prs.slides.add_slide(self._blank)
        self._rect(slide, 0, 0, self.prs.slide_width, self.prs.slide_height, bg, line=False)
        return slide

    def _rect(self, slide, x, y, w, h, fill, line=False):
        from pptx.enum.shapes import MSO_SHAPE
        shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
        shp.fill.solid()
        shp.fill.fore_color.rgb = self._rgb(fill)
        if line:
            shp.line.color.rgb = self._rgb(self.t["border"])
            shp.line.width = self._Pt(0.75)
        else:
            shp.line.fill.background()
        shp.shadow.inherit = False
        return shp

    def _text(self, slide, x, y, w, h, runs, align=None, anchor=None, line_spacing=None):
        """runs: str or list of (text, size, color, bold, italic, spacing) tuples/dicts."""
        box = slide.shapes.add_textbox(x, y, w, h)
        tf = box.text_frame
        tf.word_wrap = True
        if anchor is not None:
            tf.vertical_anchor = anchor
        if isinstance(runs, str):
            runs = [(runs, 18, self.t["text"], False)]
        p = tf.paragraphs[0]
        if align is not None:
            p.alignment = align
        if line_spacing is not None:
            p.line_spacing = line_spacing
        for spec in runs:
            text, size, color = spec[0], spec[1], spec[2]
            bold = spec[3] if len(spec) > 3 else False
            spacing = spec[4] if len(spec) > 4 else None
            r = p.add_run()
            r.text = text
            r.font.size = self._Pt(size)
            r.font.bold = bold
            r.font.name = HEAD_FONT
            r.font.color.rgb = self._rgb(color)
            if spacing is not None:
                from pptx.oxml.ns import qn
                r._r.get_or_add_rPr().set("spc", str(int(spacing)))
        return box

    def _eyebrow_title(self, slide, title, eyebrow=None):
        Inches = self._Inches
        top = Inches(0.55)
        if eyebrow:
            self._text(slide, Inches(0.75), top, Inches(11), Inches(0.35),
                       [(eyebrow.upper(), 12, self.t["primary"], True, 180)])
            top = Inches(0.92)
        self._text(slide, Inches(0.73), top, Inches(11.8), Inches(0.9),
                   [(title, 30, self.t["dark"], True)])
        # short accent underline under the title
        self._rect(slide, Inches(0.78), Inches(top.inches + 0.86),
                   Inches(0.9), self._Pt(3.5), self.t["primary"])

    def _footer(self, slide):
        Inches = self._Inches
        idx = len(self.prs.slides._sldIdLst)
        if self.footer:
            self._text(slide, Inches(0.75), Inches(7.02), Inches(9), Inches(0.35),
                       [(self.footer, 9, self.t["muted"], False)])
        self._text(slide, Inches(12.2), Inches(7.02), Inches(0.9), Inches(0.35),
                   [(str(idx), 9, self.t["muted"], False)],
                   align=self._PP_ALIGN.RIGHT)

    def _bullet_frame(self, slide, items, top, left=None, width=None, size=19):
        Inches, Pt = self._Inches, self._Pt
        box = slide.shapes.add_textbox(left or Inches(0.8), top,
                                       width or Inches(11.7), Inches(4.9))
        tf = box.text_frame
        tf.word_wrap = True
        for i, it in enumerate(items):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.space_after = Pt(12)
            p.line_spacing = 1.1
            r = p.add_run()
            r.text = "▪  "
            r.font.size = Pt(size)
            r.font.color.rgb = self._rgb(self.t["primary"])
            r.font.bold = True
            r2 = p.add_run()
            r2.text = str(it)
            r2.font.size = Pt(size)
            r2.font.name = BODY_FONT
            r2.font.color.rgb = self._rgb(self.t["text"])
        return box

    # -- public API ---------------------------------------------------------
    def title_slide(self, title, subtitle="", eyebrow="PRESENTATION"):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide(self.t["dark"])
        # left accent spine
        self._rect(slide, 0, 0, Inches(0.28), self.prs.slide_height, self.t["primary"])
        if eyebrow:
            self._text(slide, Inches(0.95), Inches(2.35), Inches(11), Inches(0.4),
                       [(eyebrow.upper(), 13, self.t["primary"], True, 220)])
        self._text(slide, Inches(0.9), Inches(2.85), Inches(11.6), Inches(1.9),
                   [(title, 46, WHITE, True)], line_spacing=1.02)
        if subtitle:
            self._text(slide, Inches(0.95), Inches(4.75), Inches(11.4), Inches(0.9),
                       [(subtitle, 20, self.t["accent"], False)])
        self._rect(slide, Inches(0.95), Inches(5.55), Inches(1.4), Pt(4), self.t["primary"])
        self._text(slide, Inches(0.95), Inches(6.7), Inches(11), Inches(0.4),
                   [((self.footer or _today()), 11, self.t["border"], False)])
        return slide

    def section(self, title, number=None):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide(self.t["primary"])
        if number is not None:
            self._text(slide, Inches(0.9), Inches(2.1), Inches(4), Inches(1.6),
                       [(str(number).zfill(2), 90, self.t["band"], True)])
        self._text(slide, Inches(0.95), Inches(3.5), Inches(11.4), Inches(1.4),
                   [(title, 40, WHITE, True)], anchor=self._ANCHOR.TOP)
        self._rect(slide, Inches(1.0), Inches(4.55), Inches(1.6), Pt(5), WHITE)
        return slide

    def bullets(self, title, items, eyebrow=None):
        slide = self._slide()
        self._eyebrow_title(slide, title, eyebrow)
        self._bullet_frame(slide, items, self._Inches(1.9))
        self._footer(slide)
        return slide

    def two_column(self, title, left_head, left_items, right_head, right_items, eyebrow=None):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide()
        self._eyebrow_title(slide, title, eyebrow)
        for x, head, items in (
            (Inches(0.8), left_head, left_items),
            (Inches(6.95), right_head, right_items),
        ):
            card = self._rect(slide, x, Inches(1.95), Inches(5.55), Inches(4.7), self.t["accent"])
            self._text(slide, x + Inches(0.3), Inches(2.2), Inches(5.0), Inches(0.6),
                       [(head, 20, self.t["primary"], True)])
            self._bullet_frame(slide, items, Inches(2.95),
                               left=x + Inches(0.3), width=Inches(4.95), size=16)
        self._footer(slide)
        return slide

    def table_slide(self, title, headers, rows, eyebrow=None):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide()
        self._eyebrow_title(slide, title, eyebrow)
        nrows, ncols = len(rows) + 1, len(headers)
        gt = slide.shapes.add_table(nrows, ncols, Inches(0.8), Inches(2.0),
                                    Inches(11.7), Inches(0.55 + 0.5 * nrows)).table
        for c, h in enumerate(headers):
            cell = gt.cell(0, c)
            cell.text = str(h)
            cell.fill.solid()
            cell.fill.fore_color.rgb = self._rgb(self.t["primary"])
            para = cell.text_frame.paragraphs[0]
            para.runs[0].font.bold = True
            para.runs[0].font.color.rgb = self._rgb(WHITE)
            para.runs[0].font.size = Pt(15)
            para.runs[0].font.name = HEAD_FONT
        for r, row in enumerate(rows, start=1):
            for c in range(ncols):
                cell = gt.cell(r, c)
                cell.text = str(row[c]) if c < len(row) else ""
                cell.fill.solid()
                cell.fill.fore_color.rgb = self._rgb(self.t["accent"] if r % 2 == 0 else WHITE)
                if cell.text_frame.paragraphs[0].runs:
                    run = cell.text_frame.paragraphs[0].runs[0]
                    run.font.size = Pt(13)
                    run.font.name = BODY_FONT
                    run.font.color.rgb = self._rgb(self.t["text"])
        self._footer(slide)
        return slide

    def closing(self, title, subtitle=""):
        Inches, Pt = self._Inches, self._Pt
        slide = self._slide(self.t["dark"])
        self._rect(slide, 0, 0, Inches(0.28), self.prs.slide_height, self.t["primary"])
        self._text(slide, Inches(0.95), Inches(2.9), Inches(11.5), Inches(1.5),
                   [(title, 42, WHITE, True)], anchor=self._ANCHOR.TOP)
        if subtitle:
            self._text(slide, Inches(1.0), Inches(4.25), Inches(11.4), Inches(0.8),
                       [(subtitle, 19, self.t["accent"], False)])
        self._rect(slide, Inches(1.0), Inches(4.0), Inches(1.4), Pt(4), self.t["primary"])
        return slide

    def save(self, path=None):
        self.prs.save(_out_path(path or "deck.pptx"))


# ===========================================================================
# PDF (reportlab)
# ===========================================================================
class Pdf:
    def __init__(self, title="", subtitle="", theme="blue", author=""):
        from reportlab.lib.colors import HexColor
        from reportlab.lib.pagesizes import LETTER

        self.t = _theme(theme)
        self._HexColor = HexColor
        self._pagesize = LETTER
        self.title = title
        self.subtitle = subtitle
        self.author = author
        self.story = []
        self._styles()
        if title:
            self._cover(title, subtitle, author)

    def _c(self, hexstr):
        return self._HexColor("#" + hexstr)

    def _styles(self):
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.enums import TA_LEFT
        t = self.t
        self.st_kicker = ParagraphStyle("kicker", fontName="Helvetica-Bold",
                                        fontSize=10, textColor=self._c(t["primary"]),
                                        spaceAfter=4, leading=13)
        self.st_title = ParagraphStyle("title", fontName="Helvetica-Bold",
                                       fontSize=30, textColor=self._c(t["dark"]),
                                       spaceAfter=6, leading=34)
        self.st_subtitle = ParagraphStyle("subtitle", fontName="Helvetica",
                                          fontSize=14, textColor=self._c(t["primary"]),
                                          spaceAfter=10, leading=18)
        self.st_meta = ParagraphStyle("meta", fontName="Helvetica-Oblique",
                                      fontSize=9, textColor=self._c(t["muted"]),
                                      spaceAfter=18, leading=12)
        self.st_h1 = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=15,
                                    textColor=self._c(t["dark"]), spaceBefore=14,
                                    spaceAfter=5, leading=19)
        self.st_h2 = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=12,
                                    textColor=self._c(t["primary"]), spaceBefore=10,
                                    spaceAfter=3, leading=15)
        self.st_body = ParagraphStyle("body", fontName="Helvetica", fontSize=10.5,
                                      textColor=self._c(t["text"]), spaceAfter=7,
                                      leading=15, alignment=TA_LEFT)
        self.st_bullet = ParagraphStyle("bullet", parent=self.st_body,
                                        leftIndent=16, bulletIndent=2, spaceAfter=4)
        self.st_callout = ParagraphStyle("callout", fontName="Helvetica-Bold",
                                         fontSize=10.5, textColor=self._c(t["dark"]),
                                         leading=15)

    def _cover(self, title, subtitle, author):
        from reportlab.platypus import Paragraph, Spacer, HRFlowable
        self.story.append(Spacer(1, 90))
        self.story.append(Paragraph("REPORT", self.st_kicker))
        self.story.append(Paragraph(title, self.st_title))
        if subtitle:
            self.story.append(Paragraph(subtitle, self.st_subtitle))
        self.story.append(HRFlowable(width="100%", thickness=2,
                                     color=self._c(self.t["primary"]), spaceAfter=8))
        parts = [x for x in (author, _today()) if x]
        self.story.append(Paragraph("     ·     ".join(parts), self.st_meta))
        self.story.append(Spacer(1, 6))

    # -- public API ---------------------------------------------------------
    def heading(self, text, level=1):
        from reportlab.platypus import Paragraph, HRFlowable
        self.story.append(Paragraph(text, self.st_h1 if level == 1 else self.st_h2))
        if level == 1:
            self.story.append(HRFlowable(width="100%", thickness=0.75,
                                         color=self._c(self.t["border"]), spaceAfter=6))

    def paragraph(self, text):
        from reportlab.platypus import Paragraph
        self.story.append(Paragraph(str(text), self.st_body))

    def bullets(self, items):
        from reportlab.platypus import Paragraph
        for it in items:
            self.story.append(Paragraph(str(it), self.st_bullet, bulletText="•"))

    def numbered(self, items):
        from reportlab.platypus import Paragraph
        for i, it in enumerate(items, 1):
            self.story.append(Paragraph(str(it), self.st_bullet, bulletText=f"{i}."))

    def callout(self, text, label="KEY POINT"):
        from reportlab.platypus import Paragraph, Table, TableStyle
        from reportlab.lib.units import inch
        inner = []
        if label:
            inner.append(Paragraph(label, ParagraphStyleCallLabel(self)))
        inner.append(Paragraph(text, self.st_callout))
        tbl = Table([[inner]], colWidths=[6.3 * inch])
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), self._c(self.t["accent"])),
            ("LINEBEFORE", (0, 0), (0, -1), 3, self._c(self.t["primary"])),
            ("LEFTPADDING", (0, 0), (-1, -1), 14),
            ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ]))
        from reportlab.platypus import Spacer
        self.story.append(tbl)
        self.story.append(Spacer(1, 8))

    def table(self, headers, rows):
        from reportlab.platypus import Table, TableStyle, Spacer
        data = [list(map(str, headers))] + [list(map(str, r)) for r in rows]
        tbl = Table(data, repeatRows=1, hAlign="LEFT")
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), self._c(self.t["primary"])),
            ("TEXTCOLOR", (0, 0), (-1, 0), self._c("FFFFFF")),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 9.5),
            ("TEXTCOLOR", (0, 1), (-1, -1), self._c(self.t["text"])),
            ("GRID", (0, 0), (-1, -1), 0.5, self._c(self.t["border"])),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ]
        for r in range(1, len(data)):
            if r % 2 == 0:
                style.append(("BACKGROUND", (0, r), (-1, r), self._c(self.t["accent"])))
        tbl.setStyle(TableStyle(style))
        self.story.append(tbl)
        self.story.append(Spacer(1, 8))

    def save(self, path=None):
        from reportlab.platypus import SimpleDocTemplate
        from reportlab.lib.pagesizes import LETTER
        out = _out_path(path or "document.pdf")
        doc = SimpleDocTemplate(out, pagesize=LETTER,
                                topMargin=54, bottomMargin=54,
                                leftMargin=64, rightMargin=64,
                                title=self.title, author=self.author)
        theme = self.t
        HexColor = self._HexColor

        def footer(canvas, d):
            canvas.saveState()
            canvas.setStrokeColor(HexColor("#" + theme["border"]))
            canvas.setLineWidth(0.5)
            canvas.line(64, 42, LETTER[0] - 64, 42)
            canvas.setFont("Helvetica", 8)
            canvas.setFillColor(HexColor("#" + theme["muted"]))
            if self.author or self.title:
                canvas.drawString(64, 30, self.author or self.title)
            canvas.drawRightString(LETTER[0] - 64, 30, str(d.page))
            canvas.restoreState()

        doc.build(self.story, onFirstPage=footer, onLaterPages=footer)


def ParagraphStyleCallLabel(pdf):
    from reportlab.lib.styles import ParagraphStyle
    return ParagraphStyle("callout_label", fontName="Helvetica-Bold", fontSize=8,
                          textColor=pdf._c(pdf.t["primary"]), spaceAfter=3, leading=11)
