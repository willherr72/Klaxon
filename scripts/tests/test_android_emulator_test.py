"""Runner must reject Android's exit-zero failures and missing test execution."""

import importlib.util
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
