#!/usr/bin/env python3
"""Lint generated fuck-my-shit-mountain audit reports."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SEVERITIES = ("Critical", "High", "Medium", "Low", "Info")

REQUIRED_TEXT_SECTIONS = (
    "Executive Summary",
    "Project Map",
    "Coverage Matrix",
    "Finding Statistics",
    "Top Risks",
    "Detailed Findings",
    "Recommended Fix Order",
    "Quick Wins",
)

REQUIRED_HTML_IDS = (
    "summary",
    "executive-summary",
    "coverage",
    "findings",
    "fix-order",
)

FULL_SECTION_IDS = (
    "architecture",
    "security",
    "stability",
    "performance",
    "testing",
    "maintainability",
    "design",
    "release",
    "documentation",
    "configuration",
    "observability",
    "data-integrity",
    "privacy",
    "accessibility",
    "supply-chain",
    "cost",
    "ai-safety",
    "fallback",
    "testing-authenticity",
    "type-safety",
    "frontend-state",
    "backend-api",
    "dependency-weight",
    "code-consistency",
    "comment-coverage",
)

MODE_TO_SECTION_IDS = {
    "full": FULL_SECTION_IDS,
    **{section_id: (section_id,) for section_id in FULL_SECTION_IDS},
}

MARKDOWN_SECTION_PATTERNS = {
    "architecture": r"Architecture",
    "security": r"Security",
    "stability": r"Stability",
    "performance": r"Performance",
    "testing": r"Testing",
    "maintainability": r"Maintainability",
    "design": r"Design",
    "release": r"Release",
    "documentation": r"Documentation",
    "configuration": r"Configuration",
    "observability": r"Observability",
    "data-integrity": r"Data Integrity",
    "privacy": r"Privacy",
    "accessibility": r"Accessibility",
    "supply-chain": r"Supply Chain",
    "cost": r"Cost",
    "ai-safety": r"AI.*Safety|LLM.*Safety",
    "fallback": r"Fallback",
    "testing-authenticity": r"Testing Authenticity",
    "type-safety": r"Type Safety",
    "frontend-state": r"Frontend State",
    "backend-api": r"Backend API",
    "dependency-weight": r"Dependency Weight",
    "code-consistency": r"Code Consistency",
    "comment-coverage": r"Comment Coverage",
}

REQUIRED_FINDING_FIELDS = (
    "Severity",
    "Confidence",
    "Category",
    "Status",
    "Affected area",
    "Evidence",
    "Problem",
    "Why it matters",
    "Realistic failure scenario",
    "Minimal fix",
    "Better long-term fix",
    "Regression test suggestion",
    "Estimated effort",
)

PLACEHOLDER_PATTERNS = (
    re.compile(r"\[\[[A-Z0-9_ -]+\]\]"),
    re.compile(
        r"<(?:project name|date|AI model / version|full / security|N|dimension|files, commands, patterns, runtime surfaces|what was not inspected and why|short title|selected modes?)>",
        re.IGNORECASE,
    ),
)

SECRET_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----"),
    re.compile(
        r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b\s*[:=]\s*['\"]?(?!<redacted>|redacted\b)[A-Za-z0-9_./+=:-]{16,}"
    ),
)


def add_issue(issues: list[str], message: str) -> None:
    issues.append(message)


def lint_placeholders(text: str, issues: list[str]) -> None:
    for pattern in PLACEHOLDER_PATTERNS:
        match = pattern.search(text)
        if match:
            add_issue(issues, f"Unreplaced template placeholder: {match.group(0)!r}")


def lint_secrets(text: str, issues: list[str]) -> None:
    for pattern in SECRET_PATTERNS:
        match = pattern.search(text)
        if match:
            add_issue(issues, f"Possible unredacted secret near: {match.group(0)[:48]!r}")


def lint_required_sections(text: str, is_html: bool, issues: list[str]) -> None:
    if is_html:
        for section_id in REQUIRED_HTML_IDS:
            if f'id="{section_id}"' not in text and f"id='{section_id}'" not in text:
                add_issue(issues, f"Missing HTML section id: {section_id}")
        return

    for section in REQUIRED_TEXT_SECTIONS:
        if section not in text:
            add_issue(issues, f"Missing report section: {section}")


def expand_modes(modes: str | None, issues: list[str]) -> tuple[str, ...]:
    if not modes:
        return ()

    section_ids: list[str] = []
    for raw_mode in re.split(r"[, ]+", modes.strip().lower()):
        if not raw_mode:
            continue
        mapped = MODE_TO_SECTION_IDS.get(raw_mode)
        if mapped is None:
            add_issue(issues, f"Unknown audit mode for section check: {raw_mode}")
            continue
        for section_id in mapped:
            if section_id not in section_ids:
                section_ids.append(section_id)
    return tuple(section_ids)


def lint_mode_sections(text: str, is_html: bool, modes: str | None, issues: list[str]) -> None:
    section_ids = expand_modes(modes, issues)
    if not section_ids:
        return

    for section_id in section_ids:
        if is_html:
            if f'id="{section_id}"' not in text and f"id='{section_id}'" not in text:
                add_issue(issues, f"Missing selected dimension HTML section id: {section_id}")
            continue

        pattern = MARKDOWN_SECTION_PATTERNS[section_id]
        if re.search(rf"(?mi)^##+\s+.*(?:{pattern})", text) is None:
            add_issue(issues, f"Missing selected dimension Markdown section: {section_id}")


def finding_chunks(text: str) -> list[str]:
    starts = [m.start() for m in re.finditer(r"(?m)^### Finding:", text)]
    chunks: list[str] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(text)
        chunks.append(text[start:end])
    return chunks


def lint_markdown_findings(text: str, issues: list[str]) -> None:
    chunks = finding_chunks(text)
    if not chunks:
        return

    for idx, chunk in enumerate(chunks, start=1):
        for field in REQUIRED_FINDING_FIELDS:
            if re.search(rf"(?mi)^-\s*{re.escape(field)}\s*:", chunk) is None:
                add_issue(issues, f"Finding #{idx} missing field: {field}")


def parse_stats_table(text: str) -> dict[str, int] | None:
    stats: dict[str, int] = {}
    for severity in SEVERITIES:
        match = re.search(rf"(?mi)^\|\s*{severity}\s*\|\s*(\d+)\s*\|", text)
        if match:
            stats[severity] = int(match.group(1))
    return stats or None


def lint_markdown_stats(text: str, issues: list[str]) -> None:
    expected = parse_stats_table(text)
    if not expected:
        return

    actual = {severity: 0 for severity in SEVERITIES}
    for match in re.finditer(r"(?mi)^-\s*Severity\s*:\s*(Critical|High|Medium|Low|Info)\b", text):
        actual[match.group(1)] += 1

    for severity, expected_count in expected.items():
        if actual[severity] != expected_count:
            add_issue(
                issues,
                f"Severity count mismatch for {severity}: stats table has {expected_count}, detailed findings have {actual[severity]}",
            )

    total_match = re.search(r"(?mi)^\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|", text)
    if total_match:
        expected_total = int(total_match.group(1))
        actual_total = sum(actual.values())
        if actual_total != expected_total:
            add_issue(issues, f"Total finding count mismatch: stats table has {expected_total}, detailed findings have {actual_total}")


def lint_report(path: Path, modes: str | None = None) -> list[str]:
    text = path.read_text(encoding="utf-8")
    is_html = path.suffix.lower() in {".html", ".htm"}
    issues: list[str] = []

    lint_placeholders(text, issues)
    lint_secrets(text, issues)
    lint_required_sections(text, is_html, issues)
    lint_mode_sections(text, is_html, modes, issues)

    if not is_html:
        lint_markdown_findings(text, issues)
        lint_markdown_stats(text, issues)

    return issues


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Lint generated audit reports for missing structure and unsafe leftovers.")
    parser.add_argument("--modes", help="Comma-separated selected audit modes, for example 'full' or 'security,release'")
    parser.add_argument("reports", nargs="+", type=Path, help="Generated .md or .html report paths")
    args = parser.parse_args(argv)

    exit_code = 0
    for report in args.reports:
        if not report.exists():
            print(f"{report}: missing file", file=sys.stderr)
            exit_code = 2
            continue
        issues = lint_report(report, args.modes)
        if issues:
            exit_code = 1
            print(f"{report}: FAIL")
            for issue in issues:
                print(f"  - {issue}")
        else:
            print(f"{report}: OK")

    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
