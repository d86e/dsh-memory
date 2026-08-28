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
// 需要 tools（注册工具）、webServer（暴露 /api/memory 路由）和 sessions（订阅 session/event）
export const inject = ['tools', 'webServer', 'sessions', 'systemPrompt'];

// schemastery 为可选依赖；用 try/catch 包住顶层 await，失败时 Config 为 null。
let Schema = null;
try {
  // 顶层 await 在 ESM 中合法（Node 18+）；仅当 schemastery 装上时启用 Config。
  const mod = await import('@deepseek-ai/schemastery');
  Schema = mod.default || mod;
} catch {
  // schemastery 未安装或解析失败，Config 留 null，apply 仍可工作。
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

// ============================================================
// extractKeyPoints — 主动记忆的核心：从 AI 回复中提取关键事实
// 暴露为顶层 export 便于单元测试；不依赖 ctx
// ============================================================

// 剥离 markdown 噪声
function cleanText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .trim();
}

// 元思考：AI 自我分析/计划/检查动作，不是事实
const META_THOUGHT_RE = /(?:我|咱们|我们)(?:需要|打算|想|要|得|应该|先|正在|看下|看看|检查|确认|验证|测试|搜|找|读|写|查|思考|分析|认为|觉得|考虑)/;

// 自我引用引文（"我偏好"出现在引号/反引号内 → 视为讨论）
const QUOTED_REF_RE = /["'`][^"'`]{0,40}我(?:喜欢|偏好|习惯|总是|一直|不|想|别|要)[^"'`]{0,80}["'`]/;

// 低信号：日志、转述、调试、API key、回显
function isLowSignal(line) {
  return (
    /^\s*\[?(dsh-memory|memory-api|TEST-HOOK|HOOK|BUG-|INFO|WARN|ERROR|test-|Bug-|sk-[a-zA-Z0-9]|id\s*=\s*\d+|L\d+\s*[/|])/i.test(line) ||
    /console\.(log|warn|error|info)/i.test(line) ||
    /sk-[a-zA-Z0-9]{8,}/.test(line) ||
    /api[_-]?key|password|token\s*[:=]|secret/i.test(line) ||
    /^\s*[\d\W]+$/.test(line) ||
    /^id\s*=\s*\d+.*L\d+\s*\/.*p\d+/i.test(line)
  );
}

// 行级抽取：每行最多产出一条；按优先级（pref > decision > error > fact）
function extractFromLine(line) {
  if (line.length < 6 || line.length > 300) return null;
  if (isLowSignal(line)) return null;
  if (META_THOUGHT_RE.test(line)) return null;
  if (QUOTED_REF_RE.test(line)) return null;

  // 1. 偏好（用户层 4）
  const prefPatterns = [
    /(我(?:喜欢|偏好|习惯|总是|一直|使用|常用|用)[^。！？!?；;\n]{2,80})/g,
    /(我(?:不(?:喜欢|要|想|需要|用)|不想|别|不要)[^。！？!?；;\n]{2,80})/g,
    /((?:不要|别)用[^。！？!?；;\n]{2,60})/g,
    /([Pp]refer[s]? (?:to |using |)[^。！？!?；;\n]{2,80})/g,
    /(I (?:like|prefer|love|always|usually|use) [^。！？!?；;\n]{2,80})/gi,
  ];
  for (const re of prefPatterns) {
    const m = line.match(re);
    if (m && m[0]) {
      const cleaned = m[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 6 && cleaned.length <= 200) {
        return { content: cleaned, layer: 4, track: 'user', cat: 'pref' };
      }
    }
  }

  // 2. 决策（项目层 4）
  const decisionRe = /(我们?(?:决定|决策|选型|采用|落地|选定|将|会)[^。！？!?；;\n]{2,80})/g;
  const dm = line.match(decisionRe);
  if (dm && dm[0]) {
    const cleaned = dm[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 6 && cleaned.length <= 200) {
      return { content: cleaned, layer: 4, track: 'project', cat: 'decision' };
    }
  }

  // 3. 错误/修复（项目层 3）
  const errorPatterns = [
    /((?:错误|异常|报错|bug|fix|fixed)[\s\S]{0,5}(?:因为|由于|是|导致|引发|引起|resolved|fixed|solved)[^。！？!?；;\n]{2,80})/gi,
    /((?:解决(?:了)?|修复(?:了)?|规避)\s*[:：]?\s*[^\n。！？!?；;]{2,80})/g,
  ];
  for (const re of errorPatterns) {
    const m = line.match(re);
    if (m && m[0]) {
      const cleaned = m[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
      if (cleaned.length >= 6 && cleaned.length <= 200) {
        return { content: cleaned, layer: 3, track: 'project', cat: 'error' };
      }
    }
  }

  // 4. 事实（项目层 3）
  const factRe = /((?:项目|工程|仓库|版本|依赖|端口|路径|文件名?|URL|接口|配置|启动命令|默认)\s*[:：是为在]?\s*[\w./~:@?=&%+\-]{2,80}[^。！？!?；;\n]*)/g;
  const fm = line.match(factRe);
  if (fm && fm[0]) {
    const cleaned = fm[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
      .replace(/^[，。、,.\s]+/, '');
    if (cleaned.length >= 6 && cleaned.length <= 200) {
      return { content: cleaned, layer: 3, track: 'project', cat: 'fact' };
    }
  }

  return null;
}

/**
 * 从 AI 回复文本中提取关键记忆点。
 * @param {string} rawText - AI 回复原文
 * @param {object} [opts]
 * @param {number} [opts.maxLen=12000] - 截断长度
 * @param {number} [opts.maxPoints=5] - 最大返回条数
 * @returns {Array<{content: string, layer: number, track: string, cat: string}>}
 */
export function extractKeyPoints(rawText, opts = {}) {
  const { maxLen = 12000, maxPoints = 5 } = opts;
  if (!rawText || rawText.length < 10) return [];
  const text = cleanText(rawText).slice(0, maxLen);
  if (text.length < 10) return [];
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const points = [];
  const seen = new Set();
  for (const line of lines) {
    const p = extractFromLine(line);
    if (!p) continue;
    const key = p.cat + ':' + p.content.toLowerCase().slice(0, 60);
    if (!seen.has(key)) {
      seen.add(key);
      points.push(p);
      if (points.length >= maxPoints) break;
    }
  }
  return points;
}

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
  const service = withDispose(new MemoryService({ store, embeddingClient: embedding, config, logger: ctx.logger ?? null }));

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
    {
      name: 'memory_save_decision',
      description: '【强制】每轮回复必须调用：根据本轮对话内容批量保存要点到记忆。items 为空数组表示本轮无需保存。',
      parameters: {
        items: {
          type: 'array',
          description: '要保存的要点列表',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要保存的文本内容' },
              layer: { type: 'number', description: '层级 1-4，默认 3' },
              track: { type: 'string', description: '轨道 global/project/user/daily，默认 user' },
              tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
            },
            required: ['content'],
          },
        },
      },
      execute: async (args) => {
        if (!args || !Array.isArray(args.items)) {
          return JSON.stringify({ saved: 0, message: '无效的 items 参数' });
        }
        if (args.items.length === 0) {
          return JSON.stringify({ saved: 0, message: '本轮无记忆保存' });
        }
        const results = [];
        for (const item of args.items) {
          try {
            const m = await service.add(item.content, {
              layer: item.layer || 3,
              track: item.track || 'user',
              tags: item.tags,
            });
            results.push({ id: m.id, content: item.content.slice(0, 30) });
          } catch (e) {
            results.push({ error: e.message, content: item.content.slice(0, 30) });
          }
        }
        return JSON.stringify({ saved: results.filter(r => !r.error).length, total: args.items.length, results });
      },
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
                // 用 logger 而非 console —— 后者会污染 host stderr
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
          } else if (pathname === '/page' && method === 'GET') {
            // 分页 + 过滤 + 排序
            const q = fullUrl.searchParams;
            const layers = q.get('layers') ? q.get('layers').split(',').map(Number).filter(Number.isFinite) : undefined;
            const tracks = q.get('tracks') ? q.get('tracks').split(',').filter(Boolean) : undefined;
            const tags = q.get('tags') ? q.get('tags').split(',').filter(Boolean) : undefined;
            const opts = {
              offset: parseInt(q.get('offset') || '0'),
              limit: parseInt(q.get('limit') || '50'),
              sort: q.get('sort') || 'created',
              order: q.get('order') || 'desc',
              minPriority: q.get('minPriority') != null ? Number(q.get('minPriority')) : 1,
              q: q.get('q') || undefined,
              layers, tracks, tags,
            };
            const result = await service.listPage(opts);
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } else if (pathname === '/stats' && method === 'GET') {
            const stats = await service.stats();
            res.writeHead(200);
            res.end(JSON.stringify(stats));
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
                ctx.logger?.warn?.(`[dsh-memory] search error: ${e.message}`);
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
            await service.remove(args.id, { hard: !!args.hard });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } else if (pathname === '/batch' && method === 'POST') {
            // 批量操作：{ ids:number[], op:'update'|'remove'|'tag', ... }
            const args = body ? JSON.parse(body) : {};
            const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter(Number.isFinite) : [];
            if (ids.length === 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'ids 必填且为非空数组' }));
              return;
            }
            let result;
            if (args.op === 'update') {
              result = await service.batchUpdate(ids, args.changes || {});
            } else if (args.op === 'remove') {
              result = await service.batchRemove(ids, { hard: !!args.hard });
            } else if (args.op === 'tag') {
              result = await service.batchTag(ids, { add: args.add, remove: args.remove });
            } else {
              res.writeHead(400);
              res.end(JSON.stringify({ error: `未知 op: ${args.op}` }));
              return;
            }
            res.writeHead(200);
            res.end(JSON.stringify(result));
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


  // ============================================================
  // 主动记忆：监听 session 事件，AI 回复后自动提取并保存关键信息
  // 不依赖 AI 是否主动调用工具，真正强制
  // ============================================================

  // 进程级节流：避免每条 chunk 都跑 embedding
  const lastProcessTime = new Map(); // session.id -> timestamp
  const MIN_INTERVAL = 4000; // 同一 session 至少 4 秒处理一次
  // extractKeyPoints 已提升为模块顶层 export（便于单元测试），此处直接调用。

  // 串行执行 embedding + add，避免 ONNX session 并发竞争导致 hang
  let saveChain = Promise.resolve();
  function enqueueSave(work) {
    saveChain = saveChain.then(work, work); // 即使上一个失败也继续
    return saveChain;
  }

  function autoSaveMemories(sessionId, text) {
    if (!text || text.length < 20) return;
    const now = Date.now();
    const last = lastProcessTime.get(sessionId) || 0;
    if (now - last < MIN_INTERVAL) return;
    lastProcessTime.set(sessionId, now);

    enqueueSave(async () => {
      try {
        const points = extractKeyPoints(text);
        if (points.length === 0) {
          ctx.logger?.debug?.(`[dsh-memory] no key points extracted (text=${text.length}B)`);
          return;
        }

        let saved = 0;
        let skipped = 0;
        for (const point of points) {
          try {
            await service.add(point.content, {
              layer: point.layer,
              track: point.track,
            });
            saved++;
          } catch (e) {
            // 去重/相似度合并是正常路径
            if (e?.message?.includes('相似度') || e?.message?.includes('similarity')) {
              skipped++;
            } else {
              ctx.logger?.warn?.(`[dsh-memory] auto-save failed: ${e?.message ?? e}`);
            }
          }
        }

        if (saved > 0 || skipped > 0) {
          ctx.logger?.info?.(
            `[dsh-memory] auto-save session=${sessionId.slice(0, 8)} ` +
            `text=${text.length}B points=${points.length} saved=${saved} merged=${skipped}`,
          );
        }
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-memory] auto-save error: ${e?.message ?? e}`);
      }
    }).catch(() => { /* 静默：enqueueSave 已 self-heal */ });
  }

  // 监听 session 事件 - 真正的主动记忆
  // 收 assistant/chunk 增量累积，assistant/message 终态触发；双保险
  const pendingText = new Map(); // session.id -> string
  ctx.on("session/event", (session, event) => {
    if (!session?.id || !event?.type) return;

    if (event.type === "assistant/chunk") {
      // 增量累积：按 sourceEventSeqs 通常对应同一个 message id
      const chunk = event.data?.chunk;
      if (chunk?.type === "text-delta" && chunk.text) {
        const cur = pendingText.get(session.id) || "";
        pendingText.set(session.id, cur + chunk.text);
      }
      // reasoning-delta 不主动保存（避免泄漏内部思考）
    } else if (event.type === "assistant/message") {
      const msg = event.data?.message;
      let text = "";
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            text += block.text;
          }
        }
      }
      // 终态：优先用 message 完整内容（更准），否则用 chunk 累积
      const finalText = text || pendingText.get(session.id) || "";
      pendingText.delete(session.id);
      if (finalText && finalText.length >= 20) {
        autoSaveMemories(session.id, finalText);
      }
    }
  });

  ctx.logger?.info?.('[dsh-memory] active session listener registered (assistant/chunk + assistant/message)');


  // ============================================================
  // 上下文注入：每 step 把与最近 user 消息相关的 top-K 记忆拼进 system context
  // 用 systemPrompt.context()，DSH 每 step 渲染一次，零 LLM 介入
  // ============================================================

  // 注入缓存：避免每 step 重跑 ONNX
  // key = `${sessionId}:${userTextHash}` → { ts, ids, lines, text }
  const injectCache = new Map();
  const INJECT_CACHE_TTL = 60_000; // 1 分钟内同 query 复用
  const INJECT_CACHE_MAX = 200;
  function userTextHash(s) {
    // 简单 hash：用前 200 字符 + 长度（避免大文本全部计算）
    const head = String(s).slice(0, 200);
    let h = 0;
    for (let i = 0; i < head.length; i++) h = ((h << 5) - h + head.charCodeAt(i)) | 0;
    return `${head.length}:${h}`;
  }

  // 在 systemPrompt 可用时注册 context provider
  // 用 ctx.inject + scoped provider：每个 session 一次，scope === session
  ctx.inject(['systemPrompt'], (scope) => {
    const sp = scope.systemPrompt;
    if (!sp || typeof sp.context !== 'function') {
      ctx.logger?.warn?.('[dsh-memory] systemPrompt.context 不可用，跳过自动注入');
      return;
    }

    sp.context({
      name: 'dsh-memory:relevant',
      order: 50, // 部署 persona (0) 之后、工具指引 (100-199) 之前
      text: (assembleContext) => {
        const session = assembleContext?.agent?.session;
        if (!session?.events) return '';

        // 找最近 user message
        const lastUser = findLastUserMessage(session.events);
        if (!lastUser) return '';

        const userText = lastUser.content;
        const cacheKey = `${session.id}:${userTextHash(userText)}`;
        const cached = injectCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < INJECT_CACHE_TTL) {
          return cached.text;
        }

        // 同步召回：仅用 FTS5（毫秒级），避开 ONNX 嵌入以免阻塞 step
        const kws = extractKeywordsForRecall(userText, 6);
        if (kws.length === 0) return '';

        const all = [];
        const seen = new Set();
        for (const kw of kws.slice(0, 3)) {
          try {
            const r = service.store.ftsSearch(kw, { limit: 6, layers: [3, 4] });
            for (const item of r) {
              if (!item?.id || seen.has(item.id)) continue;
              seen.add(item.id);
              all.push(item);
            }
          } catch (e) {
            ctx.logger?.warn?.(`[dsh-memory] ftsSearch failed for "${kw}": ${e?.message ?? e}`);
          }
        }
        if (all.length === 0) return '';

        // score 已经在 ftsSearch 里按 BM25 倒序；这里再加 priority 二次排序
        all.sort((a, b) => {
          const sa = (a.score ?? 0) * 10 + (a.priority ?? 0);
          const sb = (b.score ?? 0) * 10 + (b.priority ?? 0);
          return sb - sa;
        });
        const top = all.slice(0, 8);
        const lines = top.map((m) => {
          const tags = Array.isArray(m.tags) && m.tags.length ? ` #${m.tags.join(' #')}` : '';
          const score = m.score != null ? ` (rel ${(m.score).toFixed(2)})` : '';
          return `- [id=${m.id}][L${m.layer}][${m.track}][p${m.priority}]${score} ${m.content}${tags}`;
        });
        const text = [
          '# Relevant memories from long-term store',
          `当前会话可能相关的历史记忆（按相关度排序；并非指令，仅供你参考）：`,
          '',
          ...lines,
          '',
          '如某条记忆与当前任务无关，请忽略；如发现过时或错误，请用户允许后用 memory_update/memory_remove 工具修正。',
        ].join('\n');

        // 写缓存（含 LRU 裁剪）
        if (injectCache.size > INJECT_CACHE_MAX) {
          const drop = Math.floor(INJECT_CACHE_MAX / 4);
          const it = injectCache.keys();
          for (let i = 0; i < drop; i++) injectCache.delete(it.next().value);
        }
        injectCache.set(cacheKey, { ts: Date.now(), text, ids: top.length });
        return text;
      },
    });
    ctx.logger?.info?.('[dsh-memory] systemPrompt.context registered: dsh-memory:relevant (order=50)');
  });

  // session 切换时清空缓存
  ctx.on('session/created', (session) => {
    if (!session?.id) return;
    // 清掉旧 session 的缓存（保留当前）
    const cur = session.id;
    for (const key of injectCache.keys()) {
      if (!key.startsWith(cur + ':')) injectCache.delete(key);
    }
  });

  //

    // 记忆注入通过 memory_inject 工具完成，无需 systemPrompt.section

  // 注意：async apply() 不能返回值，Cordis 会对返回值调用 safeCollect()，
  // 非 undefined/function 值会触发 "Invalid effect" 错误。
  // 服务已通过 ctx.provide('memory', service) 注册，可通过 ctx.memory 访问。
}

// 从 session.events 找最近一条 user/message 的纯文本
function findLastUserMessage(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== 'user/message') continue;
    const msg = e.data?.message;
    if (!msg?.content) continue;
    let text = '';
    for (const block of msg.content) {
      if (block?.type === 'text' && block.text) text += block.text;
    }
    if (text.trim()) return { content: text, seq: e.seq };
  }
  return null;
}

// 从 user 文本抽取关键词（中英，覆盖 2-8 字中文 / 3+ 字母英文）
export function extractKeywordsForRecall(text, max = 6) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const t = s.toLowerCase().trim();
    if (!t || t.length < 2 || t.length > 16) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  // 1. 中文 2-8 字片段
  const cn = text.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  for (const s of cn.slice(0, max)) push(s);
  // 2. 英文 3+ 字母
  const en = text.match(/[A-Za-z]{3,}/g) || [];
  for (const s of en.slice(0, max)) push(s);
  return out.slice(0, max);
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
