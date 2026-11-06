#!/usr/bin/env python3
"""Exercise the shipped stdio bridge and live app using disposable data only.
Linux: run under xvfb-run/dbus-run-session. Windows: hosted CI runners only.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True, type=Path)
    args = parser.parse_args()
    executable = str(args.executable.resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="klaxon-agent-smoke-") as temporary:
        root = Path(temporary)
        env = os.environ.copy()
        if os.name == "nt":
            if env.get("GITHUB_ACTIONS") != "true" or env.get("RUNNER_ENVIRONMENT") != "github-hosted":
                raise RuntimeError("Windows smoke requires a disposable GitHub-hosted runner")
            app_dir = Path(env["APPDATA"]) / "com.klaxon.app"
        else:
            env["XDG_DATA_HOME"] = str(root / "data")
            env["XDG_CONFIG_HOME"] = str(root / "config")
            env["WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"] = "1"  # root inside disposable Linux container
            app_dir = root / "data" / "com.klaxon.app"
        if app_dir.exists():
            raise RuntimeError("Refusing an existing Klaxon profile")
        directory = app_dir / "agent-access"
        directory.mkdir(parents=True)
        client_id = str(uuid.uuid4())
        readonly_id = str(uuid.uuid4())
        clients = [dict(id=client_id, name="Disposable write client", token=uuid.uuid4().hex * 2, write=True),
                   dict(id=readonly_id, name="Disposable read client", token=uuid.uuid4().hex * 2, write=False)]
        (directory / "clients.json").write_text(json.dumps(clients))
        processes = []
        log = (root / "app.log").open("w")
        try:
            app = subprocess.Popen([executable], env=env, stdout=log, stderr=log)
            processes.append(app)
            deadline = time.monotonic() + 45
            while not (directory / "endpoint.json").exists():
                if app.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Disposable app failed to start")
                time.sleep(.1)

            def connect(identity):
                process = subprocess.Popen([executable, "--mcp", "--client", identity, "--agent-directory", str(directory)],
                                           env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
                processes.append(process)
                messages = queue.Queue()
                def drain():
                    for line in process.stdout:
                        messages.put(json.loads(line))
                threading.Thread(target=drain, daemon=True).start()
                count = 0
                def request(method, params=None):
                    nonlocal count
                    count += 1
                    process.stdin.write(json.dumps(dict(jsonrpc="2.0", id=count, method=method, params=params or {})) + "\n")
                    process.stdin.flush()
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        message = messages.get(timeout=max(.1, deadline-time.monotonic()))
                        if message.get("id") == count:
                            if "error" in message:
                                raise RuntimeError(f"MCP protocol error: {message['error']}")
                            return message["result"]
                    raise RuntimeError("MCP response timed out")
                request("initialize", {"protocolVersion":"2025-03-26", "capabilities":{}, "clientInfo":{"name":"klaxon-smoke", "version":"1"}})
                process.stdin.write(json.dumps({"jsonrpc":"2.0","method":"notifications/initialized"}) + "\n")
                process.stdin.flush()
                return request

            request = connect(client_id)
            read = connect(readonly_id)
            tools = request("tools/list")["tools"]
            assert any(t["name"] == "add_step" for t in tools)
            assert all(t["name"] not in {"create_task","add_step"} for t in read("tools/list")["tools"])
            def tool(name, arguments, call=request):
                return call("tools/call", {"name":name,"arguments":arguments})
            def data(result):
                assert not result.get("isError"), result
                return result["structuredContent"]
            revision = data(tool("get_planning_context", {}))["revision"]
            create = {"title":"Disposable MCP task", "operation_id":str(uuid.uuid4()), "expected_revision":revision}
            denied = tool("create_task", create, read)
            assert denied.get("isError"), denied
            created = data(tool("create_task", create))
            task_id = created["data"]["id"]
            assert data(tool("create_task", create)) == created, "lost reply retry must not duplicate"
            stale = {**create, "operation_id":str(uuid.uuid4())}
            assert tool("create_task", stale).get("isError"), "stale revision must fail"
            revision = created["revision"]
            steps = []
            for title in ["Publish", "Test"]:
                result = data(tool("add_step", {"task_id":task_id,"title":title,"operation_id":str(uuid.uuid4()),"expected_revision":revision}))
                steps.append(result["data"]["id"])
                revision = result["revision"]
            moved = data(tool("move_step", {"id":steps[1],"before_id":steps[0],"operation_id":str(uuid.uuid4()),"expected_revision":revision}))
            actual = data(tool("get_item", {"kind":"task","id":task_id}))["data"]
            assert [s["title"] for s in actual["steps"]] == ["Test","Publish"]
            assert len(data(tool("get_planning_context", {}))["data"]["items"]) == 1
            print("PASS live MCP: initialization, grants, task creation, retry, conflicts, ordered steps and reads")
        except Exception:
            log.flush()
            print((root / "app.log").read_text(errors="replace")[-5000:])
            raise
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            log.close()
            # We refused a preexisting directory, so only this fixture can be removed.
            if os.name == "nt":
                shutil.rmtree(app_dir)


if __name__ == "__main__":
    main()
