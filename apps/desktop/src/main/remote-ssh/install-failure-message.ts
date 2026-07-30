/**
 * remote-ssh/install-failure-message.ts
 * ---------------------------------------------------------------------------
 * silent-install 失败时的用户可见错误信息组合(纯逻辑,issue #1023)。
 *
 * 背景:Cindy 远程会话使用自装的独立运行时(~/.xdt-server/v1),不复用远端
 * PATH 里用户自己装的 codex/claude。独立运行时安装失败时,旧文案让用户以为
 * 「远端未安装 Codex/Claude」——而他们的系统级 CLI 明明可用,误导排查方向。
 * 这里把三件事说清:失败的是 Cindy 专用运行时、根因日志尾、系统级 CLI(若
 * 存在)不受影响也不被使用。
 */

export interface InstallFailureMessageInput {
  agentKind: 'codex' | 'claude-code';
  /** installer 汇报的根因(result.error 或兜底文案)。 */
  baseMsg: string;
  /** 最近若干条 install log 尾行(可空)。 */
  logTail: readonly string[];
  /** `command -v` 探测到的远端系统级同名 CLI 路径;null = 未探测到/探测失败。 */
  systemBinPath: string | null;
}

/** silent-install 失败 toast / IpcError 的完整 message。 */
export function composeInstallFailureMessage(input: InstallFailureMessageInput): string {
  const bin = input.agentKind === 'codex' ? 'codex' : 'claude';
  const parts: string[] = [
    // 首句点明失败主体是 Cindy 专用运行时,与「远端未安装」区分。
    `Cindy 专用远程运行时(~/.xdt-server/v1)安装失败:${input.baseMsg}`,
  ];
  if (input.logTail.length > 0) parts.push(input.logTail.join('\n'));
  if (input.systemBinPath) {
    parts.push(
      `检测到远端已有系统安装的 ${bin}(${input.systemBinPath}),它不受影响;` +
        `Cindy 远程会话使用独立运行时,本次是该运行时初始化失败,并非远端未安装 ${bin}。`,
    );
  }
  return parts.join('\n');
}
