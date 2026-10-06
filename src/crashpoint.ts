/**
 * 测试用崩溃注入点。设置环境变量 BACKUP_REPAIR_CRASH_AT（逗号分隔的点名），
 * 进程执行到对应点时会立即收到 SIGKILL，用于模拟进程在任意一步被强制终止。
 * 正常使用时该环境变量不存在，本函数为零开销 no-op。
 */
export function crashPoint(name: string): void {
  const at = process.env.BACKUP_REPAIR_CRASH_AT;
  if (!at) return;
  if (at.split(',').indexOf(name) !== -1) {
    process.kill(process.pid, 'SIGKILL');
  }
}
