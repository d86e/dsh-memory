/**
 * dsh-memory-ui — 记忆管理仪表盘面板 (host side)
 * Host 侧通过 harness.handle() 注册 RPC handlers，供浏览器 client.js 调用。
 */
export const name = 'dsh-memory-ui';
export const inject = ['memory'];
export const Config = null;

export async function apply(ctx, config) {
  // Host side: 注册 RPC handlers
  // harness.handle() 在 VM sandbox 中可用，用于跨进程通信
}
