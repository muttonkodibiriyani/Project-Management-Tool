"""Checks on the generated launch workbook. Run: python3 -m unittest (in this folder)."""
import os
import re
import tempfile
import unittest

import openpyxl

import launch_workbook as W

LAUNCH = "tblLines[Launch],$B$4"


def calls(formula, names=("COUNTIFS", "SUMIFS")):
    """Yield the full text of each COUNTIFS(...) / SUMIFS(...) call in a formula."""
    for m in re.finditer(r"\b(%s)\(" % "|".join(names), formula):
        depth, i = 0, m.end() - 1
        while True:
            ch = formula[i]
            depth += ch == "("
            depth -= ch == ")"
            if depth == 0:
                break
            i += 1
        yield formula[m.start():i + 1]


class TemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = os.path.join(cls.tmp.name, "template.xlsx")
        W.build(path)
        cls.wb = openpyxl.load_workbook(path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_dashboard_tblLines_counts_filter_on_launch(self):
        checked, missing = 0, []
        for row in self.wb["Dashboard"].iter_rows():
            for c in row:
                if c.data_type != "f":
                    continue
                for call in calls(c.value):
                    if "tblLines[" in call:
                        checked += 1
                        if LAUNCH not in call:
                            missing.append(f"{c.coordinate}: {call}")
        self.assertGreater(checked, 0)
        self.assertEqual(missing, [], "COUNTIFS/SUMIFS over tblLines without " + LAUNCH)

    def test_dropdown_sources_have_no_leading_equals(self):
        bad = [(ws.title, str(dv.sqref), dv.formula1) for ws in self.wb.worksheets
               for dv in ws.data_validations.dataValidation if dv.formula1 and dv.formula1.startswith("=")]
        self.assertEqual(bad, [])

    def test_conditional_format_formulas_have_no_leading_equals(self):
        bad = [(ws.title, str(cf.sqref), f) for ws in self.wb.worksheets for cf in ws.conditional_formatting
               for rule in cf.rules for f in (rule.formula or []) if f.startswith("=")]
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main()
