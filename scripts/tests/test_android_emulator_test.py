"""Runner must reject Android's exit-zero failures and missing test execution."""

import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location(
    "android_emulator_test", Path(__file__).parents[1] / "android-emulator-test.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstrumentationResultTests(unittest.TestCase):
    def test_accepts_one_executed_test(self):
        module.require_test_success("INSTRUMENTATION_RESULT: stream=\nTime: 10.1\n\nOK (1 test)\n\nINSTRUMENTATION_CODE: -1\n")

    def test_rejects_missing_execution_and_exit_zero_failures(self):
        for output in (
            "INSTRUMENTATION_CODE: -1\n",
            "OK (0 tests)\n",
            "FAILURES!!!\nTests run: 1, Failures: 1\n",
            "INSTRUMENTATION_FAILED: com.klaxon.app.test\n",
            "INSTRUMENTATION_RESULT: shortMsg=Process crashed.\n",
            "OK (1 test)\nINSTRUMENTATION_RESULT: shortMsg=Process crashed.\n",
            "status text includes OK (1 test) without a real result\n",
        ):
            with self.subTest(output=output), self.assertRaises(RuntimeError):
                module.require_test_success(output)


class AppLogRetentionTests(unittest.TestCase):
    def retained(self, content):
        capture = module.AppLogCapture.__new__(module.AppLogCapture)
        capture.LIMIT = 10
        capture.head = bytearray()
        capture.tail = bytearray()
        capture.process = SimpleNamespace(stdout=io.BytesIO(content))
        capture.drain()
        return bytes(capture.head), bytes(capture.tail)

    def test_large_log_preserves_startup_and_final_lines_with_fixed_bound(self):
        self.assertEqual(self.retained(b"0123456789" + b"x" * 20000 + b"ABCDEFGHIJ"),
                         (b"0123456789", b"ABCDEFGHIJ"))

    def test_short_log_is_not_duplicated(self):
        self.assertEqual(self.retained(b"startup"), (b"startup", b""))


if __name__ == "__main__":
    unittest.main()
