// lib/index.js
// DSH Cordis 插件入口；同时导出核心类，便于独立使用。
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MemoryStore, VEC_DIMENSIONS, DEFAULT_DB_PATH } from '../src/memory-store.js';
import { EmbeddingClient } from '../src/embedding.js';
import { MemoryService } from '../src/service.js';

export { MemoryStore, EmbeddingClient, MemoryService };
export { VEC_DIMENSIONS, DEFAULT_DB_PATH };

export const name = 'dsh-memory';
// 需要 tools（注册工具）和 systemPrompt（自动注入记忆）
export const inject = ['tools', 'webServer'];

// schemastery 为可选依赖；未安装时 Config 为 null（独立库模式）。
let Schema = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  Schema = mod.default || mod;
} catch {
  // schemastery 未安装，跳过
}

export const Config = Schema
  ? Schema.object({
      dbPath: Schema.string().default(DEFAULT_DB_PATH).description('SQLite 数据库路径'),
      apiKey: Schema.string().role('secret').description('DeepSeek/OpenAI API Key'),
      baseURL: Schema.string().default('https://api.deepseek.com/v1').description('Embedding API 端点'),
      model: Schema.string().default('deepseek-embed').description('Embedding 模型'),
      vectorWeight: Schema.number().default(0.6).description('向量检索权重'),
      ftsWeight: Schema.number().default(0.4).description('FTS5 关键词权重'),
      topKVector: Schema.number().default(5).description('向量检索 top-K'),
      topKFts5: Schema.number().default(5).description('FTS5 检索 top-K'),
      maxInject: Schema.number().default(15).description('会话最大注入条数'),
      similarityThreshold: Schema.number().default(0.15).description('相似度阈值'),
      autoEmbed: Schema.boolean().default(true).description('写入时自动生成向量'),
    })
  : null;

/**
 * 为服务附加 dispose() 方法，关闭底层 DB 连接。
 */
function withDispose(service) {
  service.dispose = () => {
    if (service.store) service.store.close();
  };
  return service;
}

// TEXT_OUTPUT 供所有工具使用（返回字符串）。
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export async function apply(ctx, config = {}) {
  // 展开 ~ 路径
  const expandTilde = (p) => p ? p.replace(/^~/, homedir()) : p;
  const dbPath = expandTilde(config.dbPath) || DEFAULT_DB_PATH;
  const store = new MemoryStore(dbPath, {
    dimensions: config.dimensions,
  });
  const embedding = new EmbeddingClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    dimensions: config.dimensions,
  });
  const service = withDispose(new MemoryService({ store, embeddingClient: embedding, config }));

  // 将服务暴露为 Cordis 可注入的提供项
  ctx.provide('memory', service);

  // 注册 DSH 工具（如果 dsh-tools 可用）。
  let defineTool;
  try {
    const toolsMod = await import('@deepseek-ai/dsh-tools');
    defineTool = toolsMod.defineTool;
  } catch {
    ctx.logger?.warn?.('[dsh-memory] 未安装 @deepseek-ai/dsh-tools，跳过工具注册（可通过 ctx.memory 使用服务）');
  }

  // 工具定义：使用 proper JSON Schema + execute 回调。
  const toolDefs = [
    {
      name: 'memory_add',
      description: '添加一条记忆。layer: 1=原始 2=关键 3=整理 4=深层；track: global/project/user/daily',
      parameters: {
        content: { type: 'string', description: '记忆内容文本' },
        layer: { type: 'number', description: '记忆层 1-4，默认 3' },
        track: { type: 'string', description: '记忆轨道 global/project/user/daily，默认 user' },
        priority: { type: 'number', description: '优先级 1-5，默认 3' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        source: { type: 'string', description: '来源标识' },
      },
      execute: async (args) => service.add(args.content, args),
    },
    {
      name: 'memory_search',
      description: '搜索记忆（关键词 + 语义混合检索）',
      parameters: {
        query: { type: 'string', description: '搜索关键词' },
        track: { type: 'string', description: '按轨道过滤' },
        layers: { type: 'array', items: { type: 'number' }, description: '按层过滤' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
      execute: async (args) => JSON.stringify(await service.search(args.query, args), null, 2),
    },
    {
      name: 'memory_list',
      description: '列出记忆（可按 layer/track/priority 过滤）',
      parameters: {
        layer: { type: 'number', description: '按层过滤' },
        track: { type: 'string', description: '按轨道过滤' },
        priority: { type: 'number', description: '按优先级过滤' },
        minPriority: { type: 'number', description: '最低优先级' },
        limit: { type: 'number', description: '返回条数' },
      },
      execute: async (args) => {
        const result = await service.list(args);
        return Array.isArray(result) ? JSON.stringify(result, null, 2) : '';
      },
    },
    {
      name: 'memory_update',
      description: '按 id 更新记忆',
      parameters: {
        id: { type: 'number', description: '记忆 ID' },
        changes: { type: 'object', description: '要更新的字段' },
      },
      execute: async (args) => JSON.stringify(await service.update(args.id, args.changes || {}), null, 2),
    },
    {
      name: 'memory_remove',
      description: '按 id 删除记忆（默认软删除；hard=true 物理删除）',
      parameters: {
        id: { type: 'number', description: '记忆 ID' },
        hard: { type: 'boolean', description: '是否物理删除' },
      },
      execute: async (args) => {
        const result = await service.remove(args.id, { hard: args.hard });
        return result ? JSON.stringify({ id: result.id, deleted: true }) : 'not found';
      },
    },
    {
      name: 'memory_inject',
      description: '手动触发记忆注入：返回当前会话应注入的记忆内容（含 layer 分组）',
      parameters: {
        track: { type: 'string', description: '按轨道过滤' },
        maxInject: { type: 'number', description: '最大注入条数' },
      },
      execute: async (args) => service.injectForSession(args),
    },
  ];

  // 在 effect 中注册工具（effect 回调必须是同步的）。
  ctx.effect(() => {
    for (const t of toolDefs) {
      try {
        const tool = defineTool({ ...t, output: TEXT_OUTPUT });
        registerTool(ctx, tool);
      } catch (err) {
        ctx.logger?.warn?.(`[dsh-memory] 注册工具 ${t.name} 失败: ${err.message}`);
      }
    }
  });


  // 注册 Web API 端点供浏览器调用
  ctx.effect(() => {
    const ws = ctx.webServer;
    if (!ws) return () => {};
    return ws.register({
      kind: 'prefix',
      path: '/api/memory',
      handler: async (req, res) => {
                console.log('[memory-api] DB path:', service.store?.db?.name || 'unknown');
                const fullUrl = new URL(req.url ?? '/', 'http://localhost');
                // 前缀路由：去掉 /api/memory 前缀
        const prefix = '/api/memory';
        const pathname = fullUrl.pathname.startsWith(prefix) 
          ? fullUrl.pathname.slice(prefix.length) || '/'
          : fullUrl.pathname;
        const url = { ...fullUrl, pathname };
        const method = req.method ?? 'GET';
        const body = method !== 'GET' ? await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        }) : null;
        
        res.setHeader('Content-Type', 'application/json');
        
        try {
          if (pathname === '/list' && method === 'GET') {
            const limit = parseInt(fullUrl.searchParams.get('limit') || '200');
            const result = await service.list({ limit, includeDeleted: false });
            res.writeHead(200);
            res.end(JSON.stringify(Array.isArray(result) ? result : []));
          } else if (pathname === '/add' && method === 'POST') {
            const args = body ? JSON.parse(body) : {};
            const result = await service.add(args.content, args);
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } else if (pathname === '/search' && method === 'GET') {
            try {
                const query = fullUrl.searchParams.get('query') || '';
                const limit = parseInt(fullUrl.searchParams.get('limit') || '50');
                const track = fullUrl.searchParams.get('track') || undefined;
                const layers = fullUrl.searchParams.get('layers') ? fullUrl.searchParams.get('layers').split(',').map(Number) : undefined;
                const result = await service.search(query, { limit, track, layers });
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[memory-api] Search error:', e.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
          } else if (pathname === '/update' && method === 'POST') {
            const args = body ? JSON.parse(body) : {};
            await service.update(args.id, args.changes);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } else if (pathname === '/remove' && method === 'POST') {
            const args = body ? JSON.parse(body) : {};
            await service.remove(args.id);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      }
    });
  }, 'memory-ui: web routes');

    // 记忆注入通过 memory_inject 工具完成，无需 systemPrompt.section

  // 注意：async apply() 不能返回值，Cordis 会对返回值调用 safeCollect()，
  // 非 undefined/function 值会触发 "Invalid effect" 错误。
  // 服务已通过 ctx.provide('memory', service) 注册，可通过 ctx.memory 访问。
}

// 兼容不同版本的 DSH 工具注册方式。
function registerTool(ctx, tool) {
  if (typeof ctx.tools?.register === 'function') return ctx.tools.register(tool);
  if (typeof ctx.tool === 'function') return ctx.tool(tool);
  if (typeof ctx.defineTool === 'function') return ctx.defineTool(tool);
  if (typeof ctx.register === 'function') return ctx.register(tool);
  throw new Error('无法确定 DSH 工具注册方式');
}

// 工厂函数。
export function createService(options = {}) {
  let store = options.store;
  if (!store) {
    const dimensions = (options.embeddingClient instanceof EmbeddingClient)
      ? options.embeddingClient.dimensions
      : options.dimensions;
    store = new MemoryStore(options.dbPath, { dimensions });
  } else if (!(store instanceof MemoryStore)) {
    throw new TypeError('options.store 必须是 MemoryStore 实例');
  }
  let embedding;
  if (options.embeddingClient instanceof EmbeddingClient) {
    embedding = options.embeddingClient;
  } else {
    embedding = new EmbeddingClient(options.embedding || options);
  }
  return withDispose(new MemoryService({ store, embeddingClient: embedding, config: options.config }));
}

// 便捷函数：默认路径 ~/.dsh/memory.db。
export function getMemoryService(dbPath = join(homedir(), '.dsh', 'memory.db')) {
  const store = new MemoryStore(dbPath);
  const embedding = new EmbeddingClient();
  return withDispose(new MemoryService(store, embedding));
}
