/**
 * send_to_session create 模式的 working_dir 覆盖校验(#811)。
 *
 * 只做存在性与形状校验(绝对路径 + 已存在目录):调用方 agent 本就拥有本机文件
 * 访问面,目录选择不构成新增权限;校验的目的是把「目录写错」在创建 session 之前
 * 拦下来,给出可行动的错误,而不是让新 session 落在不存在的目录里静默失败。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 校验通过返回 null;否则返回给调用方的错误文案(进 INVALID_ARGS.message)。 */
export async function validateHandoffWorkingDir(dir: string): Promise<string | null> {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    return 'working_dir 不能为空';
  }
  if (!path.isAbsolute(dir)) {
    return `working_dir 必须是绝对路径:${dir}`;
  }
  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return `working_dir 不是目录:${dir}`;
  } catch {
    return `working_dir 不存在或不可访问:${dir}`;
  }
  return null;
}
