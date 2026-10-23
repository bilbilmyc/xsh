import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { SHELL_INTEGRATION_COMMAND } from "../apps/desktop/src/terminal-completion.ts";

const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
test("real Bash prompt hooks preserve string/array hooks, prompt text and failed exit status", { skip: !existsSync(bash) }, () => {
  for (const array of [false, true]) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-i"], {
      input: [
        `PS1='fixture$ '; PS0='old-ps0'; ${array ? "PROMPT_COMMAND=('printf \"HOOK:%s\\\\n\" \"$?\"' 'printf \"TAIL\\\\n\"')" : "PROMPT_COMMAND='printf \"HOOK:%s\\\\n\" \"$?\"'"}`,
        SHELL_INTEGRATION_COMMAND,
        SHELL_INTEGRATION_COMMAND,
        "false",
        `printf 'BASH:%s\\nPS1:%s\\nPS0:%s\\n' "$BASH_VERSION" "$PS1" "$PS0"; declare -p PROMPT_COMMAND`,
        "exit",
      ].join("\n") + "\n",
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\x1b\]133;D;1\x07\x1b\]7;file:\/\/localhost[^\x07]+\x07HOOK:1/);
    const declaration = result.stdout.split("\n").find((line) => line.startsWith("declare -"));
    assert.ok(declaration);
    assert.equal(declaration.match(/__xsh_prompt_status_v2/g)?.length, 1);
    assert.match(result.stdout, /PS1:.*fixture\$/);
    const version = result.stdout.match(/^BASH:(\d+)\.(\d+)/m);
    assert.ok(version);
    const supportsPromptArrays = Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2]) >= 1);
    if (array && supportsPromptArrays) {
      assert.match(result.stdout, /\x07HOOK:1\nTAIL\n/);
    } else {
      assert.doesNotMatch(result.stdout, /^TAIL$/m);
    }
    const supportsPs0 = Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2]) >= 4);
    if (supportsPs0) {
      assert.match(result.stdout, /PS0:.*133;C.*old-ps0/);
    } else {
      assert.match(result.stdout, /^PS0:old-ps0$/m);
      assert.doesNotMatch(result.stdout, /\x1b\]133;C\x07/);
    }
  }
});
