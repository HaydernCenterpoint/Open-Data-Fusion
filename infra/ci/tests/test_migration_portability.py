"""Regression coverage for cross-platform container-bound artifacts."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


class MigrationPortabilityTests(unittest.TestCase):
    def assert_lf_only(self, paths: list[Path]) -> None:
        offenders = [
            path.relative_to(ROOT)
            for path in sorted(paths)
            if b"\r\n" in path.read_bytes()
        ]

        self.assertEqual([], offenders)

    def test_container_bound_shell_scripts_use_lf(self) -> None:
        self.assert_lf_only(list((ROOT / "infra").rglob("*.sh")))

    def test_migrations_and_manifest_use_lf(self) -> None:
        migrations = ROOT / "infra" / "postgres" / "migrations"
        self.assert_lf_only([*migrations.glob("*.sql"), migrations / "SHA256SUMS"])

    def test_rehearsal_csv_fixtures_use_lf(self) -> None:
        self.assert_lf_only(list((ROOT / "infra" / "security" / "rehearsal").glob("*.csv")))

    def test_migration_manifest_is_canonicalized_before_comparison(self) -> None:
        script = (ROOT / "infra" / "postgres" / "scripts" / "migrate.sh").read_text(encoding="utf-8")

        self.assertIn("sed 's/\\r$//' SHA256SUMS | sort -k 2", script)


if __name__ == "__main__":
    unittest.main()
