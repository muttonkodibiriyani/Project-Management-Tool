"""Organised launch workbook: schema and writer.

Builds the organised workbook described in the Launch Tracker product spec,
section 7: Read me, Lines, Brands, Distribution by market, Vendors & contacts,
Stores & capacity, Installs & deliveries, Market visits, US NPD & replenishment,
Dashboard and Lists.

This module holds no launch data. `build(path)` writes the empty template;
an importer passes rows per table to `build(path, data)`.

Field meanings, value lists and the mapping from the old Qatar columns are in
the tm8 doc "Launch tracker data dictionary" (01a188ce-908b-7e7f-846f-e2bc7e7e37f3).
"""
from openpyxl import Workbook
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo

TEMPLATE_VERSION = "1.0"
OPENPYXL_VERSION = "3.1.5"  # pinned in requirements.txt; build() patches one of its internals

# ---------------------------------------------------------------- vocabularies
# Generic value lists: the workbook's own words, cleaned. Each workspace may
# edit them on the Lists sheet. A value marked done counts towards readiness.
VOCAB = {
    "YesNo": ["Yes", "No"],
    "YesNoTBC": ["Yes", "No", "TBC"],
    "Market": ["QAT", "KSA", "UAE", "KWT", "BHR", "OMN"],
    "MainCategory": ["Skincare", "Cosmetics", "Fragrance", "Hair", "Wellness", "Body", "Accessories", "Other"],
    "Zone": ["Fragrance", "Prestige skincare", "Mass skincare", "Mass cosmetics", "Prestige cosmetics",
             "Pro hair", "Mass haircare", "Hair color", "Body", "Wellness", "Accessories", "PCA", "Skincare"],
    "BrandCode": ["Purple", "Blue", "Green", "Yellow", "Grey", "TBC", "Other", "Late"],
    "Origin": ["Local", "Ulta US"],
    "MarketStatus": ["In ME, new to UB", "In US, already in market", "In US, new to ME"],
    "InternalCategory": ["Korean", "Local founder", "KSA local", "QAT local", "MUP artist", "Chinese"],
    "MarketingOK": ["OK", "OK - Korean", "OK - Korean US", "OK - celebrity", "OK - exclusive", "No"],
    "Exclusivity": ["Yes", "Yes - TBC", "No", "Non-exclusive", "TBC", "Other market only"],
    "Listing": ["Yes", "No", "TBC", "Late", "Late - registration", "Other store only", "No contact"],
    "AtLaunch": ["Yes", "Yes - late", "+30 days", "+60 days", "+90 days", "+120 days", "No", "Not coming", "TBC"],
    "Comms": ["Not sent", "To send", "To confirm", "Sent", "Late", "Late - registration", "No contact",
              "Not listed", "TBC"],
    "FloorPlan": ["Pending", "Sent"],
    "FixtureType": ["Gondola", "Wall", "Endcap", "Iconic", "Iconic+", "Half iconic", "Local iconic", "Iconic wall",
                    "Influencer wall", "Pod", "Body pod", "Impulse", "Bay", "Bespoke bay", "Temp endcap",
                    "Lash endcap", "Gift set fixture", "Gift set endcap", "Shelves", "Combination", "Not listed"],
    "PO": ["Not raised", "Pending", "Pending PRC", "Released", "Picked at US DC", "Awaiting HB", "US - pending",
           "Late", "Other store only"],
    "VPA": ["Pending", "Shared", "Countersigned", "Signed"],
    "Registration": ["Not needed", "New to market", "Under registration", "With brand team", "Need distributor",
                     "WIP", "Registered", "Late", "Late - registration", "TBC"],
    "Quarter": ["Q1", "Q2", "Q3", "Q4"],
    "ProjectComms": ["Yes", "US brand", "Out", "Grey", "TBC", "Late"],
    "Schematics": ["Pending", "Revised", "Approved", "Same as", "Not required", "Dropped"],
    "VendorRoute": ["Qatar extension", "UAE extension", "KWT extension", "New supplier", "Retailer creation",
                    "US brand"],
    "VendorState": ["Not started", "WIP", "Followed up", "No response", "Done", "US brand", "US - pending", "Late"],
    "ICF": ["Pending", "Received", "Not required", "C/O supply chain", "C/O supplier", "US brand", "US - pending",
            "Late", "Out"],
    "SupplierForm": ["Yes", "Existing", "WIP - C/O supply chain", "C/O supply chain", "C/O supplier",
                     "C/O finance", "Missing (urgent)", "No comms"],
    "AccountForm": ["No request", "Signatory required", "Docs shared", "Provided"],
    "OrderShared": ["Yes", "WIP", "Later", "No item master", "Out"],
    "DistStatus": ["Distributor", "From US", "No distributor", "Need POC", "TBC"],
    "RegRoute": ["By brand", "By retailer", "TBC"],
    "InstallStatus": ["Scheduled", "TBC", "Done"],
    "DeliveryStatus": ["Scheduled", "TBC", "Delivered"],
    "VMStatus": ["Done", "Trays missing", "Graphic missing"],
    "NPDType": ["NPD", "Replenishment", "New brand"],
    "StoreRole": ["Launching", "Reference"],
}

# Values that count as done for readiness (Dashboard).
DONE = {
    "Listing": ["Yes"], "Comms": ["Sent"], "FloorPlan": ["Sent"], "VPA": ["Signed"],
    "Registration": ["Not needed", "Registered"], "ProjectComms": ["Yes", "US brand"],
    "Schematics": ["Approved", "Same as", "Not required"], "VendorState": ["Done", "US brand"],
    "ICF": ["Received", "Not required", "US brand"], "PO": ["Released", "Picked at US DC"],
}

# Brand-code colour legend (Read me, Lines). One rule set, defined here only.
LEGEND = [
    ("Purple", "US brand, exclusive", "E4D2F7"),
    ("Blue", "US brand, not exclusive", "CFE2F3"),
    ("Green", "US brand, locally supplied", "D9EAD3"),
    ("Yellow", "Local brand", "FFF2CC"),
    ("Grey", "Dropped vs UAE", "D9D9D9"),
    ("TBC", "Listing to be confirmed", "FCE5CD"),
    ("Other", "Bespoke bay or temporary endcap", "EAD1DC"),
    ("Late", "Arrives after opening", "F4CCCC"),
]

# ---------------------------------------------------------------- tables
# (header, list name or validation kind, width, group)
# list name: a VOCAB key, or "@<name>" for a workspace list (defined name over a
# table column), or "int"/"dec"/"date" for typed input, or None for free text.
STORE_SLOT = [
    ("Listing", "Listing"), ("At launch", "AtLaunch"), ("At launch recheck", "AtLaunch"), ("Comms", "Comms"),
    ("Floor plan", "FloorPlan"), ("Fixture as written", None), ("Fixture type", "FixtureType"),
    ("Width ft", "dec"), ("Shelves", "int"), ("Temporary", "YesNo"), ("PO", "PO"),
]


def _slot(n):
    cols = [(f"Store {n}", "@Store", 9, f"store{n}")]
    for name, kind in STORE_SLOT:
        cols.append((f"S{n} {name}", kind, 22 if "written" in name else 13, f"store{n}"))
    return cols


TABLES = {
    "tblLines": ("Lines", [
        ("Line ID", None, 10, "id"), ("Launch", "@Launch", 14, "id"), ("Main category", "MainCategory", 13, "id"),
        ("Zone", "Zone", 18, "id"), ("Sub-zone", None, 10, "id"), ("Area", "int", 6, "id"),
        ("Brand team", "@BrandTeam", 12, "id"), ("Follow-up owner", None, 14, "id"), ("Host group", None, 18, "id"),
        ("Brand code", "BrandCode", 10, "id"), ("Double placement", "YesNo", 9, "id"), ("Brand", "@Brand", 24, "id"),
        ("External key", None, 28, "id"), ("From", "Origin", 9, "class"), ("Market status", "MarketStatus", 22, "class"),
        ("Internal category", "InternalCategory", 13, "class"), ("The 80 brands", "YesNo", 8, "class"),
        ("Marketing OK", "MarketingOK", 13, "class"),
        ("Penetration plan", "dec", 11, "metric"), ("Penetration UAE all regions", "dec", 11, "metric"),
        ("Penetration UAE actual", "dec", 11, "metric"), ("Penetration plan MOE", "dec", 11, "metric"),
        ("Penetration notes", None, 18, "metric"),
    ] + _slot(1) + _slot(2) + [
        ("VPA status", "VPA", 12, "gate"), ("VPA shared", "YesNoTBC", 8, "gate"),
        ("VPA countersigned", "YesNo", 8, "gate"), ("VPA signed", "YesNoTBC", 8, "gate"),
        ("Data set-up", "Registration", 16, "gate"), ("Data set-up quarter", "Quarter", 8, "gate"),
        ("Project comms", "ProjectComms", 11, "gate"), ("Schematics", "Schematics", 12, "gate"),
        ("Schematics same as", "@StoreOrMarket", 9, "gate"), ("Vendor set-up route", "VendorRoute", 15, "gate"),
        ("Vendor set-up state", "VendorState", 13, "gate"), ("Vendor set-up note", None, 20, "gate"),
        ("ICF", "ICF", 13, "gate"), ("Supplier opening form", "SupplierForm", 15, "gate"),
        ("Account opening form", "AccountForm", 15, "gate"), ("Order shared", "OrderShared", 11, "gate"),
        ("Feedback supplier creation", None, 22, "feedback"), ("Feedback ICF", None, 22, "feedback"),
        ("Feedback schematics", None, 22, "feedback"), ("Comments", None, 22, "feedback"),
        ("Added comments", None, 22, "feedback"), ("Notes", None, 30, "feedback"), ("Source", None, 16, "feedback"),
    ]),
    "tblBrands": ("Brands", [
        ("Brand", None, 26, "id"), ("Host group", None, 20, "id"), ("Lines", "int", 7, "id"),
        ("New brand", "YesNo", 9, "id"), ("New brand category", None, 18, "id"),
        ("New brand as written", None, 22, "id"), ("Source", None, 16, "id"),
    ]),
    "tblDistribution": ("Distribution by market", [
        ("Line ID", None, 10, "id"), ("Brand", "@Brand", 24, "id"), ("Market", "Market", 8, "id"),
        ("Distribution status", "DistStatus", 13, "id"), ("Distributor", "@Vendor", 26, "id"),
        ("Distributor as written", None, 26, "id"), ("Contacts as written", None, 30, "contact"),
        ("Margin", "dec", 8, "terms"), ("Extra margin", "dec", 8, "terms"), ("Margin terms", None, 18, "terms"),
        ("Margin as written", None, 22, "terms"), ("Exclusive", "Exclusivity", 12, "terms"),
        ("Exclusive months", "int", 9, "terms"), ("Registration route", "RegRoute", 11, "terms"),
        ("Notes", None, 24, "terms"), ("Source", None, 16, "terms"),
    ]),
    "tblVendors": ("Vendors & contacts", [
        ("Vendor", None, 30, "id"), ("Aliases as written", None, 40, "id"), ("Markets", None, 14, "id"),
        ("Lines", "int", 7, "id"),
    ]),
    "tblContacts": ("Vendors & contacts", [
        ("Vendor", "@Vendor", 30, "id"), ("Market", "Market", 8, "id"), ("Contact as written", None, 40, "id"),
        ("Emails", None, 34, "id"), ("Lines", "int", 7, "id"),
    ]),
    "tblVendorPacks": ("Vendors & contacts", [
        ("Vendor", None, 26, "id"), ("Brand", None, 22, "id"), ("Category", None, 16, "id"),
        ("Store 1 fixture", None, 20, "id"), ("Store 2 fixture", None, 20, "id"), ("Vendor pack", None, 22, "id"),
        ("Fixture reference", None, 16, "id"), ("Shelves note", None, 12, "id"), ("Source", None, 14, "id"),
    ]),
    "tblBrandLists": ("Vendors & contacts", [
        ("List", None, 24, "id"), ("Entry", None, 26, "id"), ("Vendor", None, 18, "id"), ("Category", None, 16, "id"),
        ("Fixture", None, 20, "id"), ("Source", None, 14, "id"),
    ]),
    "tblLaunches": ("Stores & capacity", [
        ("Launch", None, 16, "id"), ("Market", "Market", 8, "id"), ("Stores", None, 14, "id"),
        ("Description", None, 40, "id"),
    ]),
    "tblStores": ("Stores & capacity", [
        ("Code", None, 8, "id"), ("Name", None, 22, "id"), ("Market", "Market", 8, "id"), ("Role", "StoreRole", 11, "id"),
        ("Opening", "date", 12, "id"), ("Opening note", None, 16, "id"), ("Aliases", None, 16, "id"),
    ]),
    "tblCapacity": ("Stores & capacity", [
        ("Store", "@Store", 8, "id"), ("Category", None, 18, "id"), ("Fixture type", "FixtureType", 16, "id"),
        ("Count", "int", 7, "id"), ("Source", None, 14, "id"),
    ]),
    "tblRefFixtures": ("Stores & capacity", [
        ("Line ID", None, 10, "id"), ("Brand", None, 22, "id"), ("Store", "@Store", 8, "id"),
        ("Fixture as written", None, 24, "id"), ("Fixture type", "FixtureType", 14, "id"), ("Width ft", "dec", 8, "id"),
        ("Shelves", "int", 8, "id"), ("Temporary", "YesNo", 9, "id"), ("Source", None, 14, "id"),
    ]),
    "tblInstalls": ("Installs & deliveries", [
        ("Line ID", None, 10, "id"), ("Store", "@Store", 8, "id"), ("Host group", None, 18, "id"),
        ("Vendor", "@Vendor", 20, "id"), ("Vendor as written", None, 20, "id"), ("Brand", None, 20, "id"),
        ("Zone as written", None, 16, "id"), ("Fixture as written", None, 24, "id"),
        ("Same fixture as", "@StoreOrMarket", 9, "id"), ("Vendor pack", None, 12, "id"),
        ("Install start", "date", 11, "id"), ("Install end", "date", 11, "id"),
        ("Install status", "InstallStatus", 10, "id"), ("Contractor", None, 11, "id"),
        ("Delivery date", "date", 11, "id"), ("Delivery status", "DeliveryStatus", 10, "id"),
        ("VM status", "VMStatus", 12, "id"), ("Wall perimeter", "YesNo", 8, "id"), ("Email sent", "date", 11, "id"),
        ("Email sent by", None, 10, "id"), ("Notes", None, 24, "id"), ("Source", None, 14, "id"),
    ]),
    "tblAgenda": ("Market visits", [
        ("Visit", None, 14, "id"), ("Day as written", None, 16, "id"), ("Date", "date", 11, "id"),
        ("Person", None, 10, "id"), ("Time", None, 10, "id"), ("Activity", None, 44, "id"), ("Source", None, 14, "id"),
    ]),
    "tblVisitBrands": ("Market visits", [
        ("Visit", None, 14, "id"), ("Vendor", None, 18, "id"), ("Brand", None, 22, "id"),
        ("Category", None, 14, "id"), ("Source", None, 14, "id"),
    ]),
    "tblNPD": ("US NPD & replenishment", [
        ("Type", "NPDType", 13, "id"), ("Brand", None, 18, "id"), ("NPD or focus", None, 44, "id"),
        ("Sizing sent", "date", 11, "id"), ("Picked up from US DC", None, 11, "id"),
        ("ETA UAE", "date", 11, "id"), ("ETA KWT", "date", 11, "id"), ("ETA KSA", "date", 11, "id"),
        ("ETA QAT", "date", 11, "id"), ("Source", None, 14, "id"),
    ]),
    "tblNormalised": ("Lists", [
        ("Field", None, 26, "id"), ("Original", None, 36, "id"), ("Stored as", None, 36, "id"),
        ("Cells", "int", 7, "id"),
    ]),
    "tblBrandTeams": ("Lists", [("Brand team", None, 14, "id")]),
}

# Workspace lists: defined names over table columns (they grow with the table).
WORKSPACE_LISTS = {
    "Store": "tblStores[Code]", "Launch": "tblLaunches[Launch]", "BrandTeam": "tblBrandTeams[Brand team]",
    "Brand": "tblBrands[Brand]", "Vendor": "tblVendors[Vendor]",
}

GROUP_FILL = {  # header colours follow the old workbook's column groups
    "id": "F4B183", "class": "F8CBAD", "metric": "BDD7EE", "store1": "D5A6BD", "store2": "B4A7D6",
    "gate": "A9D18E", "feedback": "FFE699", "contact": "C9C9C9", "terms": "C5E0B4",
}

SHEETS = ["Read me", "Lines", "Brands", "Distribution by market", "Vendors & contacts", "Stores & capacity",
          "Installs & deliveries", "Market visits", "US NPD & replenishment", "Dashboard", "Lists"]

SHEET_NOTES = {
    "Lines": "One row per launch line (brand x zone). Store 1 and Store 2 hold the store code; their column groups hold that store's answers.",
    "Brands": "Brand master. Lines counts the brand's lines.",
    "Distribution by market": "One row per line and market: distributor, contacts as written, margin split into base, extra and terms.",
    "Vendors & contacts": "Vendor directory with the spellings found, contacts, vendor packs and brand lists.",
    "Stores & capacity": "Launches, stores, fixture capacity per store, and reference-store fixtures per line.",
    "Installs & deliveries": "One row per line (or brand) and store: install window, contractor, delivery, VM status.",
    "Market visits": "Market-visit agenda and the brands each vendor brings.",
    "US NPD & replenishment": "US new products, replenishments and new brands, with ETA per market.",
    "Lists": "Every value list. Dropdowns read from here. Normalised spellings lists what the importer changed.",
}

HEAD_FONT = Font(bold=True)
TITLE_FONT = Font(bold=True, size=14)


def _fill(hex_):
    return PatternFill("solid", start_color=hex_, end_color=hex_)


def _q(sheet):
    return "'" + sheet.replace("'", "''") + "'"


class _Layout:
    """Places tables side by side on a sheet (one blank column between them),
    so any table can grow downwards without running into another."""

    HEADER_ROW = 4

    def __init__(self):
        self.next_col = {}
        self.where = {}  # table -> (sheet, header_row, first_col, n_rows)


def _as_text(c):
    """Keep a typed string as text even when it looks like a formula or an error code."""
    if isinstance(c.value, str) and c.data_type != "s":
        c.data_type = "s"
        c.quotePrefix = True
    return c


def _write_table(wb, lay, tname, rows, cols=None, sheet=None):
    if cols is None:
        sheet, cols = TABLES[tname]
    ws = wb[sheet]
    r0 = lay.HEADER_ROW
    col = lay.next_col.get(sheet, 1)
    ws.cell(r0 - 1, col, tname[3:].replace("List_", "")).font = HEAD_FONT
    for j, (h, _k, w, g) in enumerate(cols):
        c = ws.cell(r0, col + j, h)
        c.font = HEAD_FONT
        c.fill = _fill(GROUP_FILL[g])
        c.alignment = Alignment(wrap_text=True, vertical="top")
        letter = get_column_letter(col + j)
        cur = ws.column_dimensions[letter].width or 0
        ws.column_dimensions[letter].width = max(cur, w)
    body = rows or [{}]
    headers = [h for h, *_ in cols]
    for i, row in enumerate(body, start=1):
        unknown = set(row) - set(headers)
        if unknown:
            raise KeyError(f"{tname}: unknown columns {sorted(unknown)}")
        for j, h in enumerate(headers):
            v = row.get(h)
            if v is not None:
                c = _as_text(ws.cell(r0 + i, col + j, v))
                kind = cols[j][1]
                if kind == "date":
                    c.number_format = "dd-mmm-yyyy"
                elif kind == "dec" and h.startswith(("Margin", "Extra")):
                    c.number_format = "0.0%"
    last = r0 + len(body)
    ref = f"{get_column_letter(col)}{r0}:{get_column_letter(col + len(cols) - 1)}{last}"
    t = Table(displayName=tname, ref=ref)
    t.tableStyleInfo = TableStyleInfo(name="TableStyleLight1", showRowStripes=True)
    ws.add_table(t)
    lay.where[tname] = (sheet, r0, col, len(body))
    lay.next_col[sheet] = col + len(cols) + 1
    return ws, r0, last


def _validate(wb, lay):
    for tname, (sheet, cols) in TABLES.items():
        if tname in ("tblNormalised", "tblBrandTeams"):
            continue
        _s, r0, c0, n = lay.where[tname]
        ws = wb[sheet]
        for j, (h, kind, _w, _g) in enumerate(cols):
            if kind is None:
                continue
            rng = f"{get_column_letter(c0 + j)}{r0 + 1}:{get_column_letter(c0 + j)}{r0 + n}"
            if kind == "int":
                dv = DataValidation(type="whole", operator="greaterThanOrEqual", formula1="0", allow_blank=True)
            elif kind == "dec":
                dv = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1="0", allow_blank=True)
            elif kind == "date":
                dv = DataValidation(type="date", operator="greaterThan", formula1="36526", allow_blank=True)
            else:
                name = "lst_" + kind.lstrip("@")
                dv = DataValidation(type="list", formula1=name, allow_blank=True)
                if kind in ("@Brand", "@Vendor"):
                    dv.errorStyle = "warning"  # a new brand or vendor may be typed, with a warning
            dv.showErrorMessage = True
            dv.errorTitle = h
            dv.error = "Pick a value from the list (Lists sheet)." if dv.type == "list" else "Enter a valid value."
            dv.add(rng)
            ws.add_data_validation(dv)


def _lists_sheet(wb, lay):
    ws = wb["Lists"]
    ws["A1"] = "Lists"
    ws["A1"].font = TITLE_FONT
    ws["B1"] = SHEET_NOTES["Lists"] + " Bold green = counts as done."
    for name, values in VOCAB.items():
        tname = "tblList_" + name
        _write_table(wb, lay, tname, [{name: v} for v in values],
                     cols=[(name, None, max(12, max(len(v) for v in values) + 2), "id")], sheet="Lists")
        _s, r0, c0, _n = lay.where[tname]
        for i, v in enumerate(values):
            if v in DONE.get(name, []):
                ws.cell(r0 + 1 + i, c0).font = Font(bold=True, color="006100")
        wb.defined_names["lst_" + name] = DefinedName("lst_" + name, attr_text=f"{tname}[{name}]")


def _workspace_names(wb):
    for name, ref in WORKSPACE_LISTS.items():
        wb.defined_names["lst_" + name] = DefinedName("lst_" + name, attr_text=ref)
    # Same-as answers: any store code or market code.
    wb.defined_names["lst_StoreOrMarket"] = DefinedName("lst_StoreOrMarket", attr_text="tblStores[Code]")


def _legend_rules(wb, lay):
    sheet, r0, c0, n = lay.where["tblLines"]
    ws = wb[sheet]
    heads = [h for h, *_ in TABLES["tblLines"][1]]
    code_col = get_column_letter(c0 + heads.index("Brand code"))
    brand_col = get_column_letter(c0 + heads.index("Brand"))
    rng = f"{code_col}{r0 + 1}:{code_col}{r0 + n} {brand_col}{r0 + 1}:{brand_col}{r0 + n}"
    for code, _meaning, colour in LEGEND:
        ws.conditional_formatting.add(
            rng, FormulaRule(formula=[f'${code_col}{r0 + 1}="{code}"'], fill=_fill(colour), stopIfTrue=True))


def _read_me(wb, extra):
    ws = wb["Read me"]
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 60
    ws.column_dimensions["C"].width = 30
    ws["A1"] = "Launch workbook"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = f"Organised launch workbook, template {TEMPLATE_VERSION}. Confidential - internal use once filled in."
    ws["A3"] = "Field meanings and value lists: tm8 doc 'Launch tracker data dictionary' (01a188ce-908b-7e7f-846f-e2bc7e7e37f3)."
    r = 5
    ws.cell(r, 1, "Sheet").font = HEAD_FONT
    ws.cell(r, 2, "What it holds").font = HEAD_FONT
    for s in SHEETS[1:]:
        r += 1
        ws.cell(r, 1, s)
        ws.cell(r, 2, SHEET_NOTES.get(s, "Launch dashboard: counts computed from Lines; nothing typed in." if s == "Dashboard" else ""))
    r += 2
    ws.cell(r, 1, "Brand code legend").font = HEAD_FONT
    for code, meaning, colour in LEGEND:
        r += 1
        ws.cell(r, 1, code).fill = _fill(colour)
        ws.cell(r, 2, meaning)
    r += 1
    ws.cell(r, 1, "Double placement = Yes").fill = PatternFill()
    ws.cell(r, 2, "The same brand placed a second time in another zone (old 'DOUBLE' codes).")
    r += 2
    ws.cell(r, 1, "Rules").font = HEAD_FONT
    for line in [
        "Pick coded values from the dropdowns; Lists holds every value list.",
        "Each store column group belongs to the store code in Store 1 or Store 2 on that row.",
        "US brands (Purple, Blue) skip vendor set-up and ICF ('US brand'); their PO is 'Picked at US DC'.",
        "Grey or a 'No' listing closes that store's gates.",
        "Columns ending 'as written' keep the original text; the typed columns beside them are the clean values.",
        "Notes holds any part of an old answer that did not fit a value list.",
        "Add rows inside the tables (Tab in the last row) so dropdowns and the legend extend with them.",
    ]:
        r += 1
        ws.cell(r, 1, "-")
        ws.cell(r, 2, line)
    r += 2
    ws.cell(r, 1, "Column owners").font = HEAD_FONT
    ws.cell(r, 2, "Field group").font = HEAD_FONT
    ws.cell(r, 3, "Owner team").font = HEAD_FONT
    for grp, owner in [("Identity and classification", "Brand team"), ("Distribution, contacts, margins", "Brand team"),
                       ("Listing, comms, floor plan", "Brand team / Comms"), ("VPA", "Commercial"),
                       ("Data set-up and registration", "Registration"), ("Project communication", "Comms"),
                       ("Vendor set-up, ICF, PO", "Supply"), ("Schematics, fixtures, VM install", "VM"),
                       ("Feedback columns", "Brand team")]:
        r += 1
        ws.cell(r, 2, grp)
        ws.cell(r, 3, owner)
    if extra:
        r += 2
        ws.cell(r, 1, extra["title"]).font = HEAD_FONT
        for row in extra["rows"]:
            r += 1
            for j, v in enumerate(row):
                _as_text(ws.cell(r, 1 + j, v))
    return ws


# ---------------------------------------------------------------- dashboard
def _dashboard(wb, data):
    ws = wb["Dashboard"]
    ws.column_dimensions["A"].width = 30
    for c in "BCDEFGH":
        ws.column_dimensions[c].width = 13
    ws["A1"] = "Launch dashboard"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = "Every number is a formula over the tables. Change the yellow cells to look at another launch or store."
    inp = _fill("FFF2CC")
    ws["A4"] = "Launch"
    ws["B4"] = data.get("dashboard_launch")
    ws["B4"].fill = inp
    ws["A5"] = "Stores"
    stores = data.get("dashboard_stores", [])
    for j in range(4):
        c = ws.cell(5, 2 + j, stores[j] if j < len(stores) else None)
        c.fill = inp
    dv = DataValidation(type="list", formula1="lst_Launch", allow_blank=True)
    dv.add("B4")
    ws.add_data_validation(dv)
    dv2 = DataValidation(type="list", formula1="lst_Store", allow_blank=True)
    dv2.add("B5:E5")
    ws.add_data_validation(dv2)

    def listed(store_cell, extra=""):
        parts = []
        for n in (1, 2):
            parts.append(f'COUNTIFS(tblLines[Launch],$B$4,tblLines[Store {n}],{store_cell},tblLines[S{n} Listing],"Yes"{extra})')
        return f'IF({store_cell}="","",{"+".join(parts)})'

    r = 7
    ws.cell(r, 1, "Lines in launch").font = HEAD_FONT
    ws.cell(r, 2, '=COUNTIFS(tblLines[Launch],$B$4)')
    r += 2
    ws.cell(r, 1, "Brands listed per zone and store").font = HEAD_FONT
    for j in range(4):
        ws.cell(r, 2 + j, f'=IF({get_column_letter(2 + j)}$5="","",{get_column_letter(2 + j)}$5)').font = HEAD_FONT
    zstart = r + 1
    for i, _z in enumerate(VOCAB["Zone"]):
        r += 1
        ws.cell(r, 1, f"=INDEX(lst_Zone,{i + 1})")
        for j in range(4):
            sc = f"{get_column_letter(2 + j)}$5"
            ws.cell(r, 2 + j, "=" + listed(sc, f",tblLines[Zone],$A{r}"))
    r += 1
    ws.cell(r, 1, "Listed, no zone given")
    for j in range(4):
        sc = f"{get_column_letter(2 + j)}$5"
        ws.cell(r, 2 + j, "=" + listed(sc, ',tblLines[Zone],""'))
    r += 1
    ws.cell(r, 1, "Total listed").font = HEAD_FONT
    for j in range(4):
        L = get_column_letter(2 + j)
        ws.cell(r, 2 + j, f'=IF({L}$5="","",SUM({L}{zstart}:{L}{r - 1}))').font = HEAD_FONT
    r += 1
    ws.cell(r, 1, "Check: all listed lines")
    for j in range(4):
        sc = f"{get_column_letter(2 + j)}$5"
        ws.cell(r, 2 + j, "=" + listed(sc))
    dash = {"total_listed_row": r - 1, "zone_rows": (zstart, r - 3)}

    r += 2
    ws.cell(r, 1, "Brand-code mix").font = HEAD_FONT
    ws.cell(r, 2, "Lines").font = HEAD_FONT
    ws.cell(r, 3, "Share").font = HEAD_FONT
    ws.cell(r, 4, "of which double").font = HEAD_FONT
    for i, (code, _m, colour) in enumerate(LEGEND):
        r += 1
        ws.cell(r, 1, f"=INDEX(lst_BrandCode,{i + 1})").fill = _fill(colour)
        ws.cell(r, 2, f'=COUNTIFS(tblLines[Launch],$B$4,tblLines[Brand code],$A{r})')
        ws.cell(r, 3, f'=IFERROR(B{r}/$B$7,0)').number_format = "0.0%"
        ws.cell(r, 4, f'=COUNTIFS(tblLines[Launch],$B$4,tblLines[Brand code],$A{r},tblLines[Double placement],"Yes")')

    r += 2
    ws.cell(r, 1, "Penetration plan by main category").font = HEAD_FONT
    pstart = r + 1
    for i, _c in enumerate(VOCAB["MainCategory"]):
        r += 1
        ws.cell(r, 1, f"=INDEX(lst_MainCategory,{i + 1})")
        ws.cell(r, 2, f'=SUMIFS(tblLines[Penetration plan],tblLines[Launch],$B$4,tblLines[Main category],$A{r})').number_format = "0.0%"
    r += 1
    ws.cell(r, 1, "Total").font = HEAD_FONT
    ws.cell(r, 2, f"=SUM(B{pstart}:B{r - 1})").number_format = "0.0%"

    # Per-store gates: value x store
    for gate, vocab in [("Listing", "Listing"), ("Comms", "Comms"), ("Floor plan", "FloorPlan"), ("PO", "PO"),
                        ("At launch", "AtLaunch")]:
        r += 2
        ws.cell(r, 1, f"{gate} per store").font = HEAD_FONT
        for j in range(4):
            ws.cell(r, 2 + j, f'=IF({get_column_letter(2 + j)}$5="","",{get_column_letter(2 + j)}$5)').font = HEAD_FONT
        for i, _v in enumerate(VOCAB[vocab] + [""]):
            r += 1
            ws.cell(r, 1, f"=INDEX(lst_{vocab},{i + 1})" if _v else "(blank)")
            for j in range(4):
                sc = f"{get_column_letter(2 + j)}$5"
                crit = f"$A{r}" if _v else '""'
                parts = [f"COUNTIFS(tblLines[Launch],$B$4,tblLines[Store {n}],{sc},tblLines[S{n} {gate}],{crit})" for n in (1, 2)]
                ws.cell(r, 2 + j, f'=IF({sc}="","",{"+".join(parts)})')
        if vocab in DONE:
            r += 1
            ws.cell(r, 1, "Done").font = HEAD_FONT
            for j in range(4):
                sc = f"{get_column_letter(2 + j)}$5"
                parts = [f'COUNTIFS(tblLines[Launch],$B$4,tblLines[Store {n}],{sc},tblLines[S{n} {gate}],"{d}")'
                         for n in (1, 2) for d in DONE[vocab]]
                ws.cell(r, 2 + j, f'=IF({sc}="","",{"+".join(parts)})').font = HEAD_FONT

    # Line-level gates: value counts for the launch
    for gate, vocab in [("VPA status", "VPA"), ("Data set-up", "Registration"), ("Project comms", "ProjectComms"),
                        ("Schematics", "Schematics"), ("Vendor set-up route", "VendorRoute"),
                        ("Vendor set-up state", "VendorState"), ("ICF", "ICF"),
                        ("Supplier opening form", "SupplierForm"), ("Order shared", "OrderShared")]:
        r += 2
        ws.cell(r, 1, gate).font = HEAD_FONT
        ws.cell(r, 2, "Lines").font = HEAD_FONT
        ws.cell(r, 3, "Share").font = HEAD_FONT
        for i, _v in enumerate(VOCAB[vocab] + [""]):
            r += 1
            ws.cell(r, 1, f"=INDEX(lst_{vocab},{i + 1})" if _v else "(blank)")
            crit = f"$A{r}" if _v else '""'
            ws.cell(r, 2, f"=COUNTIFS(tblLines[Launch],$B$4,tblLines[{gate}],{crit})")
            ws.cell(r, 3, f"=IFERROR(B{r}/$B$7,0)").number_format = "0.0%"
        if vocab in DONE:
            r += 1
            ws.cell(r, 1, "Done").font = HEAD_FONT
            parts = [f'COUNTIFS(tblLines[Launch],$B$4,tblLines[{gate}],"{d}")' for d in DONE[vocab]]
            ws.cell(r, 2, "=" + "+".join(parts)).font = HEAD_FONT
            ws.cell(r, 3, f"=IFERROR(B{r}/$B$7,0)").number_format = "0.0%"

    r += 2
    ws.cell(r, 1, "Fixture capacity vs allocation").font = HEAD_FONT
    for j in range(4):
        ws.cell(r, 2 + 2 * j, f'=IF({get_column_letter(2 + j)}$5="","",{get_column_letter(2 + j)}$5&" capacity")').font = HEAD_FONT
        ws.cell(r, 3 + 2 * j, f'=IF({get_column_letter(2 + j)}$5="","",{get_column_letter(2 + j)}$5&" allocated")').font = HEAD_FONT
    for i, _t in enumerate(VOCAB["FixtureType"]):
        r += 1
        ws.cell(r, 1, f"=INDEX(lst_FixtureType,{i + 1})")
        for j in range(4):
            sc = f"${get_column_letter(2 + j)}$5"
            ws.cell(r, 2 + 2 * j, f'=IF({sc}="","",SUMIFS(tblCapacity[Count],tblCapacity[Store],{sc},tblCapacity[Fixture type],$A{r}))')
            parts = [f"COUNTIFS(tblLines[Launch],$B$4,tblLines[Store {n}],{sc},tblLines[S{n} Fixture type],$A{r})" for n in (1, 2)]
            ws.cell(r, 3 + 2 * j, f'=IF({sc}="","",{"+".join(parts)})')
    for col in range(2, 10):
        ws.column_dimensions[get_column_letter(col)].width = 13

    old = data.get("old_kpi")
    if old:
        r += 3
        ws.cell(r, 1, "Old KPI cells, as found (for comparison only)").font = HEAD_FONT
        r += 1
        for j, h in enumerate(["Cell", "Formula or typed value", "Value shown", "Why it was wrong"]):
            ws.cell(r, 1 + j, h).font = HEAD_FONT
        for row in old:
            r += 1
            for j, v in enumerate(row):
                _as_text(ws.cell(r, 1 + j, v))
    ws.freeze_panes = "B6"
    return dash


# ---------------------------------------------------------------- build
def build(path, data=None):
    """Write the organised workbook. `data` maps table name -> list of row dicts,
    plus optional keys: readme_extra, dashboard_launch, dashboard_stores, old_kpi, sheet_titles."""
    data = data or {}
    wb = Workbook()
    wb.remove(wb.active)
    for s in SHEETS:
        wb.create_sheet(s)
    lay = _Layout()
    for s in SHEETS[1:-1]:
        wb[s]["A1"] = s
        wb[s]["A1"].font = TITLE_FONT
    _lists_sheet(wb, lay)
    titles = data.get("sheet_titles", {})
    for s in SHEETS:
        if s in SHEET_NOTES and s != "Lists":
            wb[s]["B1"] = SHEET_NOTES[s]
        for coord, v in titles.get(s, {}).items():
            wb[s][coord] = v
            _as_text(wb[s][coord])
    for tname in TABLES:
        _write_table(wb, lay, tname, data.get(tname, []))
    _workspace_names(wb)
    _validate(wb, lay)
    _legend_rules(wb, lay)
    _read_me(wb, data.get("readme_extra"))
    dash = _dashboard(wb, data)
    wl = wb["Lines"]
    _s, r0, _c, _n = lay.where["tblLines"]
    heads = [h for h, *_ in TABLES["tblLines"][1]]
    wl.freeze_panes = wl.cell(r0 + 1, heads.index("Brand") + 2)
    wb.calculation.fullCalcOnLoad = True
    # openpyxl writes floats with 16 significant digits; write the shortest exact form instead
    from openpyxl.cell import _writer
    plain = getattr(_writer, "safe_string", None)
    if plain is None:
        raise RuntimeError(f"launch_workbook needs openpyxl {OPENPYXL_VERSION} (see requirements.txt); this openpyxl "
                           "has no openpyxl.cell._writer.safe_string hook for exact float writing")
    _writer.safe_string = lambda v: repr(v) if isinstance(v, float) and v == v and abs(v) != float("inf") else plain(v)
    try:
        wb.save(path)
    finally:
        _writer.safe_string = plain
    return {"tables": lay.where, "dashboard": dash}


if __name__ == "__main__":
    import sys
    build(sys.argv[1] if len(sys.argv) > 1 else "launch-workbook-template.xlsx")
