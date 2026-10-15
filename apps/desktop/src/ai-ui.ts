import type { AiMode } from "./ai-context";

export const AI_SETTINGS_CHANGED_EVENT = "xsh:ai-settings-changed";
export const AI_SERVICE_TEST_PROMPT = "这是一条 XSH AI 服务连接测试。请只回复：XSH AI 服务连接正常。";

export const AI_TASKS: Record<AiMode, { label: string; title: string; description: string; placeholder: string; example: string }> = {
  command: {
    label: "生成命令",
    title: "告诉 AI 你想完成什么",
    description: "先生成可编辑的命令草稿，检查后再决定是否发送到终端。",
    placeholder: "例如：在 Linux 中查看内存占用最多的 10 个进程，只查看，不修改系统。",
    example: "说明目标系统、想完成的操作，以及哪些内容不能修改。",
  },
  explain: {
    label: "解释选区",
    title: "看懂一段命令或终端输出",
    description: "在终端拖选文字，获取选区后，AI 会解释每段内容的含义。",
    placeholder: "可补充：请解释每一列代表什么，哪些信息需要关注？",
    example: "例如：选中 df -h 的输出，询问磁盘剩余空间怎么看。",
  },
  diagnose: {
    label: "分析报错",
    title: "从报错找到下一步检查方向",
    description: "选择完整报错及前后几行，AI 会给出可能原因和排查建议。",
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
