import type { AiMode } from "./ai-context";

export const AI_SETTINGS_CHANGED_EVENT = "xsh:ai-settings-changed";
export const AI_SERVICE_TEST_PROMPT = "这是一条 XSH AI 服务连接测试。请只回复：XSH AI 服务连接正常。";

export const AI_TASKS: Record<AiMode, { label: string; title: string; description: string; placeholder: string; example: string }> = {
  command: {
    label: "生成命令",
    title: "告诉 AI 你想完成什么",
    description: "说明目标，得到可检查的命令、用途和验证方法。",
    placeholder: "例如：找出 Linux 中内存占用最高的进程，先不要停止服务。",
    example: "说明目标系统、想完成的操作，以及哪些内容不能修改。",
  },
  explain: {
    label: "解释输出",
    title: "看懂命令，也看懂结果",
    description: "附加终端内容，解释关键参数、字段和需要关注的异常。",
    placeholder: "可补充：请解释每一列代表什么，哪些信息需要关注？",
    example: "例如：选中 df -h 的输出，询问磁盘剩余空间怎么看。",
  },
  diagnose: {
    label: "诊断问题",
    title: "从实际输出找到下一步",
    description: "区分已经确认的事实与可能原因，先给出最有用的检查。",
    placeholder: "可补充：我在启动什么服务？执行了什么操作？预期是什么？",
    example: "例如：选中 Permission denied 报错，并说明刚才执行的命令。",
  },
};

export const AI_COMMAND_SUGGESTIONS = [
  "在 Linux 中查看内存占用最多的 10 个进程，只查看，不修改系统。",
  "在 Linux 中检查磁盘使用情况，并找出当前目录下最大的文件夹。",
  "在 Linux 中检查 8080 端口是否被占用，显示对应进程，不停止任何服务。",
];

export function aiServiceHost(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return "服务地址无效，请检查设置"; }
}
