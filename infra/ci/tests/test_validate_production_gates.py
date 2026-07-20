"""Regression coverage for production-gate static validation."""

from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path


VALIDATOR_PATH = Path(__file__).resolve().parents[1] / "validate-production-gates.py"
SPEC = importlib.util.spec_from_file_location("validate_production_gates", VALIDATOR_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import setup failure
    raise RuntimeError("could not load production-gate validator")
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class ShellLineEndingValidationTests(unittest.TestCase):
    def test_rejects_crlf_shell_script(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            script = Path(temporary_directory) / "migrate.sh"
            script.write_bytes(b"#!/bin/sh\r\nset -eu\r\n")

            with self.assertRaisesRegex(AssertionError, "CRLF"):
                validator.require_lf_shell_scripts(Path(temporary_directory))

    def test_migration_manifest_is_lf_canonicalized(self) -> None:
        migration_script = (VALIDATOR_PATH.parents[2] / "infra/postgres/scripts/migrate.sh").read_text(encoding="utf-8")

        self.assertIn("sed 's/\\r$//' SHA256SUMS", migration_script)

    def test_workers_declare_otlp_log_runtime_dependencies(self) -> None:
        expected_dependencies = {
            "@opentelemetry/api-logs",
            "@opentelemetry/exporter-logs-otlp-http",
            "@opentelemetry/resources",
            "@opentelemetry/sdk-logs",
        }
        for worker in ("outbox-worker", "pipeline-worker"):
            with self.subTest(worker=worker):
                package = json.loads((VALIDATOR_PATH.parents[2] / f"apps/{worker}/package.json").read_text(encoding="utf-8"))
                dependencies = package.get("dependencies", {})

                self.assertTrue(expected_dependencies.issubset(dependencies), f"{worker} omits OTLP log runtime dependencies")


class WorkerOtlpWiringTests(unittest.TestCase):
    def test_production_like_compose_enables_otlp_logs_for_both_workers(self) -> None:
        compose = (VALIDATOR_PATH.parents[2] / "docker-compose.production-like.yml").read_text(encoding="utf-8")
        expected_settings = (
            'ODF_OTEL_ENABLED: "true"',
            "OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318",
            "OTEL_LOGS_EXPORTER: otlp",
            "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: http/protobuf",
        )

        for service in ("outbox-worker", "pipeline-worker"):
            with self.subTest(service=service):
                block = re.search(
                    rf"^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-z0-9-]+:|\Z)",
                    compose,
                    re.MULTILINE | re.DOTALL,
                )
                self.assertIsNotNone(block, f"production-like Compose does not override {service}")
                assert block is not None
                for expected in expected_settings:
                    self.assertIn(expected, block.group("body"))


class PipelineContainerDependencyTests(unittest.TestCase):
    def test_postgres_runtime_builds_its_platform_core_dependency(self) -> None:
        root = VALIDATOR_PATH.parents[2]
        package = json.loads((root / "packages/postgres-runtime/package.json").read_text(encoding="utf-8"))

        for lifecycle in ("prebuild", "pretest", "pretypecheck"):
            with self.subTest(lifecycle=lifecycle):
                self.assertIn("@open-data-fusion/platform-core", package["scripts"][lifecycle])

    def test_pipeline_image_contains_platform_core_at_build_and_runtime(self) -> None:
        dockerfile = (VALIDATOR_PATH.parents[2] / "Dockerfile.pipeline").read_text(encoding="utf-8")

        self.assertIn("COPY packages/contracts ./packages/contracts", dockerfile)
        self.assertIn("COPY packages/platform-core ./packages/platform-core", dockerfile)
        self.assertIn(
            "/workspace/packages/platform-core/package.json ./packages/platform-core/package.json",
            dockerfile,
        )
        self.assertIn(
            "/workspace/packages/platform-core/dist ./packages/platform-core/dist",
            dockerfile,
        )


class ComposeVolumeSyntaxTests(unittest.TestCase):
    def test_edge_config_bind_mount_uses_long_syntax(self) -> None:
        compose = (VALIDATOR_PATH.parents[2] / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn(
            """    volumes:
      - type: bind
        source: \"${ODF_EDGE_CONFIG_PATH:-./apps/edge-agent/config.example.json}\"
        target: /etc/open-data-fusion/edge-agent.json
        read_only: true
""",
            compose,
        )


class OutboxBrokerRehearsalTests(unittest.TestCase):
    def test_boolean_wait_queries_preserve_postgres_boolean_output(self) -> None:
        rehearsal = (VALIDATOR_PATH.parents[2] / "infra/ci/outbox-broker-rehearsal.sh").read_text(encoding="utf-8")

        self.assertNotIn(
            ")::text",
            rehearsal,
            "wait_for_postgres_value compares PostgreSQL boolean output to 't', not its text cast 'true'",
        )

    def test_recovery_cli_mode_checks_accept_compact_json(self) -> None:
        rehearsal = (VALIDATOR_PATH.parents[2] / "infra/ci/outbox-broker-rehearsal.sh").read_text(encoding="utf-8")

        for mode in ("read_only", "dry_run", "applied"):
            with self.subTest(mode=mode):
                self.assertIn(
                    f"grep -Eq '\"mode\"[[:space:]]*:[[:space:]]*\"{mode}\"'",
                    rehearsal,
                    "recovery CLI responses may be pretty-printed or compact JSON",
                )


class PilotGateAssetTests(unittest.TestCase):
    def test_checked_in_manifest_is_valid_and_non_secret(self) -> None:
        from infra.pilot_gate.contract import load_manifest

        path = VALIDATOR_PATH.parents[2] / "infra/pilot-gate.example.json"
        manifest = load_manifest(path)

        self.assertEqual(manifest.environment_id, "managed-staging")
        self.assertEqual(manifest.targets.evidence_retention_days, 90)
        self.assertTrue(manifest.scope.read_only)
        self.assertFalse(manifest.scope.writeback_authorized)
        raw = path.read_text(encoding="utf-8").lower()
        for forbidden in ("password", "privatekey", "authorization", "access_token"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, raw)

    def test_validator_references_the_pilot_contract(self) -> None:
        validator_text = VALIDATOR_PATH.read_text(encoding="utf-8")

        self.assertIn("infra/pilot-gate.example.json", validator_text)
        self.assertIn("REQUIRED_CHECK_IDS", validator_text)
        self.assertIn("load_manifest", validator_text)

    def test_package_exposes_the_pilot_gate_cli(self) -> None:
        package = json.loads(
            (VALIDATOR_PATH.parents[2] / "package.json").read_text(encoding="utf-8")
        )

        self.assertEqual(package["scripts"]["pilot:gate"], "python -m infra.pilot_gate")

    def test_operator_runbook_preserves_pilot_safety_boundaries(self) -> None:
        from infra.pilot_gate.contract import REQUIRED_CHECK_IDS
        from infra.pilot_gate.evaluation import (
            BOOLEAN_PROOFS_BY_CHECK,
            CONNECTOR_PROOFS_BY_KIND,
        )

        root = VALIDATOR_PATH.parents[2]
        runbook_path = root / "docs/operations/production-pilot-gate.md"
        runbook = runbook_path.read_text(encoding="utf-8")
        lowered = runbook.lower()

        for invariant in (
            "synthetic results do not satisfy",
            "failed predecessor",
            "independent reviewer",
            "pilot:gate -- evaluate",
            "read-only pilot scope",
            "managed staging",
            "stdout/stderr",
        ):
            with self.subTest(invariant=invariant):
                self.assertIn(invariant, lowered)
        self.assertIn("ODF_PILOT_REVIEWER_HMAC_KEY", runbook)
        self.assertIn("OIDC/KMS", runbook)
        required_names = set(REQUIRED_CHECK_IDS)
        required_names.update(
            proof
            for proofs in BOOLEAN_PROOFS_BY_CHECK.values()
            for proof in proofs
        )
        required_names.update(
            proof
            for proofs in CONNECTOR_PROOFS_BY_KIND.values()
            for proof in proofs
        )
        self.assertEqual(
            sorted(name for name in required_names if name not in runbook), []
        )

    def test_readme_discovers_the_runner_without_closing_live_drills(self) -> None:
        readme = (VALIDATOR_PATH.parents[2] / "README.md").read_text(
            encoding="utf-8"
        )

        self.assertIn("docs/operations/production-pilot-gate.md", readme)
        self.assertIn(
            "- [x] Add a provider-neutral Production Pilot Gate runner", readme
        )
        self.assertIn(
            "- [ ] Validate live design-partner CSV, JDBC/PostgreSQL, and OPC UA",
            readme,
        )


if __name__ == "__main__":
    unittest.main()
