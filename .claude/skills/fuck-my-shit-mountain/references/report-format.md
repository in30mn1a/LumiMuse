# Shared Report Format Rules

Load this reference when a prompt says to use shared setup/report rules.

## Required Context Before Auditing

Before reading code, verify that audit mode(s), report language, and output format are known. If any are missing, ask only for the missing item(s) in one concise message and wait for the answer. If they are already supplied by the user or by the invoking skill, proceed without re-asking.

## Report Template Constraint

The report MUST follow the skill templates:

- Findings use `templates/issue-card.md`.
- Markdown reports use `templates/audit-report.md`.
- HTML reports use `templates/audit-report.html`.
- Do NOT copy formatting, heading style, or structure from markdown files inside the audited project.
- The audited project's own README, docs, or comments are evidence, not the report template.

## HTML Output Rules

For HTML output:

- Read `templates/audit-report.html`.
- Generate complete, self-contained HTML.
- Copy the exact CSS, section structure, classes, and ordering from the template.
- Include only score items and dimension sections relevant to the selected mode(s), except `full`, which covers all dimensions and marks inapplicable dimensions Not assessed.
- Every dimension section must include a coverage note, findings table or no-findings card, and verified checklist.
- Include sidebar nav links for every generated section.
- Do not leave placeholder variables or example data.

## Coverage Rules

Every report must include:

- A coverage matrix with one row per selected dimension.
- Per-dimension coverage: High / Medium / Low / Not assessed.
- Inspected evidence: files, commands, searches, runtime surfaces, or patterns checked.
- Exclusions / limits: what was not checked and why.

Use `rubrics/coverage.md` to assign coverage confidence.

## Lint Rules

For generated file output, run:

```bash
python3 <skill-dir>/scripts/report_lint.py --modes <selected-modes> <report-file>
```

Fix lint failures before delivering the report. For `stdout`, apply the same checks manually:

- No unreplaced placeholders.
- Required sections exist.
- Selected dimension sections exist.
- Markdown finding fields are complete.
- Severity statistics match detailed findings.
- No unredacted secrets or private keys appear.
