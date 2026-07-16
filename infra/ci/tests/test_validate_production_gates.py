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


if __name__ == "__main__":
    unittest.main()
