# Launch workbook template

`launch-workbook-template.xlsx` is the empty organised launch workbook (product spec, section 7).
The importer reads this layout and the exporter writes it. It holds no launch data:
no brands, stores, vendors, contacts or margins.

`launch_workbook.py` defines the schema (tables, columns, value lists, colour legend) and writes the
workbook. Rebuild the template after changing the schema:

```
python3 launch_workbook.py launch-workbook-template.xlsx
```

An importer fills it by passing rows per table: `build(path, {"tblLines": [...], ...})`.

## Layout

- Sheets: Read me, Lines, Brands, Distribution by market, Vendors & contacts, Stores & capacity,
  Installs & deliveries, Market visits, US NPD & replenishment, Dashboard, Lists.
- Each block is an Excel table. Headers are on row 4 and tables sit side by side, so every table grows downward.
- Coded columns have dropdowns bounded to the table body. They read `lst_<List>` names, which point at
  `tblList_<List>` tables on Lists. Store, launch, brand team, brand and vendor dropdowns read the workspace
  tables (Stores, Launches, Brand teams, Brands, Vendors).
- The colour legend is one rule set on Lines (Brand code and Brand columns).
- The Dashboard is formulas only, over the tables. Choose the launch in B4 and up to four stores in B5:E5.
- No hidden sheets, rows or columns.

Field meanings, value lists and the mapping from the old Qatar tracker columns are in the tm8 doc
"Launch tracker data dictionary" (01a188ce-908b-7e7f-846f-e2bc7e7e37f3).

Real launch workbooks hold names, contacts and margins. Never commit one: keep them in tm8 as files on their tasks.
