// lib/index.js
// DSH Cordis 插件入口；同时导出核心类，便于独立使用。
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
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
// v0.4.1: 扩展黑名单覆盖"我用/我用了/我选/我选择/我准备/我接下来/我下面/我先来"等
// 此前漏了"我用 plan 模式先和你确认设计方向："这种 AI 自语，导致大量 L4/user 噪音入库。
// 注意：不要把"我们决定 / 我们采用 / 我们选定 / 我们落地"等已发生决策拦掉 —— 见
// DECISION_VERB_RE 排除项。
const META_THOUGHT_RE = /(?:我|咱们|我们)(?:需要|打算|想|要|得|应该|先|正在|看下|看看|检查|确认|验证|测试|搜|找|读|写|查|思考|分析|认为|觉得|考虑|用了?|选(择|了|取|用)|准备|接下来|下面|来|尝试|开始|继续|用|使用|改|改用|改成)/;

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
  // 词表 + 句式两类。词表覆盖"项目/工程..."等显式技术词；句式覆盖"X开发完成/Y验证/Z部署"等
  // 状态性事实（v0.4.1 扩展：补"开发/实现/部署/验证/设计/支持/支持..."）。
  // 注意：句式模式在 fact 阶段最宽泛，依赖 META_THOUGHT_RE 在前面已经过滤了 AI 自语。
  const factPatterns = [
    // 显式技术词 + 数值/路径
    /((?:项目|工程|仓库|版本|依赖|端口|路径|文件名?|URL|接口|配置|启动命令|默认|环境变量|数据库|表|索引|缓存|队列|服务|进程|模块|组件|包|库|插件|工具|API|SDK|密钥|凭据)\s*[:：是为在的]?\s*[\w./~:@?=&%+\-]{2,80}[^。！？!?；;\n]*)/g,
    // 状态性事实：X开发/实现/部署/验证/设计/支持/采用/选定/落地 + 完/成功/通过 + 后续
    /([\u4e00-\u9fff\w]{2,40}(?:开发|实现|部署|验证|设计|支持|采用|选定|落地|完成|完成验证|通过|上线|修复|修订|迁移|重构|优化)\s*(?:了|完成|成功|通过|上线)?\s*[^。！？!?；;\n]{0,80})/g,
    // 含"用...实现/构建"等"工具+动作"型事实
    /(用[\u4e00-\u9fff\w/]{2,20}(?:实现|构建|搭建|开发|替代|替换|对接|接入)\s*[^。！？!?；;\n]{0,80})/g,
  ];
  for (const re of factPatterns) {
    const fm = line.match(re);
    if (fm && fm[0]) {
      const cleaned = fm[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
        .replace(/^[，。、,.\s]+/, '');
      if (cleaned.length >= 6 && cleaned.length <= 200) {
        return { content: cleaned, layer: 3, track: 'project', cat: 'fact' };
      }
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

/**
 * 用一个轻量 LLM 二次过滤候选记忆点，去掉启发式提取的噪音。
 *
 * 由插件的 auto-save 流程在 extractKeyPoints 之后调用；返回过滤后的子集。
 * 设计上对 LLM 失败是 graceful 的：失败时返回原始 points（不阻断保存）。
 *
 * @param {Array<{content: string, layer: number, track: string, cat: string}>} points
 * @param {object} runtime - @deepseek-ai/dsh-llm 的 LlmRuntime 实例（cordis 注入）
 * @param {object} [opts]
 * @param {string} [opts.provider] - 默认 'deepseek'
 * @param {string} [opts.model]    - 默认 'deepseek-chat'
 * @param {number} [opts.timeoutMs=8000] - 超时（避免阻塞 auto-save 队列）
 * @param {object} [opts.logger]  - { info?, warn?, debug? }
 * @returns {Promise<Array<{content: string, layer: number, track: string, cat: string}>>}
 */
export async function llmFilterPoints(points, runtime, opts = {}) {
  if (!Array.isArray(points) || points.length === 0) return points;
  if (!runtime || typeof runtime.stream !== 'function') return points;

  const {
    provider = 'deepseek',
    model = 'deepseek-chat',
    timeoutMs = 8000,
    logger = null,
  } = opts;

  const log = (level, msg) => {
    const l = logger;
    if (l && typeof l[level] === 'function') {
      try { l[level](`[dsh-memory:llm-filter] ${msg}`); return; } catch { /* fall */ }
    }
    if (level === 'warn' || level === 'error') {
      // eslint-disable-next-line no-console
      console.warn(`[dsh-memory:llm-filter] ${msg}`);
    }
  };

  const numbered = points.map((p, i) => `${i + 1}. [${p.cat}] ${p.content}`).join('\n');
  const systemPrompt = `你是一个记忆筛选助手。从给定候选条目中，**只保留值得长期保存的事实/偏好/决策/已修复 bug**。
- 丢弃 AI 的元思考/过程性话术（"我用了/我尝试/我接下来..."）
- 丢弃无上下文的截断句子
- 丢弃重复或近义项
- 保留用户事实/偏好/项目决策/已修复 bug
- 严格按原编号顺序输出要保留的编号（每行一个，纯数字），无保留时输出 NONE`;

  const userMsg = `候选记忆条目（共 ${points.length} 条）：\n${numbered}\n\n请输出要保留的编号：`;

  let timeoutHandle;
  const ac = new AbortController();
  timeoutHandle = setTimeout(() => ac.abort(), timeoutMs);

  try {
    // message 直接用 plain object（dsh-llm runtime 接受 role+content 数组）
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ];

    let text = '';
    const stream = runtime.stream({
      provider, model, messages, signal: ac.signal,
    });
    for await (const chunk of stream) {
      // chunk 形如 { type: 'text-delta', delta } 或 { type: 'finish', ... }
      if (chunk?.type === 'text-delta' && chunk.delta) text += chunk.delta;
      if (chunk?.type === 'text' && chunk.text) text += chunk.text;
      if (chunk?.type === 'finish' || chunk?.finish) break;
    }

    clearTimeout(timeoutHandle);
    text = text.trim();
    if (!text || /^none$/i.test(text)) {
      log('debug', `LLM 拒绝全部 ${points.length} 条`);
      return [];
    }

    const keepIdx = new Set();
    for (const line of text.split(/\s+/)) {
      const m = line.match(/^(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= points.length) keepIdx.add(n - 1);
      }
    }
    const kept = points.filter((_, i) => keepIdx.has(i));
    log('info', `LLM 过滤 ${points.length} → ${kept.length} 条`);
    return kept;
  } catch (e) {
    clearTimeout(timeoutHandle);
    log('warn', `LLM filter failed: ${e?.message ?? e}（回退到原始 ${points.length} 条）`);
    return points;
  }
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

  // logger fallback：ctx.logger 可能不可用（部分 DSH 启动路径未注入 logger），
  // 这时静默让 debug 变得不可能。回退到 stderr，warn 级别始终输出，其余默认静默。
  const log = (level, msg) => {
    const l = ctx.logger;
    if (l && typeof l[level] === 'function') {
      try { l[level](`[dsh-memory] ${msg}`); return; } catch { /* fall through */ }
    }
    if (level === 'warn' || level === 'error') {
      // eslint-disable-next-line no-console
      console.warn(`[dsh-memory] ${msg}`);
    }
  };

  // 将服务暴露为 Cordis 可注入的提供项
  ctx.provide('memory', service);

  // LLM 二次过滤：默认关闭。开启后 (config.llmFilter === true) 走 @deepseek-ai/dsh-llm。
  // 注入 llm 是 lazy 的（DIC 加载顺序问题），所以我们用 ctx.inject 拿到 runtime 引用。
  const llmFilterOpts = {
    enabled: config.llmFilter === true,
    provider: config.llmProvider || 'deepseek',
    model: config.llmModel || 'deepseek-chat',
    timeoutMs: Number(config.llmFilterTimeoutMs) || 8000,
  };
  let llmRuntime = null;
  // 尝试通过 ctx.llm 直接拿（DSH 直接注入 llm 到 ctx 时）
  if (llmFilterOpts.enabled) {
    try {
      const direct = ctx.llm;
      if (direct && typeof direct.stream === 'function') {
        llmRuntime = direct;
        log('info', `llmFilter enabled (ctx.llm), provider=${llmFilterOpts.provider} model=${llmFilterOpts.model}`);
      }
    } catch { /* ignore */ }
  }
  // 否则用 ctx.inject 等 llm 加载好后拿（cordis 风格）
  if (llmFilterOpts.enabled && !llmRuntime) {
    try {
      ctx.inject(['llm'], (scope) => {
        if (scope?.llm && typeof scope.llm.stream === 'function') {
          llmRuntime = scope.llm;
          log('info', `llmFilter enabled (ctx.inject llm), provider=${llmFilterOpts.provider} model=${llmFilterOpts.model}`);
        }
      });
    } catch (e) {
      log('warn', `llm inject failed: ${e?.message ?? e}`);
    }
  }
  if (llmFilterOpts.enabled && !llmRuntime) {
    log('warn', 'llmFilter enabled but no llm runtime available yet; filter will be skipped until llm loads');
  }

  // 注册 DSH 工具（如果 dsh-tools 可用）。
  // 解析策略：先按 bare specifier 走 Node 标准解析（DSH host 用 cascaded loader 时
  // 会从其 node_modules 解析）；若失败，再尝试若干 host 全局安装候选路径。
  // 这样 dsh-memory 部署到 ~/.dsh/profiles/web/node_modules/... (软链) 时也能
  // 找到 dsh-tools，无需在每个部署副本里 npm install 整个 @deepseek-ai 树。
  let defineTool;
  const tryImport = async (spec) => {
    try { return await import(spec); } catch { return null; }
  };
  let toolsMod = await tryImport('@deepseek-ai/dsh-tools');
  if (!toolsMod) {
    // 候选 host 路径：DSH 默认装在 ~/.dsh/profiles/node_modules/。
    // 也兼容自定义 HOME / XDG / DSH_HOME。
    const candidates = [
      join(homedir(), '.dsh', 'profiles', 'node_modules'),
      join(homedir(), '.dsh', 'node_modules'),
    ];
    if (process.env.DSH_HOME) candidates.unshift(join(process.env.DSH_HOME, 'profiles', 'node_modules'));
    for (const base of candidates) {
      try {
        const req = createRequire(join(base, '@deepseek-ai', 'dsh-tools', 'package.json'));
        // require() ESM 包要用 import()，但 createRequire 仍可用于解析路径后再 dynamic import
        const pkgPath = req.resolve('@deepseek-ai/dsh-tools');
        toolsMod = await tryImport(pkgPath);
        if (toolsMod) break;
      } catch { /* 试下一个 */ }
    }
  }
  if (toolsMod) {
    defineTool = toolsMod.defineTool;
  } else {
    log('warn', '未找到 @deepseek-ai/dsh-tools，跳过工具注册（可通过 ctx.memory 使用服务）');
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
        log('warn', `注册工具 ${t.name} 失败: ${err.message}`);
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
                log('warn', `search error: ${e.message}`);
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
        let points = extractKeyPoints(text);
        if (points.length === 0) {
          log('debug', `no key points extracted (text=${text.length}B)`);
          return;
        }

        // LLM 二次过滤：默认关闭，config.llmFilter === true 时启用
        if (llmFilterOpts.enabled && llmRuntime) {
          try {
            const before = points.length;
            points = await llmFilterPoints(points, llmRuntime, {
              provider: llmFilterOpts.provider,
              model: llmFilterOpts.model,
              timeoutMs: llmFilterOpts.timeoutMs,
              logger: ctx.logger,
            });
            if (points.length === 0) {
              log('debug', `LLM filter rejected all ${before} points; nothing to save`);
              return;
            }
          } catch (e) {
            log('warn', `llmFilter step failed: ${e?.message ?? e} (falling back to raw ${points.length} points)`);
          }
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
              log('warn', `auto-save failed: ${e?.message ?? e}`);
            }
          }
        }

        if (saved > 0 || skipped > 0) {
          log('info',
            `auto-save session=${sessionId.slice(0, 8)} ` +
            `text=${text.length}B points=${points.length} saved=${saved} merged=${skipped}`,
          );
        }
      } catch (e) {
        log('warn', `auto-save error: ${e?.message ?? e}`);
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

  log('info', 'active session listener registered (assistant/chunk + assistant/message)');


  // ============================================================
  // 上下文注入：每 step 把与最近 user 消息相关的 top-K 记忆拼进 system context
  // 用 systemPrompt.context()，DSH 每 step 渲染一次，零 LLM 介入
  // ============================================================

  // 注入缓存：避免每 step 重跑 ONNX
  // key = `${sessionId}:${userTextHash}` → { ts, ids, lines, text }
  const injectCache = new Map();
  // injectStats: 累计每 session 的 step 数和命中数（用于抽样 info 日志）
  const injectStats = new Map();
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
      log('warn', 'systemPrompt.context 不可用，跳过自动注入');
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
        if (kws.length === 0) {
          log('debug', `inject: no keywords for user text (len=${userText.length})`);
          return '';
        }
        log('debug', `inject: kws=[${kws.slice(0, 3).join(', ')}] userLen=${userText.length}`);

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
            log('warn', `ftsSearch failed for "${kw}": ${e?.message ?? e}`);
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
        // 抽样日志：每 50 步记一次（用 session 内累计计数器；每 session 重置）
        if (!injectStats.has(session.id)) injectStats.set(session.id, { steps: 0, hits: 0 });
        const s = injectStats.get(session.id);
        s.steps++;
        s.hits += top.length;
        if (s.steps === 1 || s.steps % 50 === 0) {
          log('info',
            `inject: session=${session.id.slice(0, 8)} ` +
            `steps=${s.steps} hits(total)=${s.hits} ` +
            `last(top) ids=[${top.map(m => m.id).join(',')}]`,
          );
        }
        return text;
      },
    });
    log('info', 'systemPrompt.context registered: dsh-memory:relevant (order=50)');
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
/**
 * 从用户文本中抽取召回关键词。
 *
 * 设计目标（v0.4.1）：
 *   - 中文 2-6 字片段优先（更聚焦的短语）
 *   - 英文 camelCase / 数字复合词保留（如 "memorySave" 拆成 ["memorysave"] 一项；"v0.4.1" 拆成 ["v0.4.1"]）
 *   - 过滤常见停用词（中文常见虚词、英文常见虚词）
 *   - 限制总长度（≤ 16 字符）
 *
 * @param {string} text
 * @param {number} [max=6] - 最多返回多少个关键词
 * @returns {string[]}
 */
export function extractKeywordsForRecall(text, max = 6) {
  if (!text) return [];
  const out = [];
  const seen = new Set();

  // 中文/英文停用词（精简版；只放明显无信息量的）
  const CN_STOP = new Set([
    '的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '和', '与', '或',
    '就', '都', '也', '不', '没', '有', '一', '个', '这', '那', '把', '被', '给',
    '用', '做', '让', '请', '能', '可以', '什么', '怎么', '为什么', '上', '下', '中',
    '啊', '吗', '呢', '吧', '啦',
  ]);
  const EN_STOP = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
    'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its',
    'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did', 'let', 'say',
    'she', 'too', 'use', 'this', 'that', 'with', 'have', 'from', 'they', 'will',
    'would', 'there', 'their', 'what', 'when', 'make', 'like', 'long', 'look',
    'many', 'some', 'than', 'them', 'very', 'want', 'well', 'were', 'been',
  ]);

  const push = (s) => {
    const t = String(s).toLowerCase().trim();
    if (!t) return;
    // 长度限制
    if (t.length < 2 || t.length > 16) return;
    // 停用词（中文 1 字 / 英文全词）
    if (CN_STOP.has(t)) return;
    if (EN_STOP.has(t)) return;
    // 纯数字（无意义）
    if (/^[\d.]+$/.test(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  // 1) 中文 2-6 字片段（先扫）
  const cn = text.match(/[\u4e00-\u9fff]{2,6}/g) || [];
  for (const s of cn) push(s);

  // 2) 版本号 / 带数字的 token：v0.4.1, react18, node20
  const versionLike = text.match(/[A-Za-z]+\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*[A-Za-z]*|[A-Za-z]+-\d+/g) || [];
  for (const s of versionLike) push(s);

  // 3) dash 分隔的复合词拆开：dsh-memory → dsh, memory；cordis-plugin-loader → 三个
  //    但不拆 versionLike 已捕获过的
  const dashed = text.match(/[A-Za-z]+(?:-[A-Za-z]+)+/g) || [];
  for (const compound of dashed) {
    for (const part of compound.split('-')) push(part);
  }

  // 4) 英文 3+ 字母（去停用词）
  const en = text.match(/[A-Za-z]{3,}/g) || [];
  for (const s of en) push(s);

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
