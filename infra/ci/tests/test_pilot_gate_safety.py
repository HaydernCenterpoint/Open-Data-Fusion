from __future__ import annotations

import unittest

from infra.pilot_gate.safety import (
    UnsafeEvidenceError,
    assert_safe_json,
    redact_text,
)


class PilotEvidenceSafetyTests(unittest.TestCase):
    def test_rejects_normalized_forbidden_keys_at_any_depth(self) -> None:
        with self.assertRaisesRegex(UnsafeEvidenceError, "Authorization_Header"):
            assert_safe_json(
                {"checks": [{"result": {"Authorization_Header": "opaque"}}]}
            )

    def test_rejects_all_forbidden_key_categories_after_normalization(self) -> None:
        forbidden_keys = (
            "Cookie",
            "Set-Cookie",
            "operatorPassword",
            "client_secret",
            "accessToken",
            "tlsPrivateKey",
            "tlsCertificate",
            "database-url",
            "objectStoreSignedUrl",
            "raw_payload_export",
            "rawRowsExport",
            "payload",
            "rows",
            "sourceRecords",
            "stdout",
            "stderr",
            "applicationLogs",
        )

        for key in forbidden_keys:
            with self.subTest(key=key), self.assertRaisesRegex(
                UnsafeEvidenceError, key.replace("-", "\\-")
            ):
                assert_safe_json({key: "opaque"})

    def test_rejects_non_string_keys_recursively(self) -> None:
        with self.assertRaisesRegex(UnsafeEvidenceError, "non-string key"):
            assert_safe_json({"checks": [{7: "not valid JSON"}]})

    def test_rejects_values_outside_the_json_data_model(self) -> None:
        unsupported_values = (("tuple",), b"bytes", {"set"}, object())

        for value in unsupported_values:
            with self.subTest(type=type(value).__name__), self.assertRaisesRegex(
                UnsafeEvidenceError, "unsupported evidence type"
            ):
                assert_safe_json({"summary": [value]})

    def test_rejects_non_finite_floats_recursively(self) -> None:
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value), self.assertRaisesRegex(
                UnsafeEvidenceError, "finite numbers"
            ):
                assert_safe_json({"metrics": [{"observed": value}]})

    def test_rejects_and_redacts_every_authorization_scheme(self) -> None:
        cases = (
            ("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
            ("authorization = Bearer abc.def.ghi", "abc.def.ghi"),
            (
                '"Authorization": "Digest username=\\"pilot\\", response=\\"opaque\\""',
                "opaque",
            ),
        )

        for value, secret in cases:
            with self.subTest(value=value):
                with self.assertRaisesRegex(
                    UnsafeEvidenceError, "prohibited secret material"
                ):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual(count, 1)
                self.assertNotIn(secret, redacted)
                self.assertIn("[REDACTED]", redacted)

    def test_rejects_and_redacts_cookie_headers(self) -> None:
        for header in ("Cookie", "Set-Cookie"):
            with self.subTest(header=header):
                value = f"{header}: session=opaque-cookie; HttpOnly; Secure"
                with self.assertRaises(UnsafeEvidenceError):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual(count, 1)
                self.assertNotIn("opaque-cookie", redacted)

    def test_rejects_and_redacts_pem_private_keys_and_certificates(self) -> None:
        cases = (
            (
                "-----BEGIN RSA PRIVATE KEY-----\nopaque-private-key\n"
                "-----END RSA PRIVATE KEY-----",
                "opaque-private-key",
            ),
            (
                "-----BEGIN CERTIFICATE-----\nopaque-certificate\n"
                "-----END CERTIFICATE-----",
                "opaque-certificate",
            ),
        )

        for value, secret in cases:
            with self.subTest(secret=secret):
                with self.assertRaises(UnsafeEvidenceError):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual(count, 1)
                self.assertNotIn(secret, redacted)

    def test_rejects_and_redacts_common_credential_assignments(self) -> None:
        cases = (
            ("ACCESS_TOKEN=access-opaque", "access-opaque"),
            ("refresh-token: refresh-opaque", "refresh-opaque"),
            ('client_secret = "client-opaque"', "client-opaque"),
            ("apiKey=api-opaque", "api-opaque"),
            ("password=password-opaque", "password-opaque"),
            ("AWS_ACCESS_KEY_ID=AKIAEXAMPLE", "AKIAEXAMPLE"),
            ("AWS_SECRET_ACCESS_KEY=aws-secret", "aws-secret"),
            ("AWS_SESSION_TOKEN=aws-session", "aws-session"),
        )

        for value, secret in cases:
            with self.subTest(value=value):
                with self.assertRaises(UnsafeEvidenceError):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual(count, 1)
                self.assertNotIn(secret, redacted)

    def test_rejects_and_redacts_credential_bearing_uris(self) -> None:
        cases = (
            ("postgresql://pilot:db-pass@db.example/odf", "db-pass"),
            ("redis://:cache-pass@redis.example:6379/0", "cache-pass"),
            ("https://api-user:http-pass@example.test/path", "http-pass"),
            ("amqps://worker:broker-pass@mq.example/vhost", "broker-pass"),
        )

        for value, secret in cases:
            with self.subTest(value=value):
                with self.assertRaises(UnsafeEvidenceError):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual(count, 1)
                self.assertNotIn(secret, redacted)

    def test_rejects_and_redacts_connection_url_assignments(self) -> None:
        values = (
            "DATABASE_URL=postgresql://db.example/odf",
            "REDIS_URL=redis://cache.example:6379/0",
            'MONGODB_URI="mongodb://mongo.example/odf"',
            "BROKER_URL=amqps://mq.example/vhost",
        )

        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(UnsafeEvidenceError):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual((redacted, count), ("[REDACTED]", 1))

    def test_rejects_and_redacts_signed_query_credentials(self) -> None:
        values = (
            "https://objects.example/pilot?X-Amz-Signature=deadbeef&part=1",
            "https://objects.example/pilot?X-Goog-Signature=deadbeef",
            "https://api.example/export?access_token=opaque-token",
        )

        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(UnsafeEvidenceError):
                    assert_safe_json({"summary": value})
                redacted, count = redact_text(value)
                self.assertEqual((redacted, count), ("[REDACTED]", 1))

    def test_allows_ordinary_security_summaries(self) -> None:
        value = (
            "Authorization checks passed; cookie policy enabled; "
            "database URL validation and API key rotation completed"
        )

        assert_safe_json({"summary": value, "metrics": {"checksPassed": 4}})
        self.assertEqual(redact_text(value), (value, 0))


if __name__ == "__main__":
    unittest.main()
