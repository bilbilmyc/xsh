export interface QuickConnectAddress {
  host: string;
  port: number;
  username: string;
}

export function parseQuickConnectAddress(input: string): QuickConnectAddress {
  const value = input.trim();
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error("请输入主机名、IP 或 user@host:port。");
  if (value.includes("://") && !value.startsWith("ssh://")) throw new Error("快速连接只支持 SSH 地址。");
  let parsed: URL;
  try {
    const address = value.replace(/^ssh:\/\//, "");
    const hostPart = address.slice(address.lastIndexOf("@") + 1);
    const normalized = !hostPart.startsWith("[") && (hostPart.match(/:/g)?.length ?? 0) > 1
      ? `${address.slice(0, address.length - hostPart.length)}[${hostPart}]`
      : address;
    parsed = new URL(`ssh://${normalized}`);
  } catch {
    throw new Error("地址格式不正确。示例：user@server:22 或 [::1]:22。");
  }
  if (parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("地址中不能包含密码、路径或查询参数。");
  }
  let host: string;
  try {
    const decodedHost = decodeURIComponent(parsed.hostname);
    const isIpv6 = decodedHost.startsWith("[") && decodedHost.endsWith("]");
    if (/[\s\u0000-\u001f\u007f/\\@?#%]/.test(decodedHost) || (!isIpv6 && /[:\[\]]/.test(decodedHost))) throw new Error();
    host = new URL(`http://${decodedHost}`).hostname.replace(/^\[|\]$/g, "");
  }
  catch { throw new Error("主机名格式不正确。"); }
  const port = parsed.port ? Number(parsed.port) : 22;
  let username: string;
  try { username = decodeURIComponent(parsed.username); } catch { throw new Error("用户名编码不正确。"); }
  if (!host || host.startsWith("-") || /[\s/@?#]/.test(host) || /[\s\u0000-\u001f\u007f/:@?#]/.test(username)) {
    throw new Error("主机名或用户名包含不支持的字符。");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1 到 65535 之间。");
  return { host, port, username };
}
