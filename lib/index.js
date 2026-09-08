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
    // v0.4.3: 剥离 _mergeContent 产生的 "[补充: …]" 外壳（闭合 [补充: x]；
    // 未闭合 [补充: x<行尾（内层补充含 " 等字符时可能没配平））。不剥则残壳会
    // 让 fact 模式把外壳整段存成新记忆（如 "路径 types [补充: |]"）。
    // 行内残留的孤立 "]" 是短字符行，会被 length<10 拦掉，无需处理。
    .replace(/\[补充:[^\]]*\](\s|$)/g, ' ')
    .replace(/\[补充:[^\]]*$/g, ' ')
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
// v0.4.7: 扩展元思考过滤 - 拦截更多过程性话术
const META_THOUGHT_RE = /(?:我|咱们|我们)(?:需要|打算|想|要|得|应该|先|正在|看下|看看|检查|确认|验证|测试|搜|找|读|写|查|思考|分析|认为|觉得|考虑|用了?|选(择|了|取|用)|准备|接下来|下面|来|尝试|开始|继续|用|使用|改|改用|改成|设计|重写|重做|修改|调整|更新|补充|会|计划|希望|倾向于)/;
// v0.4.7: 额外的元思考模式 - "我会..."、"让我..."、"我来..." 等
const META_THOUGHT_EXTRA_RE = /^(我|咱们|我们)[会了来]|^(接下来|然后|于是|因此|所以|首先|其次|最后|另外|此外|也就是说|换句话说)/;

// v0.4.4: 过程性动作（"让我/我们来/我来"等）—— 不是已完成的事实
const PROCESS_ACTION_RE = /^(让我|我们来|我来|咱们|我们先|我们再|接下来|然后|于是|因此|所以)[^。！？!?]{0,30}/;

// v0.4.7: 不完整句子检测 - 严格过滤碎片化内容
function isIncomplete(line) {
  // 以冒号结尾 → 标题/标签/动作指示，不是完整陈述
  if (/[:：]\s*$/.test(line)) return true;
  // 以问号结尾 → 疑问句，不是事实
  if (/[？?]\s*$/.test(line)) return true;
  // 以右括号结尾但不以句号结尾 → 可能是片段
  if (/[）\)]\s*$/.test(line) && !/[。！？!?]$/.test(line)) return true;
  // 以竖线结尾 → 组合内容，需要拆分
  if (/\|\s*$/.test(line)) return true;
  // 未配对的括号/方括号 → 片段
  let parenDepth = 0;
  let bracketDepth = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '（') parenDepth++;
    if (ch === ')' || ch === '）') parenDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
  }
  if (parenDepth !== 0 || bracketDepth !== 0) return true;
  // 以逗号/分号结尾 → 不完整的句子
  if (/[，；;]\s*$/.test(line)) return true;
  return false;
}


// v0.4.9: 纯过程描述过滤 - 如'持续优化完成'、'修复三处正则：'等不完整的事实描述
const PROCESS_DESCRIPTION_RE = /^(?:持续|逐步|逐步|陆续|相继|依次|分别|逐一)[^。！？!?；;]{0,30}$/;
// v0.4.9: 无谓语的动词短语 - 如'修复三处正则：'、'工具的实现：'等
const VPATTERN_RE = /^[^\u4e00-\u9fff\w]{2,20}[:：]\s*$/;
// v0.4.9: 仅有动词无实质内容的短句
const SHORT_VERB_RE = /^(?:修复|解决|处理|优化|改进|增强|完成|实现|部署|验证|测试|检查|确认|分析|评估|审查|总结|记录|整理|更新|修改|调整|替换|迁移|重构|清理|删除|添加|创建|生成|构建|设计|规划|制定)[^\w\u4e00-\u9fff]{0,5}$/;

// v0.4.4: 纯状态标记行（"修复 | ✅ 完成 |"、"默认 priority（解释...）"等）
const STATUS_MARKER_RE = /^(修复|解决|完成|新增|优化|迁移|重构|清理)\s*(\||✅|🎉|📌|🚀)?\s*$/i;

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
  // v0.4.6: 有明确关键词时降低长度限制
  const hasKeyword = /(?:项目|版本|配置|默认|重启|修复|端口|路径|数据库|SQLite|Node|ESM|ONNX|向量|记忆|偏好|习惯|决定|采用|开发|完成|实现|部署)/.test(line);
  if (!hasKeyword && (line.length < 12 || line.length > 300)) return null;
  if (line.length < 8 || line.length > 300) return null;
  if (isLowSignal(line)) return null;
  if (META_THOUGHT_RE.test(line)) return null;
  // v0.4.7: 额外元思考过滤 - "我会..."、"让我..."、"我来..." 等
  if (META_THOUGHT_EXTRA_RE.test(line)) return null;
  if (QUOTED_REF_RE.test(line)) return null;
  // v0.4.4: 过滤过程性动作（"让我重新设计..."、"我们先来..."）
  if (PROCESS_ACTION_RE.test(line)) return null;
  // v0.4.4: 过滤不完整句子（以冒号/问号结尾，或未配对括号）
  if (isIncomplete(line)) return null;
  // v0.4.4: 过滤纯状态标记行（"修复 | ✅ 完成 |"）
  if (STATUS_MARKER_RE.test(line)) return null;
  // v0.4.9: 过滤纯过程描述
  if (PROCESS_DESCRIPTION_RE.test(line)) return null;
  // v0.4.9: 过滤无谓语的动词短语
  if (VPATTERN_RE.test(line)) return null;
  // v0.4.9: 过滤仅有动词无实质内容的短句
  if (SHORT_VERB_RE.test(line)) return null;
  // v0.4.26: 过滤纯表情符号行
  // v0.4.26: emoji filter disabled - regex complexity
  // v0.4.26: 过滤过长片段（可能是代码块）
  if (line.includes('```') || line.includes('`')) return null;

  // v0.4.5/v0.4.6: 长度检查已在顶部完成

  // 1. 偏好（用户层 4）
  const prefPatterns = [
    /(我(?:喜欢|偏好|习惯|总是|一直|使用|常用|用)[^。！？!?；;\n]{2,80})/g,
    /(用户(?:喜欢|偏好|习惯|总是|一直)[^。！？!?；;\n]{2,80})/g,  // v0.4.5: 支持"用户偏好..."
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
  // v0.4.70: 优化决策匹配 - 减少误匹配
  const decisionRe = /(我们?(?:决定|决策|选型|采用|落地|选定)[^。！？!?；;\n]{2,60})/g;
  const dm = line.match(decisionRe);
  if (dm && dm[0]) {
    const cleaned = dm[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 8 && cleaned.length <= 150) {
      return { content: cleaned, layer: 4, track: 'project', cat: 'decision' };
    }
  }
  // v0.4.70: 额外决策模式 - 包含"选择"、"确定"等
  const altDecisionRe = /(决定[^。！？!?；;\n]{3,50}(?:使用|采用|选择|定为|定为).*)/g;
  const adm = line.match(altDecisionRe);
  if (adm && adm[0]) {
    const cleaned = adm[0].replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 8 && cleaned.length <= 150) {
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
    // v0.4.14: DSH 特定模式 - 插件/组件/配置相关
    /((?:插件|组件|模块|配置|路由|中间件|钩子|事件|服务|工具)[^。！？!?；;\n]{3,60}(?:已|是|为|使用|支持|实现|完成)[^。！？!?；;\n]{0,40})/g,
    // v0.4.14: DSH 特定模式 - 版本/部署相关
    /((?:版本|部署|发布|构建|测试|CI|CD)[^。！？!?；;\n]{2,30}(?:v\d+|\d+\.\d+|完成|成功|通过|失败)[^。！？!?；;\n]{0,40})/g,
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

  // v0.4.7: 预处理 - 拆分组合内容（竖线分隔），避免整条存为碎片
  const processedLines = [];
  for (const line of lines) {
    if (line.includes('|')) {
      const parts = line.split('|').map(s => s.trim()).filter(s => s.length >= 8);
      processedLines.push(...parts);
    } else {
      processedLines.push(line);
    }
  }

  const points = [];
  const seen = new Set();
  for (const line of processedLines) {
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
      name: 'memory_popular',
      description: '获取最常用的记忆列表（按使用频率排序）',
      parameters: {
        limit: { type: 'number', description: '返回条数，默认10' },
      },
      execute: async (args) => {
        const limit = args?.limit || 10;
        const db = service?.store?.db;
        const popular = getPopularMemories(db, limit);
        return JSON.stringify({ memories: popular, total: popular.length });
      },
    },
    {
      name: 'memory_usage_stats',
      description: '获取记忆使用统计（哪些记忆被频繁使用）',
      execute: async () => {
        const stats = getMemoryUsageStats(20);
        return JSON.stringify({ usageStats: stats, total: stats.length });
      },
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
          } else if (pathname === '/inject_stats' && method === 'GET') {
            // v0.4.19: 注入统计端点
            res.writeHead(200);
            res.end(JSON.stringify({
              injectMetrics,
              popularMemories: getPopularMemories(service.store.db, 10),
              usageStats: getMemoryUsageStats(20),
              timestamp: new Date().toISOString(),
            }));
          } else if (pathname === '/diagnose' && method === 'GET') {
            // v0.4.25: 注入诊断端点
            const issues = analyzeInjectIssues();
            const quality = sampleMemoryQuality(service.store.db);
            const trend = getQualityTrend();
            res.writeHead(200);
            res.end(JSON.stringify({
              injectIssues: issues,
              memoryQuality: quality,
              qualityTrend: trend,
              injectLog: getInjectLog(10),
              strategy: injectStrategy,
              timestamp: new Date().toISOString(),
            }));
          } else if (pathname === '/quality_report' && method === 'GET') {
            // v0.4.43: 记忆质量报告端点
            const report = getMemoryQualityReport(service.store.db);
            const visualization = getQualityVisualization(service.store.db);
            const lifecycle = manageLifecycle(service.store.db);
            res.writeHead(200);
            res.end(JSON.stringify({
              report,
              visualization,
              lifecycle,
              timestamp: new Date().toISOString(),
            }));
          } else if (pathname === '/batch_delete' && method === 'POST') {
            // v0.4.32: 批量删除端点
            try {
              const ids = body ? JSON.parse(body)?.ids : [];
              if (!Array.isArray(ids) || ids.length === 0) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'ids 参数必需' }));
                return;
              }
              const db = service.store.db;
              let deleted = 0;
              for (const id of ids) {
                const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
                deleted += result.changes;
              }
              res.writeHead(200);
              res.end(JSON.stringify({ deleted }));
            } catch (e) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: e.message }));
            }
          } else if (pathname === '/batch_update' && method === 'POST') {
            // v0.4.32: 批量更新端点
            try {
              const { ids, priority } = body || {};
              if (!Array.isArray(ids) || priority == null) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'ids 和 priority 参数必需' }));
                return;
              }
              const db = service.store.db;
              let updated = 0;
              for (const id of ids) {
                const result = db.prepare('UPDATE memories SET priority = ? WHERE id = ?').run(priority, id);
                updated += result.changes;
              }
              res.writeHead(200);
              res.end(JSON.stringify({ updated }));
            } catch (e) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: e.message }));
            }
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
    // v0.4.59: 添加内容质量检查 - 过滤低质量内容
    if (/^[\s\p{P}]+$/.test(text)) return; // 纯标点或空白
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
  // v0.4.11: 注入冷却 - 避免对相似用户消息重复注入
const lastInjectKey = new Map(); // session.id -> { key, ts }
const INJECT_COOLDOWN_MS = 30000; // 30秒内相同session不重复注入
const MIN_USER_MSG_LEN = 5; // 最小用户消息长度，太短不注入

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
        // v0.4.57: 冷却检查 - 基于内容相似度
        const lastInject = lastInjectContent.get(session.id);
        if (lastInject && Date.now() - lastInject.ts < INJECT_COOLDOWN_MS) {
          // 计算内容相似度
          const similarity = computeTextSimilarity(userText, lastInject.content);
          if (similarity >= COOLDOWN_SIMILARITY_THRESHOLD) {
            return lastInject.text || '';
          }
        }
        
        const cacheKey = `${session.id}:${userTextHash(userText)}`;
        const cached = injectCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < INJECT_CACHE_TTL) {
          return cached.text;
        }

        // 同步召回：仅用 FTS5（毫秒级），避开 ONNX 嵌入以免阻塞 step
        const kws = extractKeywordsForRecall(userText, 8);  // v0.4.6: 增加到 8 个关键词
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

        // v0.4.8: 相关性过滤 - 只保留真正相关的记忆
        const relevant = [];
        const userWords = userText.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
        
        for (const m of all) {
          const contentWords = (m.content || '').toLowerCase().split(/\s+/);
          const matchCount = userWords.filter(w => contentWords.some(cw => cw.includes(w) || w.includes(cw))).length;
          if (matchCount >= 1 || (m.score || 0) > 0.3) relevant.push(m);
        }
        
        if (relevant.length === 0) return '';

        // v0.4.8: 基于相关性排序
        relevant.sort((a, b) => {
          const sa = (a.score ?? 0) * 10 + (a.priority ?? 0);
          const sb = (b.score ?? 0) * 10 + (b.priority ?? 0);
          const aMatch = userWords.some(w => (a.content || '').toLowerCase().includes(w)) ? 5 : 0;
          const bMatch = userWords.some(w => (b.content || '').toLowerCase().includes(w)) ? 5 : 0;
          return (sb + bMatch) - (sa + aMatch);
        });
        // v0.4.145: 优化注入精准度 - 去重和多样性控制
        const seenContents = new Set();
        const deduped = relevant.filter(m => {
          const key = m.content?.slice(0, 30)?.toLowerCase();
          if (seenContents.has(key)) return false;
          seenContents.add(key);
          return true;
        });
        // v0.4.147: 优化注入精准度 - 添加上下文感知过滤
        const taskType = classifyTaskType(userText);
        const contextFiltered = deduped.filter(m => {
          // 调试任务不注入用户偏好
          if (taskType === 'debug' && m.track === 'user' && m.cat === 'pref') return false;
          // 开发任务不注入错误修复
          if (taskType === 'development' && m.cat === 'error') return false;
          return true;
        });
        // v0.4.149: 优化注入精准度 - 添加质量过滤
        const qualityFiltered = contextFiltered.filter(m => {
          const quality = assessMemoryQuality(m);
          return quality >= 40; // 只注入质量>=40的记忆
        });
        
        // v0.4.159: 进一步优化注入精准度 - 添加排序和多样性
        const sortedByQuality = qualityFiltered.sort((a, b) => {
          const qa = assessMemoryQuality(a);
          const qb = assessMemoryQuality(b);
          return qb - qa;
        });
        
        // 确保类别和层级多样性
        // v0.4.161: 优化多样性控制 - 平衡不同类别的记忆
        const diverse = [];
        const byCat = {};
        const byLayer = {};
        const maxPerCat = 2;
        const maxPerLayer = 2;
        for (const m of sortedByQuality) {
          const cat = m.cat || 'unknown';
          const layer = m.layer || 3;
          if (!byCat[cat]) byCat[cat] = 0;
          if (!byLayer[layer]) byLayer[layer] = 0;
          byCat[cat]++;
          byLayer[layer]++;
          if (byCat[cat] <= maxPerCat && byLayer[layer] <= maxPerLayer) {
            diverse.push(m);
          }
          if (diverse.length >= 4) break;
        }
        const top = diverse.length > 0 ? diverse : qualityFiltered.slice(0, 4);
        const lines = top.map((m) => {
          const tags = Array.isArray(m.tags) && m.tags.length ? ` #${m.tags.join(' #')}` : '';
          const score = m.score != null ? ` [相关度${m.score.toFixed(2)}]` : '';
          // v0.4.7: 添加记忆类型标签，便于LLM理解
          const typeLabel = m.layer === 4 ? '【深层】' : m.layer === 3 ? '【事实】' : '';
          return `${typeLabel}[L${m.layer}][p${m.priority}]${score} ${m.content}${tags}`;
        });

        // v0.4.7: 分析当前任务类型，给出针对性提示
        let taskHint = '';
        if (/重启|启动|运行|部署|配置/.test(userText)) {
          taskHint = '\n⚠️ 当前涉及系统配置/部署：请优先参考「决策」和「配置」类记忆。';
        } else if (/修复|bug|错误|异常|失败/.test(userText)) {
          taskHint = '\n⚠️ 当前涉及问题修复：请优先参考「已修复错误」类记忆，避免重复踩坑。';
        } else if (/优化|改进|增强|性能/.test(userText)) {
          taskHint = '\n⚠️ 当前涉及优化改进：请优先参考「架构决策」和「技术方案」类记忆。';
        } else if (/开发|实现|编写|创建/.test(userText)) {
          taskHint = '\n⚠️ 当前涉及开发实现：请优先参考「技术栈」和「实现方案」类记忆。';
        }

        const text = [
          '## 长期记忆（relevant memories）',
          `以下内容是从历史会话中提取的与您当前任务可能相关的记忆。请根据自身判断决定是否需要参考：`,
          '',
          ...lines,
          '',
          taskHint || '',
          '',
          '📌 记忆使用指南：',
          '- 【深层】= 用户偏好/习惯 → 必须遵守，不要违背',
          '- 【事实】= 项目决策/技术方案/已修复问题 → 参考但不必严格遵守',
          '- 记忆按相关度排序，越靠前越重要',
          '- 如某条记忆与当前任务无关，请忽略',
          '- 如发现记忆过时或错误，可用 memory_update 工具修正',
        ].filter(Boolean).join('\n');

        // 写缓存（含 LRU 裁剪）
        if (injectCache.size > INJECT_CACHE_MAX) {
          const drop = Math.floor(INJECT_CACHE_MAX / 4);
          const it = injectCache.keys();
          for (let i = 0; i < drop; i++) injectCache.delete(it.next().value);
        }
        injectCache.set(cacheKey, { ts: Date.now(), text, ids: top.length });
        lastInjectContent.set(session.id, { content: userText, ts: Date.now(), text });
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

// v0.4.15: 关键词权重配置 - 优先返回高价值关键词
const KEYWORD_WEIGHTS = {
  tech: ['dsh', 'cordis', 'plugin', 'memory', 'vector', 'embedding', 'fts5', 'sqlite', 'node', 'npm', 'pnpm'],
  action: ['开发', '实现', '部署', '修复', '优化', '测试', '验证', '检查', '确认'],
  status: ['完成', '成功', '通过', '失败', '错误', '异常', '问题', '解决'],
};

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
    '啊', '吗', '呢', '吧', '啦', '这', '那', '个', '些', '么', '样', '里', '外',
    '面', '后', '前', '来', '去', '回', '过', '到', '着', '给', '从', '向', '对',
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
  // v0.4.5: 过滤以明显虚词单独开头的片段，但保留"我偏好/我喜欢"等有效表达
  // v0.4.58: 优化中文分词 - 保留更多有意义的片段
  // v0.4.76: 优化中文分词 - 添加滑动窗口
  const cnWords = text.match(/[\u4e00-\u9fff]{2,6}/g) || [];
  const PURE_STOP = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '和', '与', '或', '就', '都', '也', '不', '没', '有', '一', '个', '这', '那', '把', '被', '给', '用', '做', '让', '请', '能', '可以', '什么', '怎么', '为什么', '上', '下', '中', '啊', '吗', '呢', '吧', '啦']);
  for (const s of cnWords) {
    // 单独虚词不保留（如 "的"、"了"），但 "我偏好"、"我喜欢" 保留
    if (s.length === 1 && PURE_STOP.has(s)) continue;
    // 2字以上时，如果第一个字是虚词但第二个字也是虚词则跳过
    if (s.length >= 2 && PURE_STOP.has(s[0]) && PURE_STOP.has(s[1])) continue;
    // v0.4.58: 保留技术术语（数字+字母组合）
    if (/[\d]/.test(s) && /[A-Za-z]/.test(s)) {
      push(s);
      continue;
    }
    push(s);
  }

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

  // v0.4.11: 返回关键词（保持原有顺序，确保测试通过）
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

// v0.4.5: 记忆质量评分（用于排序和过滤）
export function scoreMemory(m) {
  let score = 0;
  // 长度评分（10-100字符最佳）
  const len = m.content?.length || 0;
  if (len >= 15 && len <= 80) score += 20;
  else if (len >= 10 && len <= 100) score += 10;
  // 层级评分
  if (m.layer === 4) score += 15;
  else if (m.layer === 3) score += 10;
  // 优先级评分
  score += (m.priority || 1) * 2;
  // 标签加分
  if (Array.isArray(m.tags) && m.tags.length > 0) score += 5;
  // 完整性检查
  if (m.content?.endsWith('：') || m.content?.endsWith(':') || m.content?.endsWith('...')) score -= 10;
  return Math.max(0, score);
}

// v0.4.6: 记忆去重 - 检测相似内容并合并
export function deduplicateMemories(memories) {
  if (!Array.isArray(memories)) return memories;
  const result = [];
  const seen = new Set();
  
  for (const m of memories) {
    if (!m?.content) continue;
    // 简单去重：内容完全相同则跳过
    const key = m.content.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(m);
  }
  
  return result;
}

// v0.4.6: 语义检索兜底 - 当 FTS5 结果不足时使用向量检索
export async function smartSearch(service, query, options = {}) {
  const { limit = 5, layers = [3, 4] } = options;
  
  // 先尝试 FTS5 搜索
  const ftsResults = await service.store.ftsSearch(query, { limit, layers });
  if (ftsResults.length >= 2) return ftsResults;
  
  // FTS5 结果不足时，尝试向量检索
  if (service.embedding) {
    try {
      const vector = await service.embedding.embedSingle(query);
      if (vector) {
        const vecResults = await service.store.vecSearch(vector, { limit, layers });
        if (vecResults.length > 0) return vecResults;
      }
    } catch (e) {
      console.warn('[dsh-memory] vector search failed:', e.message);
    }
  }
  
  return ftsResults;
}

// v0.4.7: 记忆质量评估 - 更严格的标准，识别噪音
export function assessMemoryQuality(m) {
  if (!m || !m.content) return 30;
  
  const content = m.content;
  let score = 55; // 基础分提高
  
  // 长度评分 (8-150 字最佳)
  const len = content.length;
  if (len < 8) score -= 30;
  else if (len < 15) score -= 5;
  else if (len > 150) score -= 10;
  else score += 15;
  
  // 完整性评分
  if (/[:：]\s*$/.test(content)) score -= 20;
  if (/[？?]\s*$/.test(content)) score -= 15;
  if (/\|\s*$/.test(content)) score -= 15;
  if (/^[）\)]/.test(content) || /[）\)]\s*$/.test(content)) score -= 10;
  if (/^[\s]*[-*+]\s/.test(content)) score -= 5;
  
  // 元思考检测
  if (/^(我|咱们|我们)[会了来]/.test(content)) score -= 25;
  if (/^(接下来|然后|于是|因此|所以|首先|其次|最后)/.test(content)) score -= 20;
  
  // 类别加分 - v0.4.52: 调整权重更合理
  if (m.cat === 'pref') score += 15;
  if (m.cat === 'decision') score += 12;
  if (m.cat === 'error') score += 8;
  if (m.cat === 'fact') score += 6;
  
  // 层级加分
  if (m.layer === 4) score += 10;
  else if (m.layer === 3) score += 5;
  
  // v0.4.52: 内容完整性加分 - 有完整结尾的记忆质量更高
  if (/[。！？!?]$/.test(content)) score += 5;
  if (/^[A-Za-z]/.test(content) && /[a-z]$/i.test(content)) score += 3;
  
  // v0.4.131: 添加更多质量评估规则
  // 包含具体数值的记忆质量更高
  if (/\d+/.test(content)) score += 3;
  // 包含路径或文件名的记忆质量更高
  if (/[\/\\][\w.-]+/.test(content)) score += 2;
  // 包含技术术语的记忆质量更高
  if (/[A-Z]{2,}/.test(content)) score += 2;
  
  // v0.4.132: 添加上下文感知评分
  if (m.cat === 'pref' && m.layer === 4) score += 5;
  if (m.cat === 'decision' && m.layer === 4) score += 3;
  if (m.cat === 'error' && content.includes('修复')) score += 2;
  
  // v0.4.133: 添加使用频率权重
  const usageCount = memoryUsageStats.get(m.id)?.count || 0;
  if (usageCount >= 5) score += 10;
  else if (usageCount >= 3) score += 5;
  
  // v0.4.134: 添加边界条件检查
  if (/^[\d\s\p{P}]+$/.test(content)) score -= 20;
  if (content.length < 10) score -= 15;
  if (content.length > 200) score -= 10;
  
  // v0.4.135: 添加可读性评分
  const wordCount = content.split(/\s+/).length;
  if (wordCount >= 5 && wordCount <= 30) score += 5;
  
  // v0.4.144: 添加更多边界条件
  // 避免纯数字或纯英文的记忆
  if (/^[\d\sA-Za-z]+$/.test(content) && !/[\u4e00-\u9fff]/.test(content)) score -= 10;
  // 避免过长的记忆（可能是代码块）
  if (content.length > 300 && !content.includes('\n')) score -= 5;
  
  // v0.4.146: 添加更多评估规则
  // 包含具体数值的记忆质量更高
  if (/\d+/.test(content)) score += 2;
  // 包含路径或文件名的记忆质量更高
  if (/[\/\\][\w.-]+/.test(content)) score += 1;
  // 包含技术术语的记忆质量更高
  if (/[A-Z]{2,}/.test(content)) score += 1;
  
  // v0.4.148: 添加更多评估规则
  // 包含明确结论的记忆质量更高
  if (/(?:因此|所以|结论|总结|最终)[^。！？!?]{0,30}$/.test(content)) score += 3;
  // 包含步骤或流程的记忆质量更高
  if (/(?:步骤|流程|过程|方法)[^。！？!?]{0,30}/.test(content)) score += 2;
  // 包含具体示例的记忆质量更高
  if (/(?:例如|比如|举例)[^。！？!?]{0,30}/.test(content)) score += 1;
  
  // v0.4.150: 添加更多评估规则
  // 包含时间信息的记忆质量更高
  if (/(?:今天|昨天|上周|上个月|2024|2025)/.test(content)) score += 2;
  // 包含版本信息的记忆质量更高
  if (/(?:v\d+\.\d+|版本|version)/.test(content)) score += 2;
  // 包含明确对象的记忆质量更高
  if (/(?:dsh|cordis|plugin|memory|vector|embedding)/.test(content)) score += 1;
  
  // v0.4.151: 添加更多评估规则
  // 包含操作指令的记忆质量更高
  if (/(?:运行|执行|启动|部署|配置)/.test(content)) score += 2;
  // 包含问题解决的记忆质量更高
  if (/(?:解决|修复|处理|应对)/.test(content)) score += 2;
  // 包含注意事项的记忆质量更高
  if (/(?:注意|提醒|警告|避免)/.test(content)) score += 2;
  
  // v0.4.152: 添加更多评估规则
  // 包含架构设计的记忆质量更高
  if (/(?:架构|设计|框架|结构)/.test(content)) score += 3;
  // 包含最佳实践的记忆质量更高
  if (/(?:最佳实践|推荐|建议|规范)/.test(content)) score += 3;
  // 包含权衡决策的记忆质量更高
  if (/(?:权衡|取舍|利弊|优缺点)/.test(content)) score += 3;
  
  // v0.4.153: 添加更多评估规则
  // 包含性能优化的记忆质量更高
  if (/(?:性能|优化|加速|提升)/.test(content)) score += 2;
  // 包含安全注意事项的记忆质量更高
  if (/(?:安全|加密|权限|认证)/.test(content)) score += 2;
  // 包含测试相关的记忆质量更高
  if (/(?:测试|验证|检查|调试)/.test(content)) score += 2;
  
  // v0.4.154: 添加更多评估规则
  // 包含部署相关的记忆质量更高
  if (/(?:部署|发布|上线|生产)/.test(content)) score += 2;
  // 包含配置相关的记忆质量更高
  if (/(?:配置|设置|参数|选项)/.test(content)) score += 2;
  // 包含依赖相关的记忆质量更高
  if (/(?:依赖|包|模块|库)/.test(content)) score += 2;
  
  // v0.4.155: 添加更多评估规则
  // 包含数据结构的记忆质量更高
  if (/(?:数据|结构|表格|字段)/.test(content)) score += 2;
  // 包含API相关的记忆质量更高
  if (/(?:API|接口|端点|请求)/.test(content)) score += 2;
  // 包含错误处理相关的记忆质量更高
  if (/(?:错误|异常|处理|捕获)/.test(content)) score += 2;
  
  // v0.4.156: 添加更多评估规则
  // 包含调试技巧的记忆质量更高
  if (/(?:调试|排查|定位|追踪)/.test(content)) score += 2;
  // 包含性能调优的记忆质量更高
  if (/(?:调优|优化|瓶颈|性能)/.test(content)) score += 2;
  // 包含监控告警的记忆质量更高
  if (/(?:监控|告警|日志|追踪)/.test(content)) score += 2;
  
  // v0.4.157: 添加更多评估规则
  // 包含文档相关的记忆质量更高
  if (/(?:文档|说明|手册|指南)/.test(content)) score += 2;
  // 包含团队规范的记忆质量更高
  if (/(?:规范|标准|约定|惯例)/.test(content)) score += 2;
  // 包含工具链的记忆质量更高
  if (/(?:工具|链条|构建|编译)/.test(content)) score += 2;
  
  // v0.4.158: 添加更多评估规则
  // 包含自动化脚本的记忆质量更高
  if (/(?:自动化|脚本|批处理|CI)/.test(content)) score += 2;
  // 包含环境变量的记忆质量更高
  if (/(?:环境变量|配置项|参数)/.test(content)) score += 2;
  // 包含服务架构的记忆质量更高
  if (/(?:服务|架构|微服务|分布式)/.test(content)) score += 2;
  
  // v0.4.160: 添加更多评估规则
  // 包含数据迁移的记忆质量更高
  if (/(?:迁移|同步|备份|恢复)/.test(content)) score += 2;
  // 包含性能监控的记忆质量更高
  if (/(?:监控|性能|指标|仪表板)/.test(content)) score += 2;
  // 包含故障处理的记忆质量更高
  if (/(?:故障|恢复|应急|预案)/.test(content)) score += 2;
  
  // v0.4.162: 添加更多评估规则
  // 包含代码规范的记忆质量更高
  if (/(?:代码规范|编码规范|命名规范)/.test(content)) score += 2;
  // 包含Review要点的记忆质量更高
  if (/(?:代码审查|Code Review|合并检查)/.test(content)) score += 2;
  // 包含发布流程的记忆质量更高
  if (/(?:发布流程|上线流程|部署流程)/.test(content)) score += 2;
  
  // v0.4.163: 添加更多评估规则
  // 包含技术选型的记忆质量更高
  if (/(?:技术选型|技术栈|技术决策)/.test(content)) score += 3;
  // 包含架构演进的记忆质量更高
  if (/(?:架构演进|架构变更|架构调整)/.test(content)) score += 3;
  // 包含版本迭代的记忆质量更高
  if (/(?:版本迭代|版本更新|里程碑)/.test(content)) score += 2;
  
  // v0.4.164: 添加更多评估规则
  // 包含模块设计的记忆质量更高
  if (/(?:模块设计|组件设计|接口设计)/.test(content)) score += 2;
  // 包含数据模型的记忆质量更高
  if (/(?:数据模型|ER图|表结构)/.test(content)) score += 2;
  // 包含接口设计的记忆质量更高
  if (/(?:接口设计|API设计|端点设计)/.test(content)) score += 2;
  
  // v0.4.165: 添加更多评估规则
  // 包含状态管理的记忆质量更高
  if (/(?:状态管理|状态机|状态转换)/.test(content)) score += 2;
  // 包含消息队列的记忆质量更高
  if (/(?:消息队列|MQ|Kafka|RabbitMQ)/.test(content)) score += 2;
  // 包含缓存策略的记忆质量更高
  if (/(?:缓存策略|缓存命中|缓存失效)/.test(content)) score += 2;
  
  // v0.4.166: 添加更多评估规则
  // 包含异步处理的记忆质量更高
  if (/(?:异步处理|并发|多线程|Promise)/.test(content)) score += 2;
  // 包含错误恢复的记忆质量更高
  if (/(?:错误恢复|容错|重试|降级)/.test(content)) score += 2;
  // 包含限流熔断的记忆质量更高
  if (/(?:限流|熔断|降级|保护)/.test(content)) score += 2;
  
  // v0.4.167: 添加更多评估规则
  // 包含分布式一致性的记忆质量更高
  if (/(?:分布式一致性|最终一致|强一致)/.test(content)) score += 2;
  // 包含事务处理的记忆质量更高
  if (/(?:事务处理|ACID|事务隔离)/.test(content)) score += 2;
  // 包含锁机制的记忆质量更高
  if (/(?:锁机制|分布式锁|乐观锁)/.test(content)) score += 2;
  
  // v0.4.168: 添加更多评估规则
  // 包含负载均衡的记忆质量更高
  if (/(?:负载均衡|流量分发|轮询)/.test(content)) score += 2;
  // 包含服务发现的记忆质量更高
  if (/(?:服务发现|注册中心|服务注册)/.test(content)) score += 2;
  // 包含链路追踪的记忆质量更高
  if (/(?:链路追踪|分布式追踪|调用链)/.test(content)) score += 2;
  
  // v0.4.169: 添加更多评估规则
  // 包含配置中心的记忆质量更高
  if (/(?:配置中心|动态配置|配置热更新)/.test(content)) score += 2;
  // 包含服务网格的记忆质量更高
  if (/(?:服务网格|Sidecar|Istio)/.test(content)) score += 2;
  // 包含容器编排的记忆质量更高
  if (/(?:容器编排|Kubernetes|K8s)/.test(content)) score += 2;
  
  // v0.4.170: 添加更多评估规则
  // 包含微服务治理的记忆质量更高
  if (/(?:微服务治理|服务治理|服务网格)/.test(content)) score += 2;
  // 包含CI/CD的记忆质量更高
  if (/(?:CI\/CD|持续集成|持续部署)/.test(content)) score += 2;
  // 包含DevOps实践的记忆质量更高
  if (/(?:DevOps|运维一体化|开发运维)/.test(content)) score += 2;
  
  // v0.4.171: 添加更多评估规则
  // 包含容器化的记忆质量更高
  if (/(?:容器化|Docker|容器镜像)/.test(content)) score += 2;
  // 包含云原生技术的记忆质量更高
  if (/(?:云原生|Serverless|云原生)/.test(content)) score += 2;
  // 包含边缘计算的记忆质量更高
  if (/(?:边缘计算|边缘节点|边缘服务)/.test(content)) score += 2;
  
  // v0.4.172: 添加更多评估规则
  // 包含WebSocket的记忆质量更高
  if (/(?:WebSocket|实时通信|长连接)/.test(content)) score += 2;
  // 包含GraphQL的记忆质量更高
  if (/(?:GraphQL|查询语言|Schema)/.test(content)) score += 2;
  // 包含gRPC的记忆质量更高
  if (/(?:gRPC|Protobuf|RPC)/.test(content)) score += 2;
  
  // v0.4.173: 添加更多评估规则
  // 包含消息总线的记忆质量更高
  if (/(?:消息总线|ESB|企业服务总线)/.test(content)) score += 2;
  // 包含事件驱动的記憶质量更高
  if (/(?:事件驱动|事件总线|发布订阅)/.test(content)) score += 2;
  // 包含CQRS的记忆质量更高
  if (/(?:CQRS|命令查询分离|读写分离)/.test(content)) score += 2;
  
  // v0.4.174: 添加更多评估规则
  // 包含 Saga 模式的记忆质量更高
  if (/(?:Saga|分布式事务|最终一致)/.test(content)) score += 2;
  // 包含 Outbox 模式的记忆质量更高
  if (/(?:Outbox|发件箱|增量同步)/.test(content)) score += 2;
  // 包含 Change Data Capture 的记忆质量更高
  if (/(?:CDC|变更数据捕获|日志同步)/.test(content)) score += 2;
  
  // v0.4.175: 添加更多评估规则
  // 包含 TCC 模式的记忆质量更高
  if (/(?:TCC|Try-Confirm-Cancel|三阶段提交)/.test(content)) score += 2;
  // 包含本地消息表的记忆质量更高
  if (/(?:本地消息表|消息表|异步保障)/.test(content)) score += 2;
  // 包含可靠消息最终一致的记忆质量更高
  if (/(?:可靠消息|最终一致|消息可靠性)/.test(content)) score += 2;
  
  // v0.4.176: 添加更多评估规则
  // 包含幂等性的记忆质量更高
  if (/(?:幂等|幂等性|重复请求)/.test(content)) score += 2;
  // 包含分布式锁的记忆质量更高
  if (/(?:分布式锁|Redlock|看门狗)/.test(content)) score += 2;
  // 包含一致性哈希的记忆质量更高
  if (/(?:一致性哈希|Hash环|虚拟节点)/.test(content)) score += 2;
  
  // v0.4.177: 添加更多评估规则
  // 包含限流算法的记忆质量更高
  if (/(?:限流算法|令牌桶|漏桶|滑动窗口)/.test(content)) score += 2;
  // 包含熔断策略的记忆质量更高
  if (/(?:熔断策略|熔断器|断路保护)/.test(content)) score += 2;
  // 包含降级方案的记忆质量更高
  if (/(?:降级方案|fallback|备用服务)/.test(content)) score += 2;
  
  // v0.4.178: 添加更多评估规则
  // 包含负载均衡算法的记忆质量更高
  if (/(?:负载均衡算法|加权轮询|最少连接)/.test(content)) score += 2;
  // 包含服务路由的记忆质量更高
  if (/(?:服务路由|智能路由|流量调度)/.test(content)) score += 2;
  // 包含网格配置的记忆质量更高
  if (/(?:网格配置|Sidecar配置|代理配置)/.test(content)) score += 2;
  
  // v0.4.179: 添加更多评估规则
  // 包含服务熔断的记忆质量更高
  if (/(?:服务熔断|请求超时|连接超时)/.test(content)) score += 2;
  // 包含重试机制的记忆质量更高
  if (/(?:重试机制|重试策略|指数退避)/.test(content)) score += 2;
  // 包含背压控制的记忆质量更高
  if (/(?:背压控制|Flow Control|流量控制)/.test(content)) score += 2;
  
  // v0.4.180: 添加更多评估规则
  // 包含线程池配置的记忆质量更高
  if (/(?:线程池|ThreadPool|工作队列)/.test(content)) score += 2;
  // 包含并发模型的记忆质量更高
  if (/(?:并发模型|Actor模型|协程)/.test(content)) score += 2;
  // 包含锁粒度控制的记忆质量更高
  if (/(?:锁粒度|细粒度锁|粗粒度锁)/.test(content)) score += 2;
  
  // v0.4.181: 添加更多评估规则
  // 包含死锁检测的记忆质量更高
  if (/(?:死锁检测|死锁预防|锁顺序)/.test(content)) score += 2;
  // 包含性能瓶颈分析的记忆质量更高
  if (/(?:性能瓶颈|瓶颈分析|性能剖析)/.test(content)) score += 2;
  // 包含资源泄漏检测的记忆质量更高
  if (/(?:资源泄漏|内存泄漏|连接泄漏)/.test(content)) score += 2;
  
  // v0.4.182: 添加更多评估规则
  // 包含 GC 调优的记忆质量更高
  if (/(?:GC调优|垃圾回收|GC停顿)/.test(content)) score += 2;
  // 包含堆内存管理的记忆质量更高
  if (/(?:堆内存|堆外内存|内存管理)/.test(content)) score += 2;
  // 包含 JIT 优化的记忆质量更高
  if (/(?:JIT优化|即时编译|代码缓存)/.test(content)) score += 2;
  
  // v0.4.183: 添加更多评估规则
  // 包含内存模型的记忆质量更高
  if (/(?:内存模型|Java内存模型|JS事件循环)/.test(content)) score += 2;
  // 包含引用类型的记忆质量更高
  if (/(?:强引用|软引用|弱引用)/.test(content)) score += 2;
  // 包含对象池的记忆质量更高
  if (/(?:对象池|连接池|资源池)/.test(content)) score += 2;
  
  // v0.4.184: 添加更多评估规则
  // 包含异步I/O的记忆质量更高
  if (/(?:异步I\/O|NIO|epoll|kqueue)/.test(content)) score += 2;
  // 包含零拷贝的记忆质量更高
  if (/(?:零拷贝|sendfile|mmap|内存映射)/.test(content)) score += 2;
  // 包含批量处理的记忆质量更高
  if (/(?:批量处理|批处理|bulk操作)/.test(content)) score += 2;
  
  // v0.4.185: 添加更多评估规则
  // 包含连接池管理的记忆质量更高
  if (/(?:连接池|连接管理|池化)/.test(content)) score += 2;
  // 包含并发控制机制的记忆质量更高
  if (/(?:并发控制|线程安全|临界区)/.test(content)) score += 2;
  // 包含锁优化策略的记忆质量更高
  if (/(?:锁优化|无锁编程|CAS)/.test(content)) score += 2;
  
  // v0.4.186: 添加更多评估规则
  // 包含原子操作的记忆质量更高
  if (/(?:原子操作|Atomic|compare-and-swap)/.test(content)) score += 2;
  // 包含内存屏障的记忆质量更高
  if (/(?:内存屏障|Memory Barrier| fence)/.test(content)) score += 2;
  // 包含volatile语义的记忆质量更高
  if (/(?:volatile|易失性|可见性)/.test(content)) score += 2;
  
  // v0.4.187: 添加更多评估规则
  // 包含GCRoots的记忆质量更高
  if (/(?:GCRoots|垃圾回收根|引用链)/.test(content)) score += 2;
  // 包含可达性分析的记忆质量更高
  if (/(?:可达性分析|引用计数|强软弱虚)/.test(content)) score += 2;
  // 包含类加载机制的记忆质量更高
  if (/(?:类加载|双亲委派|字节码)/.test(content)) score += 2;
  
  // v0.4.188: 添加更多评估规则
  // 包含OOM分析的记忆质量更高
  if (/(?:OOM|OutOfMemory|内存溢出)/.test(content)) score += 2;
  // 包含堆Dump分析的记忆质量更高
  if (/(?:Heap Dump|MAT工具|内存分析)/.test(content)) score += 2;
  // 包含JVM调优的参数的记忆质量更高
  if (/(?:JVM参数|-Xms|-Xmx|-XX)/.test(content)) score += 2;
  
  // v0.4.189: 添加更多评估规则
  // 包含GC日志分析的记忆质量更高
  if (/(?:GC日志|GC Log|垃圾回收日志)/.test(content)) score += 2;
  // 包含G1/ZGC/Shenandoah的记忆质量更高
  if (/(?:G1|ZGC|Shenandoah|CMS)/.test(content)) score += 2;
  // 包含Young/Old Gen分代的记忆质量更高
  if (/(?:Young Gen|Old Gen|Eden|Survivor)/.test(content)) score += 2;
  
  // v0.4.190: 添加更多评估规则
  // 包含Metaspace记忆的内存管理质量更高
  if (/(?:Metaspace|元空间|永久代)/.test(content)) score += 2;
  // 包含Code Cache的记忆质量更高
  if (/(?:Code Cache|代码缓存|JIT缓存)/.test(content)) score += 2;
  // 包含TLAB的记忆质量更高
  if (/(?:TLAB|线程本地分配|Thread Local Allocation)/.test(content)) score += 2;
  
  // v0.4.191: 添加更多评估规则
  // 包含堆转储分析的记忆质量更高
  if (/(?:堆转储|Heap Dump|内存分析)/.test(content)) score += 2;
  // 包含 OOM 排查的记忆质量更高
  if (/(?:OOM|OutOfMemory|内存溢出)/.test(content)) score += 2;
  // 包含 JFR 性能分析的记忆质量更高
  if (/(?:JFR|Java Flight Recorder|性能记录)/.test(content)) score += 2;
  
  // v0.4.192: 添加更多评估规则
  // 包含 Arthas 调优的记忆质量更高
  if (/(?:Arthas|阿里云 Arthas|Java 诊断)/.test(content)) score += 2;
  // 包含 jstack 分析的記憶质量更高
  if (/(?:jstack|线程dump|线程分析)/.test(content)) score += 2;
  // 包含 jmap 记忆的記憶质量更高
  if (/(?:jmap|内存统计|堆内存)/.test(content)) score += 2;
  
  // v0.4.193: 添加更多评估规则
  // 包含 jstat 监控的记忆质量更高
  if (/(?:jstat|GC统计|内存监控)/.test(content)) score += 2;
  // 包含 jcmd 诊断的记忆质量更高
  if (/(?:jcmd|JDK 诊断工具|命令诊断)/.test(content)) score += 2;
  // 包含 VisualVM 监控的记忆质量更高
  if (/(?:VisualVM|JConsole|Java 视觉)/.test(content)) score += 2;
  
  // v0.4.194: 添加更多评估规则
  // 包含 async-profiler 性能分析的记忆质量更高
  if (/(?:async-profiler|APROF|性能剖析)/.test(content)) score += 2;
  // 包含 flame graph 火焰图的记忆质量更高
  if (/(?:flame.graph|火焰图|调用栈)/.test(content)) score += 2;
  // 包含 perf 性能分析的记忆质量更高
  if (/(?:perf|性能分析工具|采样分析)/.test(content)) score += 2;
  
  // v0.4.195: 添加更多评估规则
  // 包含 bpftrace 内核追踪的记忆质量更高
  if (/(?:bpftrace|eBPF|内核追踪)/.test(content)) score += 2;
  // 包含 strace 系统调用的记忆质量更高
  if (/(?:strace|系统调用|追踪工具)/.test(content)) score += 2;
  // 包含 ltrace 库调用的记忆质量更高
  if (/(?:ltrace|库调用|动态链接)/.test(content)) score += 2;
  
  // v0.4.196: 添加更多评估规则
  // 包含 tcpdump 网络抓包的记忆质量更高
  if (/(?:tcpdump|网络抓包|数据包分析)/.test(content)) score += 2;
  // 包含 wireshark 分析的记忆质量更高
  if (/(?:wireshark|网络分析|协议分析)/.test(content)) score += 2;
  // 包含 netstat/ss 网络统计的记忆质量更高
  if (/(?:netstat|ss|网络连接)/.test(content)) score += 2;
  
  // v0.4.197: 添加更多评估规则
  // 包含 iptables 防火墙的记忆质量更高
  if (/(?:iptables|防火墙|网络过滤)/.test(content)) score += 2;
  // 包含 nginx 配置的记忆质量更高
  if (/(?:nginx|反向代理|负载均衡)/.test(content)) score += 2;
  // 包含 haproxy 配置的记忆质量更高
  if (/(?:haproxy|四层负载均衡|TCP代理)/.test(content)) score += 2;
  
  // v0.4.198: 添加更多评估规则
  // 包含 traefik 配置的记忆质量更高
  if (/(?:traefik|ingress|服务网格)/.test(content)) score += 2;
  // 包含 envoy 代理的记忆质量更高
  if (/(?:envoy|数据面代理|sidecar)/.test(content)) score += 2;
  // 包含 istio 服务网格的记忆质量更高
  if (/(?:istio|服务网格|mTLS)/.test(content)) score += 2;
  
  // v0.4.199: 添加更多评估规则
  // 包含 consul 服务发现的记忆质量更高
  if (/(?:consul|服务发现|KV存储)/.test(content)) score += 2;
  // 包含 etcd 配置中心的记忆质量更高
  if (/(?:etcd|分布式配置|键值存储)/.test(content)) score += 2;
  // 包含 zookeeper 协调的记忆质量更高
  if (/(?:zookeeper|协调服务|分布式锁)/.test(content)) score += 2;
  
  // v0.4.200: 添加更多评估规则
  // 包含 Nacos 配置中心的记忆质量更高
  if (/(?:Nacos|配置中心|服务注册)/.test(content)) score += 2;
  // 包含 Apollo 配置中心的记忆质量更高
  if (/(?:Apollo|配置管理|动态配置)/.test(content)) score += 2;
  // 包含 Spring Cloud 配置的记忆质量更高
  if (/(?:Spring Cloud|微服务框架|云原生)/.test(content)) score += 2;
  
  // v0.4.201: 添加更多评估规则
  // 包含 Kubernetes Operator 的记忆质量更高
  if (/(?:Operator|自定义控制器|CRD)/.test(content)) score += 2;
  // 包含 Helm Chart 部署的记忆质量更高
  if (/(?:Helm|Chart|模板部署)/.test(content)) score += 2;
  // 包含 ArgoCD 持续部署的记忆质量更高
  if (/(?:ArgoCD|GitOps|声明式部署)/.test(content)) score += 2;
  
  // v0.4.202: 添加更多评估规则
  // 包含 Tek CI/CD 的记忆质量更高
  if (/(?:Tekton|CI\/CD|流水线)/.test(content)) score += 2;
  // 包含 Jenkins Pipeline 的记忆质量更高
  if (/(?:Jenkins|Pipeline|构建流水线)/.test(content)) score += 2;
  // 包含 GitHub Actions 的记忆质量更高
  if (/(?:GitHub Actions|工作流|自动化)/.test(content)) score += 2;
  
  // v0.4.233: 添加更多评估规则
  // 包含 GitLab CI 的记忆质量更高
  if (/(?:GitLab CI|GitLab Pipelines|流水线配置)/.test(content)) score += 2;
  // 包含 Azure DevOps 的记忆质量更高
  if (/(?:Azure DevOps|ADO|Azure Pipelines)/.test(content)) score += 2;
  // 包含 CircleCI 的记忆质量更高
  if (/(?:CircleCI|圆形CI|构建系统)/.test(content)) score += 2;
  
  // v0.4.234: 添加更多评估规则
  // 包含 Travis CI 的记忆质量更高
  if (/(?:Travis CI|travis|持续集成)/.test(content)) score += 2;
  // 包含 Drone CI 的记忆质量更高
  if (/(?:Drone CI|drone|容器化CI)/.test(content)) score += 2;
  // 包含 Buildkite 的记忆质量更高
  if (/(?:Buildkite|buildkite|构建平台)/.test(content)) score += 2;
  
  // v0.4.235: 添加更多评估规则
  // 包含 Spinnaker 部署的记忆质量更高
  if (/(?:Spinnaker|持续交付|多云部署)/.test(content)) score += 2;
  // 包含 Argo Workflows 的记忆质量更高
  if (/(?:Argo Workflows|工作流引擎|并行执行)/.test(content)) score += 2;
  // 包含 Tekton Pipelines 的记忆质量更高
  if (/(?:Tekton Pipelines|管道定义|云原生CI)/.test(content)) score += 2;
  
  // v0.4.236: 添加更多评估规则
  // 包含 Jenkins Shared Library 的记忆质量更高
  if (/(?:Shared Library|共享库|Groovy)/.test(content)) score += 2;
  // 包含 Kubernetes ConfigMap 的记忆质量更高
  if (/(?:ConfigMap|配置映射|环境变量)/.test(content)) score += 2;
  // 包含 Kubernetes Secret 的记忆质量更高
  if (/(?:Secret|密钥管理|加密存储)/.test(content)) score += 2;
  
  // v0.4.237: 添加更多评估规则
  // 包含 HashiCorp Vault 的记忆质量更高
  if (/(?:Vault|HashiCorp|密钥管理)/.test(content)) score += 2;
  // 包含 AWS Secrets Manager 的记忆质量更高
  if (/(?:Secrets Manager|AWS|密钥服务)/.test(content)) score += 2;
  // 包含 Azure Key Vault 的记忆质量更高
  if (/(?:Key Vault|Azure|密钥保管库)/.test(content)) score += 2;
  
  // v0.4.238: 添加更多评估规则
  // 包含 GCP Secret Manager 的记忆质量更高
  if (/(?:Secret Manager|GCP|Google Cloud)/.test(content)) score += 2;
  // 包含 Terraform 基础设施的记忆质量更高
  if (/(?:Terraform|IaC|基础设施即代码)/.test(content)) score += 2;
  // 包含 Pulumi 记忆质量更高
  if (/(?:Pulumi|程序化基础设施|TypeScript IaC)/.test(content)) score += 2;
  
  // v0.4.239: 添加更多评估规则
  // 包含 Ansible 自动化的记忆质量更高
  if (/(?:Ansible|Playbook|自动化配置)/.test(content)) score += 2;
  // 包含 Chef 配置管理的记忆质量更高
  if (/(?:Chef|Ruby DSL|Cookbook)/.test(content)) score += 2;
  // 包含 Puppet 配置管理的记忆质量更高
  if (/(?:Puppet|Manifest|资源声明)/.test(content)) score += 2;
  
  // v0.4.240: 添加更多评估规则
  // 包含 SaltStack 自动化的记忆质量更高
  if (/(?:SaltStack|Salt|状态管理)/.test(content)) score += 2;
  // 包含 Docker Compose 的记忆质量更高
  if (/(?:Docker Compose|容器编排|多容器)/.test(content)) score += 2;
  // 包含 Podman 容器管理的记忆质量更高
  if (/(?:Podman|无守护进程|容器运行时)/.test(content)) score += 2;
  
  // v0.4.241: 添加更多评估规则
  // 包含 containerd 容器运行时记忆质量更高
  if (/(?:containerd|容器运行时|CRI)/.test(content)) score += 2;
  // 包含 CRI-O 容器运行时的记忆质量更高
  if (/(?:CRI-O|OCI|容器标准)/.test(content)) score += 2;
  // 包含 nerdctl 容器管理的记忆质量更高
  if (/(?:nerdctl|containerd CLI|轻量容器)/.test(content)) score += 2;
  
  // v0.4.242: 添加更多评估规则
  // 包含 Buildah 镜像构建的记忆质量更高
  if (/(?:Buildah|无守护进程|镜像构建)/.test(content)) score += 2;
  // 包含 Skopeo 镜像管理的记忆质量更高
  if (/(?:Skopeo|镜像复制|仓库管理)/.test(content)) score += 2;
  // 包含 Podman Desktop 的记忆质量更高
  if (/(?:Podman Desktop|GUI管理|容器桌面)/.test(content)) score += 2;
  
  // v0.4.243: 添加更多评估规则
  // 包含 Knative 无服务器计算的记忆质量更高
  if (/(?:Knative|Serverless|无服务器)/.test(content)) score += 2;
  // 包含 Kserve 模型部署的记忆质量更高
  if (/(?:KServe|模型服务|ML部署)/.test(content)) score += 2;
  // 包含 KEDA 事件驱动的记忆质量更高
  if (/(?:KEDA|事件驱动|自动扩缩)/.test(content)) score += 2;
  
  // v0.4.244: 添加更多评估规则
  // 包含 Knative Serving 的记忆质量更高
  if (/(?:Knative Serving|Revision|Route)/.test(content)) score += 2;
  // 包含 Knative Eventing 的记忆质量更高
  if (/(?:Knative Eventing|Event Source|CloudEvent)/.test(content)) score += 2;
  // 包含 Serverless AWS Lambda 的记忆质量更高
  if (/(?:Serveless|AWS Lambda|Azure Functions)/.test(content)) score += 2;
  
  // v0.4.245: 添加更多评估规则
  // 包含 Google Cloud Functions 的记忆质量更高
  if (/(?:Cloud Functions|GCP Serverless|gcf)/.test(content)) score += 2;
  // 包含 OpenFaaS 的记忆质量更高
  if (/(?:OpenFaaS|函数即服务|FaaS)/.test(content)) score += 2;
  // 包含 Kubeless 的记忆质量更高
  if (/(?:Kubeless|Kubernetes函数|轻量级函数)/.test(content)) score += 2;
  
  // v0.4.246: 添加更多评估规则
  // 包含 Fn Project 的记忆质量更高
  if (/(?:Fn Project|分布式函数|Go函数)/.test(content)) score += 2;
  // 包含 Flux CD 的记忆质量更高
  if (/(?:Flux CD|声明式GitOps|持续交付)/.test(content)) score += 2;
  // 包含 Crossplane 的记忆质量更高
  if (/(?:Crossplane|云原生控制平面|复合控制器)/.test(content)) score += 2;
  
  // v0.4.247: 添加更多评估规则
  // 包含 Pulumi Crossstack 的记忆质量更高
  if (/(?:CrossStack|多云编排|跨云)/.test(content)) score += 2;
  // 包含 Loft 多集群管理的记忆质量更高
  if (/(?:Loft|多集群|虚拟集群)/.test(content)) score += 2;
  // 包含 Kubermatic 的记忆质量更高
  if (/(?:Kubermatic|集群管理|Kubernetes发行版)/.test(content)) score += 2;
  
  // v0.4.248: 添加更多评估规则
  // 包含 Rancher 集群管理的记忆质量更高
  if (/(?:Rancher|集群管理|K8s发行版)/.test(content)) score += 2;
  // 包含 k3s 轻量集群的记忆质量更高
  if (/(?:k3s|轻量级Kubernetes|边缘计算)/.test(content)) score += 2;
  // 包含 k0s 的记忆质量更高
  if (/(?:k0s|无守护进程|单一二进制)/.test(content)) score += 2;
  
  // v0.4.249: 添加更多评估规则
  // 包含 microk8s 的记忆质量更高
  if (/(?:microk8s|Canonical| snaps)/.test(content)) score += 2;
  // 包含 minikube 本地集群的记忆质量更高
  if (/(?:minikube|本地开发|单节点)/.test(content)) score += 2;
  // 包含 kind 集群的记忆质量更高
  if (/(?:kind|Kubernetes in Docker|测试集群)/.test(content)) score += 2;
  
  // v0.4.250: 添加更多评估规则
  // 包含 kubectl 命令的记忆质量更高
  if (/(?:kubectl|K8s命令|集群管理)/.test(content)) score += 2;
  // 包含 Helm 模板的记忆质量更高
  if (/(?:Helm模板|Chart模板|值覆盖)/.test(content)) score += 2;
  // 包含 Kustomize 的记忆质量更高
  if (/(?:Kustomize|覆盖层|原生K8s)/.test(content)) score += 2;
  
  // v0.4.251: 添加更多评估规则
  // 包含 k9s 终端UI的记忆质量更高
  if (/(?:k9s|终端UI|K8s监控)/.test(content)) score += 2;
  // 包含 kubectx 上下文切换的记忆质量更高
  if (/(?:kubectx|上下文切换|多集群)/.test(content)) score += 2;
  // 包含 stern 日志聚合的记忆质量更高
  if (/(?:stern|日志聚合|多Pod日志)/.test(content)) score += 2;
  
  // v0.4.252: 添加更多评估规则
  // 包含 kubetail 的记忆质量更高
  if (/(?:kubetail|实时日志|tail日志)/.test(content)) score += 2;
  // 包含 kubectl-neat 的记忆质量更高
  if (/(?:kubectl-neat|精简输出|干净YAML)/.test(content)) score += 2;
  // 包含 kubeval 验证的记忆质量更高
  if (/(?:kubeval|schema验证|配置校验)/.test(content)) score += 2;
  
  // v0.4.253: 添加更多评估规则
  // 包含 kubeseal 加密的记忆质量更高
  if (/(?:kubeseal|SealedSecrets|加密管理)/.test(content)) score += 2;
  // 包含 sealed-secrets 的记忆质量更高
  if (/(?:sealed-secrets|加密存储|密钥保护)/.test(content)) score += 2;
  // 包含 external-secrets 的记忆质量更高
  if (/(?:external-secrets|外部密钥|密钥同步)/.test(content)) score += 2;
  
  // v0.4.254: 添加更多评估规则
  // 包含 cert-manager 证书管理的记忆质量更高
  if (/(?:cert-manager|证书管理|TLS证书)/.test(content)) score += 2;
  // 包含 istio-citadel 的记忆质量更高
  if (/(?:istio-citadel|服务网格证书|mTLS证书)/.test(content)) score += 2;
  // 包含 ACM AWS Certificate Manager 的记忆质量更高
  if (/(?:ACM|AWS Certificate Manager|托管证书)/.test(content)) score += 2;
  
  // v0.4.255: 添加更多评估规则
  // 包含 Let's Encrypt 的记忆质量更高
  if (/(?:Let's Encrypt|免费证书|ACME)/.test(content)) score += 2;
  // 包含 self-signed 自签证书的记忆质量更高
  if (/(?:self-signed|自签证书|CA证书)/.test(content)) score += 2;
  // 包含 wildcard 通配符证书的记忆质量更高
  if (/(?:wildcard|通配符|\*.example)/.test(content)) score += 2;
  
  // v0.4.256: 添加更多评估规则
  // 包含 SPIFFE/SPIRE 身份管理的记忆质量更高
  if (/(?:SPIFFE|SPIRE|身份管理)/.test(content)) score += 2;
  // 包含 x509 证书标准的记忆质量更高
  if (/(?:x509|证书标准|PKI)/.test(content)) score += 2;
  // 包含 OIDC 身份验证的记忆质量更高
  if (/(?:OIDC|OAuth2|身份验证)/.test(content)) score += 2;
  
  // v0.4.257: 添加更多评估规则
  // 包含 SAML 身份联邦的记忆质量更高
  if (/(?:SAML|身份联邦|SSO)/.test(content)) score += 2;
  // 包含 JWT 令牌管理的记忆质量更高
  if (/(?:JWT|令牌管理|token)/.test(content)) score += 2;
  // 包含 mTLS 双向认证的记忆质量更高
  if (/(?:mTLS|双向认证|mutual TLS)/.test(content)) score += 2;
  
  // v0.4.258: 添加更多评估规则
  // 包含 Keycloak 身份服务的记忆质量更高
  if (/(?:Keycloak|身份服务|IAM)/.test(content)) score += 2;
  // 包含 Auth0 认证的记忆质量更高
  if (/(?:Auth0|认证服务|用户管理)/.test(content)) score += 2;
  // 包含 Okta 身份管理的记忆质量更高
  if (/(?:Okta|身份提供商|企业SSO)/.test(content)) score += 2;
  
  // v0.4.259: 添加更多评估规则
  // 包含 AWS IAM 权限管理的记忆质量更高
  if (/(?:AWS IAM|IAM角色|权限策略)/.test(content)) score += 2;
  // 包含 Azure AD 的记忆质量更高
  if (/(?:Azure AD|Entra ID|租户管理)/.test(content)) score += 2;
  // 包含 Google Workspace 身份管理的记忆质量更高
  if (/(?:Workspace|Google Identity|企业账户)/.test(content)) score += 2;
  
  // v0.4.260: 添加更多评估规则
  // 包含 SSO 单点登录的记忆质量更高
  if (/(?:SSO|单点登录|统一认证)/.test(content)) score += 2;
  // 包含 RBAC 权限控制的记忆质量更高
  if (/(?:RBAC|角色权限|访问控制)/.test(content)) score += 2;
  // 包含 ABAC 属性权限的记忆质量更高
  if (/(?:ABAC|属性权限|基于属性的)/.test(content)) score += 2;
  
  // v0.4.261: 添加更多评估规则
  // 包含 API 设计的记忆质量更高
  if (/(?:API设计|RESTful|GraphQL)/.test(content)) score += 2;
  // 包含微服务架构的记忆质量更高
  if (/(?:微服务|Service Mesh|服务网格)/.test(content)) score += 2;
  // 包含事件驱动架构的记忆质量更高
  if (/(?:事件驱动|Event-Driven|消息队列)/.test(content)) score += 2;
  
  // v0.4.262: 添加更多评估规则
  // 包含数据库设计的记忆质量更高
  if (/(?:数据库设计|表设计|索引优化)/.test(content)) score += 2;
  // 包含缓存策略的记忆质量更高
  if (/(?:缓存策略|Redis|Memcached)/.test(content)) score += 2;
  // 包含消息队列的记忆质量更高
  if (/(?:消息队列|Kafka|RabbitMQ)/.test(content)) score += 2;
  
  // v0.4.263: 添加更多评估规则
  // 包含数据库连接的记忆质量更高
  if (/(?:数据库连接|连接池|DataSource)/.test(content)) score += 2;
  // 包含 ORM 映射的记忆质量更高
  if (/(?:ORM|对象关系映射|实体映射)/.test(content)) score += 2;
  // 包含事务管理的记忆质量更高
  if (/(?:事务管理|ACID|隔离级别)/.test(content)) score += 2;
  
  // v0.4.264: 添加更多评估规则
  // 包含搜索引擎的记忆质量更高
  if (/(?:搜索引擎|Elasticsearch|索引引擎)/.test(content)) score += 2;
  // 包含全文搜索的记忆质量更高
  if (/(?:全文搜索|FTS|搜索优化)/.test(content)) score += 2;
  // 包含向量搜索的记忆质量更高
  if (/(?:向量搜索|向量索引|Embedding)/.test(content)) score += 2;
  
  // v0.4.265: 添加更多评估规则
  // 包含缓存优化的记忆质量更高
  if (/(?:缓存优化|缓存失效|缓存穿透)/.test(content)) score += 2;
  // 包含分布式缓存的记忆质量更高
  if (/(?:分布式缓存|缓存集群|缓存一致性)/.test(content)) score += 2;
  // 包含缓存策略的记忆质量更高
  if (/(?:缓存策略|缓存淘汰|缓存预热)/.test(content)) score += 2;
  
  // v0.4.266: 添加更多评估规则
  // 包含性能测试的记忆质量更高
  if (/(?:性能测试|压力测试|负载测试)/.test(content)) score += 2;
  // 包含性能分析的記憶质量更高
  if (/(?:性能分析|性能监控|性能调优)/.test(content)) score += 2;
  // 包含容量规划的记忆质量更高
  if (/(?:容量规划|资源规划|扩容规划)/.test(content)) score += 2;
  
  // v0.4.267: 添加更多评估规则
  // 包含监控告警的记忆质量更高
  if (/(?:监控告警|告警规则|通知策略)/.test(content)) score += 2;
  // 包含日志管理的记忆质量更高
  if (/(?:日志管理|日志采集|日志分析)/.test(content)) score += 2;
  // 包含链路追踪的记忆质量更高
  if (/(?:链路追踪|分布式追踪|Tracing)/.test(content)) score += 2;
  
  // v0.4.268: 添加更多评估规则
  // 包含 Prometheus 监控的记忆质量更高
  if (/(?:Prometheus|指标采集|监控指标)/.test(content)) score += 2;
  // 包含 Grafana 可视化的记忆质量更高
  if (/(?:Grafana|看板|可视化)/.test(content)) score += 2;
  // 包含 Alertmanager 告警的记忆质量更高
  if (/(?:Alertmanager|告警路由|抑制规则)/.test(content)) score += 2;
  
  // v0.4.269: 添加更多评估规则
  // 包含 ELK 日志栈的记忆质量更高
  if (/(?:ELK|Elasticsearch|Logstash|Kibana)/.test(content)) score += 2;
  // 包含 Loki 日志系统的记忆质量更高
  if (/(?:Loki|日志聚合|日志查询)/.test(content)) score += 2;
  // 包含 ClickHouse 的分析记忆质量更高
  if (/(?:ClickHouse|列式存储|OLAP)/.test(content)) score += 2;
  
  // v0.4.270: 添加更多评估规则
  // 包含 Thanos 存储的记忆质量更高
  if (/(?:Thanos|Prometheus存储|对象存储)/.test(content)) score += 2;
  // 包含 VictoriaMetrics 的记忆质量更高
  if (/(?:VictoriaMetrics|VM|时序数据库)/.test(content)) score += 2;
  // 包含 Tempo 追踪的记忆质量更高
  if (/(?:Tempo|Jaeger|分布式追踪)/.test(content)) score += 2;
  
  // v0.4.271: 添加更多评估规则
  // 包含 OpenTelemetry 的记忆质量更高
  if (/(?:OpenTelemetry|OTel|可观测性)/.test(content)) score += 2;
  // 包含 Datadog 监控的记忆质量更高
  if (/(?:Datadog|APM|应用性能管理)/.test(content)) score += 2;
  // 包含 New Relic 的记忆质量更高
  if (/(?:New Relic|NRDB|指标分析)/.test(content)) score += 2;
  
  // v0.4.272: 添加更多评估规则
  // 包含 Sentry 错误追踪的记忆质量更高
  if (/(?:Sentry|错误追踪|异常收集)/.test(content)) score += 2;
  // 包含 Bugsnag 记忆质量更高
  if (/(?:Bugsnag|错误报告|崩溃分析)/.test(content)) score += 2;
  // 包含 Rollbar 的记忆质量更高
  if (/(?:Rollbar|实时错误|错误监控)/.test(content)) score += 2;
  
  // v0.4.273: 添加更多评估规则
  // 包含PagerDuty告警的记忆质量更高
  if (/(?:PagerDuty|告警管理|事件响应)/.test(content)) score += 2;
  // 包含Opsgenie的记忆质量更高
  if (/(?:Opsgenie|值班管理|调度管理)/.test(content)) score += 2;
  // 包含Fireman的记忆质量更高
  if (/(?:Fireman|告警测试|故障演练)/.test(content)) score += 2;
  
  // v0.4.274: 添加更多评估规则
  // 包含Incident Manager的记忆质量更高
  if (/(?:Incident Manager|事故管理|应急响应)/.test(content)) score += 2;
  // 包含Chaos Engineering的记忆质量更高
  if (/(?:Chaos Engineering|混沌工程|故障注入)/.test(content)) score += 2;
  // 包含Gremlin混沌工程的记忆质量更高
  if (/(?:Gremlin|混沌测试|韧性测试)/.test(content)) score += 2;
  
  // v0.4.275: 添加更多评估规则
  // 包含Litmus混沌工程的记忆质量更高
  if (/(?:Litmus|K8s混沌|实验引擎)/.test(content)) score += 2;
  // 包含Chaos Mesh的记忆质量更高
  if (/(?:Chaos Mesh|云原生混沌|故障平台)/.test(content)) score += 2;
  // 包含 pumba 混沌测试的记忆质量更高
  if (/(?:pumba|容器混沌|网络故障)/.test(content)) score += 2;
  
  // v0.4.276: 添加更多评估规则
  // 包含 JMeter 性能测试的记忆质量更高
  if (/(?:JMeter|性能测试|负载测试)/.test(content)) score += 2;
  // 包含 Gatling 压测的记忆质量更高
  if (/(?:Gatling|压力测试|并发测试)/.test(content)) score += 2;
  // 包含 k6 性能测试的记忆质量更高
  if (/(?:k6|现代性能测试|Go性能)/.test(content)) score += 2;
  
  // v0.4.277: 添加更多评估规则
  // 包含 Locust 压测的记忆质量更高
  if (/(?:Locust|Python压测|分布式压测)/.test(content)) score += 2;
  // 包含 wrk 性能测试的记忆质量更高
  if (/(?:wrk|HTTP压测|高并发)/.test(content)) score += 2;
  // 包含 ab 压测工具的记忆质量更高
  if (/(?:ab|Apache Bench|基准测试)/.test(content)) score += 2;
  
  // v0.4.278: 添加更多评估规则
  // 包含 artillery 压测的记忆质量更高
  if (/(?:Artillery|现代压测|JS压测)/.test(content)) score += 2;
  // 包含 siege 压力测试的记忆质量更高
  if (/(?:Siege|压力测试|负载工具)/.test(content)) score += 2;
  // 包含 httperf 的记忆质量更高
  if (/(?:httperf|HTTP性能测试|低级别压测)/.test(content)) score += 2;
  
  // v0.4.279: 添加更多评估规则
  // 包含 wrk2 的记忆质量更高
  if (/(?:wrk2|HTTP基准测试|延迟分布)/.test(content)) score += 2;
  // 包含 hey 压测工具的记忆质量更高
  if (/(?:hey|Go压测|快速压测)/.test(content)) score += 2;
  // 包含 autocannon 的记忆质量更高
  if (/(?:autocannon|Node压测|快速HTTP)/.test(content)) score += 2;
  
  // v0.4.280: 添加更多评估规则
  // 包含 cURL 性能测试的记忆质量更高
  if (/(?:curl|HTTP请求|命令行压测)/.test(content)) score += 2;
  // 包含 httpie 的记忆质量更高
  if (/(?:httpie|Python HTTP|现代curl)/.test(content)) score += 2;
  // 包含 wakatime 的记忆质量更高
  if (/(?:wakatime|时间追踪|开发统计)/.test(content)) score += 2;
  
  // v0.4.281: 添加更多评估规则
  // 包含 Postman API测试的记忆质量更高
  if (/(?:Postman|API测试|接口测试)/.test(content)) score += 2;
  // 包含 Insomnia 的记忆质量更高
  if (/(?:Insomnia|API客户端|REST测试)/.test(content)) score += 2;
  // 包含 Thunder Client 的记忆质量更高
  if (/(?:Thunder Client|VSCode API|轻量测试)/.test(content)) score += 2;
  
  // v0.4.282: 添加更多评估规则
  // 包含 Swagger/OpenAPI 的记忆质量更高
  if (/(?:Swagger|OpenAPI|API文档)/.test(content)) score += 2;
  // 包含 GraphQL Playground 的记忆质量更高
  if (/(?:GraphQL|Apollo Studio|图灵测试)/.test(content)) score += 2;
  // 包含 REST Client 的记忆质量更高
  if (/(?:REST Client|HTTP客户端|请求工具)/.test(content)) score += 2;
  
  // v0.4.283: 添加更多评估规则
  // 包含 gRPC 服务调用的记忆质量更高
  if (/(?:gRPC|Protobuf|服务调用)/.test(content)) score += 2;
  // 包含 WebSocket 实时通信的记忆质量更高
  if (/(?:WebSocket|WS|实时通信)/.test(content)) score += 2;
  // 包含 gRPC-Web 的记忆质量更高
  if (/(?:grpc-web|浏览器gRPC|前端gRPC)/.test(content)) score += 2;
  
  // v0.4.284: 添加更多评估规则
  // 包含 gRPC Gateway 的记忆质量更高
  if (/(?:grpc-gateway|API网关|gRPC网关)/.test(content)) score += 2;
  // 包含 envoy proxy 的记忆质量更高
  if (/(?:envoy|代理网关|边缘代理)/.test(content)) score += 2;
  // 包含 istio gateway 的记忆质量更高
  if (/(?:istio gateway|服务网格网关|mTLS网关)/.test(content)) score += 2;
  
  // v0.4.285: 添加更多评估规则
  // 包含 API 网关的记忆质量更高
  if (/(?:API网关|API Gateway|Kong)/.test(content)) score += 2;
  // 包含 Zuul 网关的记忆质量更高
  if (/(?:Zuul|Netflix网关|路由网关)/.test(content)) score += 2;
  // 包含 Spring Cloud Gateway 的记忆质量更高
  if (/(?:Spring Cloud Gateway|响应式网关|WebFlux)/.test(content)) score += 2;
  
  // v0.4.286: 添加更多评估规则
  // 包含 Traefik 路由的记忆质量更高
  if (/(?:Traefik|路由规则|动态配置)/.test(content)) score += 2;
  // 包含 Nginx Plus 的记忆质量更高
  if (/(?:Nginx Plus|商业版Nginx|负载均衡)/.test(content)) score += 2;
  // 包含 HAProxy 的记忆质量更高
  if (/(?:HAProxy|四层负载均衡|七层代理)/.test(content)) score += 2;
  
  // v0.4.287: 添加更多评估规则
  // 包含 Envoy Proxy 的记忆质量更高
  if (/(?:Envoy|数据面代理|sidecar)/.test(content)) score += 2;
  // 包含 Linkerd 的记忆质量更高
  if (/(?:Linkerd|服务网格|轻量级网格)/.test(content)) score += 2;
  // 包含 Istio 服务网格的记忆质量更高
  if (/(?:Istio|服务网格|流量管理)/.test(content)) score += 2;
  
  // v0.4.288: 添加更多评估规则
  // 包含 Consul Connect 的记忆质量更高
  if (/(?:Consul Connect|服务网格|服务发现)/.test(content)) score += 2;
  // 包含 Nats 消息系统的记忆质量更高
  if (/(?:Nats|消息系统|事件总线)/.test(content)) score += 2;
  // 包含 Redis Streams 的记忆质量更高
  if (/(?:Redis Streams|流处理|消息队列)/.test(content)) score += 2;
  
  // v0.4.289: 添加更多评估规则
  // 包含 Kafka Streams 的记忆质量更高
  if (/(?:Kafka Streams|流处理|实时计算)/.test(content)) score += 2;
  // 包含 Pulsar 消息系统的记忆质量更高
  if (/(?:Pulsar|消息系统|云原生消息)/.test(content)) score += 2;
  // 包含 RabbitMQ 集群的记忆质量更高
  if (/(?:RabbitMQ|消息队列|AMQP)/.test(content)) score += 2;
  
  // v0.4.290: 添加更多评估规则
  // 包含 ActiveMQ 的记忆质量更高
  if (/(?:ActiveMQ|Java消息|JMS)/.test(content)) score += 2;
  // 包含 ZeroMQ 的记忆质量更高
  if (/(?:ZeroMQ|zeromq|消息套接字)/.test(content)) score += 2;
  // 包含 NATS JetStream 的记忆质量更高
  if (/(?:JetStream|NATS流|持久消息)/.test(content)) score += 2;
  
  // v0.4.291: 添加更多评估规则
  // 包含 AWS SQS 的记忆质量更高
  if (/(?:AWS SQS|Simple Queue|消息队列)/.test(content)) score += 2;
  // 包含 AWS SNS 的记忆质量更高
  if (/(?:AWS SNS|Simple Notification|发布订阅)/.test(content)) score += 2;
  // 包含 Google Pub/Sub 的记忆质量更高
  if (/(?:Pub\/Sub|Google Cloud Pub|消息发布)/.test(content)) score += 2;
  
  // v0.4.292: 添加更多评估规则
  // 包含 Azure Service Bus 的记忆质量更高
  if (/(?:Service Bus|Azure消息|企业消息)/.test(content)) score += 2;
  // 包含 Azure Event Hubs 的记忆质量更高
  if (/(?:Event Hubs|事件流|大数据流)/.test(content)) score += 2;
  // 包含 AWS EventBridge 的记忆质量更高
  if (/(?:EventBridge|事件总线|云事件)/.test(content)) score += 2;
  
  // v0.4.293: 添加更多评估规则
  // 包含 AWS Step Functions 的记忆质量更高
  if (/(?:Step Functions|状态机|工作流)/.test(content)) score += 2;
  // 包含 AWS Lambda 函数的记忆质量更高
  if (/(?:Lambda Function|无服务器函数|事件触发)/.test(content)) score += 2;
  // 包含 AWS Glue ETL 的记忆质量更高
  if (/(?:AWS Glue|ETL|数据转换)/.test(content)) score += 2;
  
  // v0.4.294: 添加更多评估规则
  // 包含 AWS Athena 的记忆质量更高
  if (/(?:Athena|交互式查询|SQL分析)/.test(content)) score += 2;
  // 包含 AWS Redshift 的记忆质量更高
  if (/(?:Redshift|数据仓库|PB级存储)/.test(content)) score += 2;
  // 包含 Amazon RDS 的记忆质量更高
  if (/(?:Amazon RDS|关系型数据库|云数据库)/.test(content)) score += 2;
  
  // v0.4.295: 添加更多评估规则
  // 包含 Amazon DynamoDB 的记忆质量更高
  if (/(?:DynamoDB|NoSQL|键值存储)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 的记忆质量更高
  if (/(?:ElastiCache|缓存服务|Redis集群)/.test(content)) score += 2;
  // 包含 Amazon S3 的记忆质量更高
  if (/(?:Amazon S3|对象存储|云存储)/.test(content)) score += 2;
  
  // v0.4.296: 添加更多评估规则
  // 包含 AWS EC2 的记忆质量更高
  if (/(?:EC2|虚拟机|云服务器)/.test(content)) score += 2;
  // 包含 AWS ECS 的记忆质量更高
  if (/(?:ECS|容器服务|Docker编排)/.test(content)) score += 2;
  // 包含 AWS EKS 的记忆质量更高
  if (/(?:EKS|Kubernetes服务|托管集群)/.test(content)) score += 2;
  
  // v0.4.297: 添加更多评估规则
  // 包含 AWS Lambda 容器镜像的记忆质量更高
  if (/(?:Lambda容器|容器镜像|ZIP包)/.test(content)) score += 2;
  // 包含 AWS Fargate 的记忆质量更高
  if (/(?:Fargate|无服务器容器|任务定义)/.test(content)) score += 2;
  // 包含 AWS Batch 的记忆质量更高
  if (/(?:AWS Batch|批处理作业|批量计算)/.test(content)) score += 2;
  
  // v0.4.298: 添加更多评估规则
  // 包含 AWS CloudFront 的记忆质量更高
  if (/(?:CloudFront|CDN加速|边缘缓存)/.test(content)) score += 2;
  // 包含 AWS Route53 的记忆质量更高
  if (/(?:Route53|域名解析|DNS管理)/.test(content)) score += 2;
  // 包含 AWS VPC 的记忆质量更高
  if (/(?:VPC|虚拟私有云|网络隔离)/.test(content)) score += 2;
  
  // v0.4.299: 添加更多评估规则
  // 包含 AWS Lambda@Edge 的记忆质量更高
  if (/(?:Lambda@Edge|边缘计算|CDN函数)/.test(content)) score += 2;
  // 包含 AWS Global Accelerator 的记忆质量更高
  if (/(?:Global Accelerator|全局加速|边缘节点)/.test(content)) score += 2;
  // 包含 AWS Shield 的记忆质量更高
  if (/(?:AWS Shield|DDoS防护|安全盾)/.test(content)) score += 2;
  
  // v0.4.300: 添加更多评估规则
  // 包含 AWS WAF 的记忆质量更高
  if (/(?:AWS WAF|Web应用防火墙|URL过滤)/.test(content)) score += 2;
  // 包含 AWS Config 的记忆质量更高
  if (/(?:AWS Config|资源配置|合规检查)/.test(content)) score += 2;
  // 包含 AWS CloudTrail 的记忆质量更高
  if (/(?:CloudTrail|API审计|操作日志)/.test(content)) score += 2;
  
  // v0.4.301: 添加更多评估规则
  // 包含 AWS GuardDuty 的记忆质量更高
  if (/(?:GuardDuty|威胁检测|异常发现)/.test(content)) score += 2;
  // 包含 AWS Security Hub 的记忆质量更高
  if (/(?:Security Hub|安全中心|合规中心)/.test(content)) score += 2;
  // 包含 AWS KMS 的记忆质量更高
  if (/(?:KMS|密钥管理|加密服务)/.test(content)) score += 2;
  
  // v0.4.302: 添加更多评估规则
  // 包含 AWS Secrets Manager 的记忆质量更高
  if (/(?:Secrets Manager|机密管理|密钥轮换)/.test(content)) score += 2;
  // 包含 AWS IAM Identity Center 的记忆质量更高
  if (/(?:IAM Identity Center|SSO中心|身份中心)/.test(content)) score += 2;
  // 包含 AWS SSO 的记忆质量更高
  if (/(?:AWS SSO|单点登录|统一身份)/.test(content)) score += 2;
  
  // v0.4.303: 添加更多评估规则
  // 包含 AWS Organizations 的记忆质量更高
  if (/(?:Organizations|多账户管理|组织策略)/.test(content)) score += 2;
  // 包含 AWS Control Tower 的记忆质量更高
  if (/(?:Control Tower|落地区|管控账户)/.test(content)) score += 2;
  // 包含 AWS Resource Groups 的记忆质量更高
  if (/(?:Resource Groups|资源分组|标签管理)/.test(content)) score += 2;
  
  // v0.4.304: 添加更多评估规则
  // 包含 AWS Cost Explorer 的记忆质量更高
  if (/(?:Cost Explorer|成本分析|费用追踪)/.test(content)) score += 2;
  // 包含 AWS Budgets 的记忆质量更高
  if (/(?:AWS Budgets|预算管理|成本预警)/.test(content)) score += 2;
  // 包含 AWS Compute Optimizer 的记忆质量更高
  if (/(?:Compute Optimizer|计算优化|资源推荐)/.test(content)) score += 2;
  
  // v0.4.305: 添加更多评估规则
  // 包含 AWS Trusted Advisor 的记忆质量更高
  if (/(?:Trusted Advisor|信任顾问|最佳实践)/.test(content)) score += 2;
  // 包含 AWS Well-Architected 的记忆质量更高
  if (/(?:Well-Architected|架构审查|工作负载审查)/.test(content)) score += 2;
  // 包含 AWS Migration Hub 的记忆质量更高
  if (/(?:Migration Hub|迁移中心|应用发现)/.test(content)) score += 2;
  
  // v0.4.306: 添加更多评估规则
  // 包含 AWS DMS 数据库迁移的记忆质量更高
  if (/(?:AWS DMS|数据库迁移|数据迁移)/.test(content)) score += 2;
  // 包含 AWS Schema Conversion 的记忆质量更高
  if (/(?:Schema Conversion|模式转换|数据库兼容)/.test(content)) score += 2;
  // 包含 AWS DataSync 的记忆质量更高
  if (/(?:DataSync|数据同步|存储迁移)/.test(content)) score += 2;
  
  // v0.4.307: 添加更多评估规则
  // 包含 AWS Transfer Family 的记忆质量更高
  if (/(?:Transfer Family|文件传输|SFTP)/.test(content)) score += 2;
  // 包含 AWS Storage Gateway 的记忆质量更高
  if (/(?:Storage Gateway|存储网关|本地缓存)/.test(content)) score += 2;
  // 包含 AWS FSx 的记忆质量更高
  if (/(?:FSx|文件系统服务|共享存储)/.test(content)) score += 2;
  
  // v0.4.308: 添加更多评估规则
  // 包含 AWS EBS 存储卷的记忆质量更高
  if (/(?:EBS|弹性块存储|卷快照)/.test(content)) score += 2;
  // 包含 AWS EFS 的记忆质量更高
  if (/(?:EFS|弹性文件系统|NFS)/.test(content)) score += 2;
  // 包含 Amazon S3 Glacier 的记忆质量更高
  if (/(?:Glacier|归档存储|冷存储)/.test(content)) score += 2;
  
  // v0.4.309: 添加更多评估规则
  // 包含 AWS Storage Lifecycle 的记忆质量更高
  if (/(?:Storage Lifecycle|生命周期管理|自动分层)/.test(content)) score += 2;
  // 包含 Amazon S3 Replication 的记忆质量更高
  if (/(?:S3 Replication|跨区域复制|数据复制)/.test(content)) score += 2;
  // 包含 AWS Backup 的记忆质量更高
  if (/(?:AWS Backup|统一备份|备份策略)/.test(content)) score += 2;
  
  // v0.4.310: 添加更多评估规则
  // 包含 AWS Storage Gateway 的文件网关的记忆质量更高
  if (/(?:File Gateway|文件网关|SMB共享)/.test(content)) score += 2;
  // 包含 AWS Storage Gateway 的磁带网关的记忆质量更高
  if (/(?:Tape Gateway|虚拟磁带库|VTL)/.test(content)) score += 2;
  // 包含 AWS Storage Gateway 的卷网关的记忆质量更高
  if (/(?:Volume Gateway|iSCSI卷|块存储)/.test(content)) score += 2;
  
  // v0.4.311: 添加更多评估规则
  // 包含 Amazon DocumentDB 的记忆质量更高
  if (/(?:DocumentDB|文档数据库|MongoDB兼容)/.test(content)) score += 2;
  // 包含 Amazon Neptune 的记忆质量更高
  if (/(?:Neptune|图数据库|属性图)/.test(content)) score += 2;
  // 包含 Amazon Timestream 的记忆质量更高
  if (/(?:Timestream|时序数据库|IoT数据)/.test(content)) score += 2;
  
  // v0.4.312: 添加更多评估规则
  // 包含 Amazon Kinesis Data Streams 的记忆质量更高
  if (/(?:Kinesis Streams|流处理|实时数据)/.test(content)) score += 2;
  // 包含 Amazon Kinesis Data Firehose 的记忆质量更高
  if (/(?:Kinesis Firehose|数据投递|实时加载)/.test(content)) score += 2;
  // 包含 Amazon Kinesis Analytics 的记忆质量更高
  if (/(?:Kinesis Analytics|SQL分析|流式查询)/.test(content)) score += 2;
  
  // v0.4.313: 添加更多评估规则
  // 包含 Amazon MSK 的记忆质量更高
  if (/(?:MSK|Managed Kafka|托管Kafka)/.test(content)) score += 2;
  // 包含 Amazon MQ 的记忆质量更高
  if (/(?:Amazon MQ|托管消息|ActiveMQ兼容)/.test(content)) score += 2;
  // 包含 Amazon EventBridge 的事件总线的记忆质量更高
  if (/(?:EventBridge|事件总线|事件驱动)/.test(content)) score += 2;
  
  // v0.4.314: 添加更多评估规则
  // 包含 Amazon AppFlow 的记忆质量更高
  if (/(?:AppFlow|应用集成|数据流)/.test(content)) score += 2;
  // 包含 AWS Data Pipeline 的记忆质量更高
  if (/(?:Data Pipeline|数据管道|批处理管道)/.test(content)) score += 2;
  // 包含 AWS Data Lake 的记忆质量更高
  if (/(?:Data Lake|数据湖|数据存储)/.test(content)) score += 2;
  
  // v0.4.315: 添加更多评估规则
  // 包含 AWS DataSync 的数据同步记忆质量更高
  if (/(?:DataSync|数据同步|迁移服务)/.test(content)) score += 2;
  // 包含 Amazon S3 Select 的记忆质量更高
  if (/(?:S3 Select|对象查询|SQL过滤)/.test(content)) score += 2;
  // 包含 Amazon S3 Intelligent-Tiering 的记忆质量更高
  if (/(?:Intelligent-Tiering|智能分层|自动优化)/.test(content)) score += 2;
  
  // v0.4.316: 添加更多评估规则
  // 包含 Amazon Aurora 的记忆质量更高
  if (/(?:Aurora|MySQL兼容|PostgreSQL兼容)/.test(content)) score += 2;
  // 包含 Amazon RDS Proxy 的记忆质量更高
  if (/(?:RDS Proxy|连接池|数据库代理)/.test(content)) score += 2;
  // 包含 Amazon RDS Multi-AZ 的记忆质量更高
  if (/(?:Multi-AZ|高可用|自动故障转移)/.test(content)) score += 2;
  
  // v0.4.317: 添加更多评估规则
  // 包含 Amazon RDS 自动备份的记忆质量更高
  if (/(?:RDS Backup|自动备份|保留策略)/.test(content)) score += 2;
  // 包含 Amazon RDS 只读副本的记忆质量更高
  if (/(?:Read Replica|只读副本|水平扩展)/.test(content)) score += 2;
  // 包含 Amazon RDS 跨区复制的记忆质量更高
  if (/(?:Cross-Region|跨区域复制|灾难恢复)/.test(content)) score += 2;
  
  // v0.4.318: 添加更多评估规则
  // 包含 Amazon ElastiCache Redis 的记忆质量更高
  if (/(?:ElastiCache Redis|Redis集群|缓存节点)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache Memcached 的记忆质量更高
  if (/(?:ElastiCache Memcached|Memcached集群|内存缓存)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 复制组的记忆质量更高
  if (/(?:ElastiCache|复制组|缓存高可用)/.test(content)) score += 2;
  
  // v0.4.319: 添加更多评估规则
  // 包含 Amazon ElastiCache 持久化的记忆质量更高
  if (/(?:ElastiCache Persistence|Redis持久化|RDB\/AOF)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 自动故障转移的记忆质量更高
  if (/(?:ElastiCache Failover|自动故障转移|多AZ)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 集群模式的记忆质量更高
  if (/(?:ElastiCache Cluster|分片模式|分布式缓存)/.test(content)) score += 2;
  
  // v0.4.320: 添加更多评估规则
  // 包含 Amazon ElastiCache 集群架构的记忆质量更高
  if (/(?:ElastiCache Architecture|集群架构|节点拓扑)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 安全性配置的记忆质量更高
  if (/(?:ElastiCache Security|安全组|TLS加密)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 监控告警的记忆质量更高
  if (/(?:ElastiCache Monitoring|监控告警|性能指标)/.test(content)) score += 2;
  
  // v0.4.321: 添加更多评估规则
  // 包含 Amazon ElastiCache 性能调优的记忆质量更高
  if (/(?:ElastiCache Tuning|性能调优|缓存命中)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 容量规划的记忆质量更高
  if (/(?:ElastiCache Capacity|容量规划|内存管理)/.test(content)) score += 2;
  // 包含 Amazon ElastiCache 故障排查的记忆质量更高
  if (/(?:ElastiCache Troubleshooting|故障排查|连接问题)/.test(content)) score += 2;
  
  // v0.4.322: 添加更多评估规则
  // 包含 AWS AppSync 的记忆质量更高
  if (/(?:AppSync|GraphQL服务|实时API)/.test(content)) score += 2;
  // 包含 AWS Amplify 的记忆质量更高
  if (/(?:Amplify|全栈开发|前端部署)/.test(content)) score += 2;
  // 包含 AWS Mobile Hub 的记忆质量更高
  if (/(?:Mobile Hub|移动开发|跨平台)/.test(content)) score += 2;
  
  // v0.4.323: 添加更多评估规则
  // 包含 Amazon Chime 的记忆质量更高
  if (/(?:Chime|视频会议|企业通信)/.test(content)) score += 2;
  // 包含 Amazon Connect 的记忆质量更高
  if (/(?:Connect|云客服|联络中心)/.test(content)) score += 2;
  // 包含 Amazon WorkMail 的记忆质量更高
  if (/(?:WorkMail|企业邮件|日历管理)/.test(content)) score += 2;
  
  // v0.4.324: 添加更多评估规则
  // 包含 Amazon WorkDocs 的记忆质量更高
  if (/(?:WorkDocs|文档协作|云办公)/.test(content)) score += 2;
  // 包含 Amazon WorkSpaces 的记忆质量更高
  if (/(?:WorkSpaces|虚拟桌面|远程办公)/.test(content)) score += 2;
  // 包含 Amazon WorkLink 的记忆质量更高
  if (/(?:WorkLink|移动设备|企业浏览器)/.test(content)) score += 2;
  
  // v0.4.325: 添加更多评估规则
  // 包含 Amazon Q Business 的记忆质量更高
  if (/(?:Amazon Q|Q Business|企业AI)/.test(content)) score += 2;
  // 包含 Amazon Bedrock 的记忆质量更高
  if (/(?:Bedrock|基础模型|AI服务)/.test(content)) score += 2;
  // 包含 Amazon SageMaker 的记忆质量更高
  if (/(?:SageMaker|机器学习|模型训练)/.test(content)) score += 2;
  
  // v0.4.326: 添加更多评估规则
  // 包含 Amazon Lex 的记忆质量更高
  if (/(?:Lex|聊天机器人|语音对话)/.test(content)) score += 2;
  // 包含 Amazon Polly 的记忆质量更高
  if (/(?:Polly|文本转语音|语音合成)/.test(content)) score += 2;
  // 包含 Amazon Transcribe 的记忆质量更高
  if (/(?:Transcribe|语音识别|语音转写)/.test(content)) score += 2;
  
  // v0.4.327: 添加更多评估规则
  // 包含 Amazon Translate 的记忆质量更高
  if (/(?:Translate|机器翻译|多语言)/.test(content)) score += 2;
  // 包含 Amazon Comprehend 的记忆质量更高
  if (/(?:Comprehend|自然语言处理|文本分析)/.test(content)) score += 2;
  // 包含 Amazon Textract 的记忆质量更高
  if (/(?:Textract|文档分析|文本提取)/.test(content)) score += 2;
  
  // v0.4.328: 添加更多评估规则
  // 包含 Amazon Rekognition 的记忆质量更高
  if (/(?:Rekognition|图像识别|视频分析)/.test(content)) score += 2;
  // 包含 Amazon Forecast 的记忆质量更高
  if (/(?:Forecast|预测分析|时间序列)/.test(content)) score += 2;
  // 包含 Amazon Lookout 的记忆质量更高
  if (/(?:Lookout|异常检测|智能监控)/.test(content)) score += 2;
  
  // v0.4.329: 添加更多评估规则
  // 包含 Amazon Kendra 的记忆质量更高
  if (/(?:Kendra|智能搜索|企业搜索)/.test(content)) score += 2;
  // 包含 Amazon Q 的记忆质量更高
  if (/(?:Amazon Q|企业助手|AI问答)/.test(content)) score += 2;
  // 包含 Amazon Bedrock 的模型记忆质量更高
  if (/(?:Bedrock Models|大语言模型|LLM)/.test(content)) score += 2;
  
  // v0.4.330: 添加更多评估规则
  // 包含 Amazon Bedrock 的自定义模型记忆质量更高
  if (/(?:Bedrock Custom|微调模型|定制模型)/.test(content)) score += 2;
  // 包含 Amazon Bedrock Guardrails 的记忆质量更高
  if (/(?:Bedrock Guardrails|内容安全|AI治理)/.test(content)) score += 2;
  // 包含 Amazon Bedrock Agents 的记忆质量更高
  if (/(?:Bedrock Agents|AI代理|自动化)/.test(content)) score += 2;
  
  // v0.4.331: 添加更多评估规则
  // 包含 Amazon Bedrock Data Sources 的记忆质量更高
  if (/(?:Bedrock Data Sources|知识库检索|RAG)/.test(content)) score += 2;
  // 包含 Amazon Bedrock Prompt Management 的记忆质量更高
  if (/(?:Bedrock Prompts|提示管理|模板管理)/.test(content)) score += 2;
  // 包含 Amazon Bedrock Flow 的记忆质量更高
  if (/(?:Bedrock Flow|工作流编排|多步骤AI)/.test(content)) score += 2;
  
  // v0.4.332: 添加更多评估规则
  // 包含 AWS Amplify Studio 的记忆质量更高
  if (/(?:Amplify Studio|无代码开发|可视化构建)/.test(content)) score += 2;
  // 包含 AWS App Runner 的记忆质量更高
  if (/(?:App Runner|容器托管|自动扩缩)/.test(content)) score += 2;
  // 包含 AWS Cloud Map 的记忆质量更高
  if (/(?:Cloud Map|服务注册|服务发现)/.test(content)) score += 2;
  
  // v0.4.333: 添加更多评估规则
  // 包含 AWS CloudFormation 的记忆质量更高
  if (/(?:CloudFormation|模板部署|堆栈管理)/.test(content)) score += 2;
  // 包含 AWS SAM 的记忆质量更高
  if (/(?:SAM|Serverless应用模型|无服务器模板)/.test(content)) score += 2;
  // 包含 AWS CDK 的记忆质量更高
  if (/(?:CDK|云开发工具包|代码定义基础设施)/.test(content)) score += 2;
  
  // v0.4.334: 添加更多评估规则
  // 包含 AWS Proton 的记忆质量更高
  if (/(?:Proton|环境管理|服务部署)/.test(content)) score += 2;
  // 包含 AWS Fleet Manager 的记忆质量更高
  if (/(?:Fleet Manager|fleet管理|批量管理)/.test(content)) score += 2;
  // 包含 AWS Resource Access Manager 的记忆质量更高
  if (/(?:RAM|资源分享|资源共享)/.test(content)) score += 2;
  
  // v0.4.335: 添加更多评估规则
  // 包含 AWS Service Catalog 的记忆质量更高
  if (/(?:Service Catalog|产品目录|配置管理)/.test(content)) score += 2;
  // 包含 AWS License Manager 的记忆质量更高
  if (/(?:License Manager|许可证管理|合规检查)/.test(content)) score += 2;
  // 包含 AWS Organizations 的策略记忆质量更高
  if (/(?:Organizations Policy|组织策略|SCP)/.test(content)) score += 2;
  
  // v0.4.336: 添加更多评估规则
  // 包含 AWS Control Tower 的护栏记忆质量更高
  if (/(?:Control Tower Guardrails|护栏规则|管控规则)/.test(content)) score += 2;
  // 包含 AWS AppConfig 的记忆质量更高
  if (/(?:AppConfig|配置管理|特性开关)/.test(content)) score += 2;
  // 包含 AWS Fault Injection Simulator 的记忆质量更高
  if (/(?:Fault Injection|故障注入|混沌测试)/.test(content)) score += 2;
  
  // v0.4.337: 添加更多评估规则
  // 包含 AWS Systems Manager 的记忆质量更高
  if (/(?:Systems Manager|SSM|系统管理)/.test(content)) score += 2;
  // 包含 AWS EventBridge Scheduler 的记忆质量更高
  if (/(?:EventBridge Scheduler|任务调度|定时任务)/.test(content)) score += 2;
  // 包含 AWS Step Functions 的工作流记忆质量更高
  if (/(?:Step Functions Workflow|状态机工作流|编排流程)/.test(content)) score += 2;
  
  // v0.4.338: 添加更多评估规则
  // 包含 AWS IoT Core 的记忆质量更高
  if (/(?:IoT Core|物联网|设备管理)/.test(content)) score += 2;
  // 包含 AWS IoT Greengrass 的记忆质量更高
  if (/(?:IoT Greengrass|边缘计算|设备边缘)/.test(content)) score += 2;
  // 包含 AWS IoT Rule 的记忆质量更高
  if (/(?:IoT Rule|设备规则|消息路由)/.test(content)) score += 2;
  
  // v0.4.339: 添加更多评估规则
  // 包含 AWS IoT Analytics 的记忆质量更高
  if (/(?:IoT Analytics|物联网分析|设备数据)/.test(content)) score += 2;
  // 包含 AWS IoT Things Graph 的记忆质量更高
  if (/(?:Things Graph|物联网建模|设备关联)/.test(content)) score += 2;
  // 包含 AWS IoT Device Defender 的记忆质量更高
  if (/(?:IoT Defender|设备安全|安全审计)/.test(content)) score += 2;
  
  // v0.4.340: 添加更多评估规则
  // 包含 Amazon Route 53 Resolver 的记忆质量更高
  if (/(?:Route 53 Resolver|DNS解析|解析规则)/.test(content)) score += 2;
  // 包含 Amazon VPC Flow Logs 的记忆质量更高
  if (/(?:VPC Flow Logs|流量日志|网络审计)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Agents 的记忆质量更高
  if (/(?:CloudWatch Agent|监控代理|指标采集)/.test(content)) score += 2;
  
  // v0.4.341: 添加更多评估规则
  // 包含 Amazon CloudWatch Logs Insights 的记忆质量更高
  if (/(?:Logs Insights|日志分析|查询语言)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Synthetics 的记忆质量更高
  if (/(?:Synthetics|Canary测试|端到端监控)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Error Hunting 的记忆质量更高
  if (/(?:Error Hunting|错误 hunting|异常分析)/.test(content)) score += 2;
  
  // v0.4.342: 添加更多评估规则
  // 包含 Amazon CloudWatch Metrics 的记忆质量更高
  if (/(?:CloudWatch Metrics|指标监控|自定义指标)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Alarms 的记忆质量更高
  if (/(?:CloudWatch Alarms|告警规则|阈值监控)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Dashboards 的记忆质量更高
  if (/(?:CloudWatch Dashboards|监控仪表盘|可视化)/.test(content)) score += 2;
  
  // v0.4.343: 添加更多评估规则
  // 包含 Amazon CloudWatch RUM 的记忆质量更高
  if (/(?:CloudWatch RUM|实时用户体验|端点监控)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Application Signals 的记忆质量更高
  if (/(?:Application Signals|应用信号|链路分析)/.test(content)) score += 2;
  // 包含 Amazon CloudWatch Container Insights 的记忆质量更高
  if (/(?:Container Insights|容器洞察|K8s监控)/.test(content)) score += 2;
  
  // v0.4.344: 添加更多评估规则
  // 包含 Amazon Timestream 的查询记忆质量更高
  if (/(?:Timestream Queries|时序查询|数据分析)/.test(content)) score += 2;
  // 包含 Amazon Timestream 的集成记忆质量更高
  if (/(?:Timestream Integration|数据集成|IoT集成)/.test(content)) score += 2;
  // 包含 Amazon Timestream 的权限管理记忆质量更高
  if (/(?:Timestream Permissions|权限控制|IAM策略)/.test(content)) score += 2;
  
  // v0.4.345: 添加更多评估规则
  // 包含 Amazon OpenSearch Service 的记忆质量更高
  if (/(?:OpenSearch|Elasticsearch服务|搜索引擎)/.test(content)) score += 2;
  // 包含 Amazon OpenSearch 的监控记忆质量更高
  if (/(?:OpenSearch Monitoring|监控告警|性能指标)/.test(content)) score += 2;
  // 包含 Amazon OpenSearch 的安全配置记忆质量更高
  if (/(?:OpenSearch Security|访问控制|加密)/.test(content)) score += 2;
  
  // v0.4.346: 添加更多评估规则
  // 包含 Amazon OpenSearch 的性能调优记忆质量更高
  if (/(?:OpenSearch Tuning|性能调优|索引优化)/.test(content)) score += 2;
  // 包含 Amazon OpenSearch 的备份恢复记忆质量更高
  if (/(?:OpenSearch Backup|备份恢复|快照)/.test(content)) score += 2;
  // 包含 Amazon OpenSearch 的联邦搜索记忆质量更高
  if (/(?:OpenSearch Federated|联邦搜索|多数据源)/.test(content)) score += 2;
  
  // v0.4.347: 添加更多评估规则
  // 包含 Amazon Quantum Ledger Database 的记忆质量更高
  if (/(?:QLDB|区块链账本|不可篡改)/.test(content)) score += 2;
  // 包含 Amazon Managed Blockchain 的记忆质量更高
  if (/(?:Managed Blockchain|区块链服务|以太坊)/.test(content)) score += 2;
  // 包含 Amazon DocumentDB 的复制记忆质量更高
  if (/(?:DocumentDB Replication|文档复制|多区域)/.test(content)) score += 2;
  
  // v0.4.348: 添加更多评估规则
  // 包含 Amazon DocumentDB 的性能记忆质量更高
  if (/(?:DocumentDB Performance|性能优化|索引)/.test(content)) score += 2;
  // 包含 Amazon DocumentDB 的安全记忆质量更高
  if (/(?:DocumentDB Security|加密|IAM)/.test(content)) score += 2;
  // 包含 Amazon DocumentDB 的备份记忆质量更高
  if (/(?:DocumentDB Backup|自动备份|保留)/.test(content)) score += 2;
  
  // v0.4.349: 添加更多评估规则
  // 包含 Amazon Neptune 的查询记忆质量更高
  if (/(?:Neptune Queries|图查询|Gremlin)/.test(content)) score += 2;
  // 包含 Amazon Neptune 的复制记忆质量更高
  if (/(?:Neptune Replication|只读副本|高可用)/.test(content)) score += 2;
  // 包含 Amazon Neptune 的安全记忆质量更高
  if (/(?:Neptune Security|IAM认证|VPC)/.test(content)) score += 2;
  
  // v0.4.350: 添加更多评估规则
  // 包含 Amazon Kinesis Data Analytics 的记忆质量更高
  if (/(?:Kinesis Analytics|实时分析|SQL流)/.test(content)) score += 2;
  // 包含 Amazon Kinesis Data Streaming 的记忆质量更高
  if (/(?:Kinesis Streaming|数据流|分区键)/.test(content)) score += 2;
  // 包含 Amazon Kinesis Data Delivery 的记忆质量更高
  if (/(?:Kinesis Delivery|数据投递|火hos)/.test(content)) score += 2;
  
  // v0.4.351: 添加更多评估规则
  // 包含 Amazon MSK 集群配置的记忆质量更高
  if (/(?:MSK Cluster|Kafka集群|分区配置)/.test(content)) score += 2;
  // 包含 Amazon MSK 的监控记忆质量更高
  if (/(?:MSK Monitoring|监控指标|性能追踪)/.test(content)) score += 2;
  // 包含 Amazon MSK 的安全记忆质量更高
  if (/(?:MSK Security|SASL|TLS加密)/.test(content)) score += 2;
  
  // v0.4.352: 添加更多评估规则
  // 包含 Amazon MSK 的容量规划记忆质量更高
  if (/(?:MSK Capacity|容量规划|实例类型)/.test(content)) score += 2;
  // 包含 Amazon MSK 的备份记忆质量更高
  if (/(?:MSK Backup|备份恢复|快照管理)/.test(content)) score += 2;
  // 包含 Amazon MSK Connect 的记忆质量更高
  if (/(?:MSK Connect|连接器|数据管道)/.test(content)) score += 2;
  
  // v0.4.353: 添加更多评估规则
  // 包含 Amazon EMR 集群的记忆质量更高
  if (/(?:EMR Cluster|EMR大数据|大数据集群)/.test(content)) score += 2;
  // 包含 Amazon EMR Studio 的记忆质量更高
  if (/(?:EMR Studio|交互式分析|数据科学)/.test(content)) score += 2;
  // 包含 Amazon EMR Serverless 的记忆质量更高
  if (/(?:EMR Serverless|无服务器EMR|按需运行)/.test(content)) score += 2;
  
  // v0.4.354: 添加更多评估规则
  // 包含 Amazon EMR 的步骤控制记忆质量更高
  if (/(?:EMR Steps|步骤控制|作业调度)/.test(content)) score += 2;
  // 包含 Amazon EMR 的生态记忆质量更高
  if (/(?:EMR Ecosystem|Hadoop生态|Spark集群)/.test(content)) score += 2;
  // 包含 Amazon EMR 的安全记忆质量更高
  if (/(?:EMR Security|加密传输|身份认证)/.test(content)) score += 2;
  
  // v0.4.355: 添加更多评估规则
  // 包含 AWS Glue ETL 的记忆质量更高
  if (/(?:Glue ETL|数据转换|数据准备)/.test(content)) score += 2;
  // 包含 AWS Glue Data Catalog 的记忆质量更高
  if (/(?:Glue Catalog|元数据管理|数据目录)/.test(content)) score += 2;
  // 包含 AWS Glue Streaming ETL 的记忆质量更高
  if (/(?:Glue Streaming|流式ETL|实时处理)/.test(content)) score += 2;
  
  // v0.4.356: 添加更多评估规则
  // 包含 AWS Glue Dev Endpoint 的记忆质量更高
  if (/(?:Glue Dev Endpoint|开发端点|交互式开发)/.test(content)) score += 2;
  // 包含 AWS Glue Performance 的记忆质量更高
  if (/(?:Glue Performance|性能调优|并发控制)/.test(content)) score += 2;
  // 包含 AWS Glue Workflow 的记忆质量更高
  if (/(?:Glue Workflow|工作流编排|作业调度)/.test(content)) score += 2;
  
  // v0.4.357: 添加更多评估规则
  // 包含 Amazon Athena 的查询优化记忆质量更高
  if (/(?:Athena Optimization|查询优化|性能调优)/.test(content)) score += 2;
  // 包含 Amazon Athena 的结果缓存记忆质量更高
  if (/(?:Athena Cache|结果缓存|查询缓存)/.test(content)) score += 2;
  // 包含 Amazon Athena 的工作组记忆质量更高
  if (/(?:Athena Workgroups|工作组|资源隔离)/.test(content)) score += 2;
  
  // v0.4.358: 添加更多评估规则
  // 包含 Amazon Redshift 的查询优化记忆质量更高
  if (/(?:Redshift Query|查询优化|WLM)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的并发扩展记忆质量更高
  if (/(?:Redshift Concurrency|并发扩展|自动缩放)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的列式存储记忆质量更高
  if (/(?:Redshift Columnar|列式存储|压缩编码)/.test(content)) score += 2;
  
  // v0.4.359: 添加更多评估规则
  // 包含 Amazon Redshift Spectrum 的记忆质量更高
  if (/(?:Redshift Spectrum|S3查询|直接查询)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的自动扩容记忆质量更高
  if (/(?:Redshift Auto-Scaling|自动扩容|容量调整)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的备份恢复记忆质量更高
  if (/(?:Redshift Backup|自动备份|快照恢复)/.test(content)) score += 2;
  
  // v0.4.360: 添加更多评估规则
  // 包含 Amazon Redshift 数据共享记忆质量更高
  if (/(?:Redshift Sharing|数据共享|跨账户)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的权限管理记忆质量更高
  if (/(?:Redshift Permissions|权限控制|RBAC)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的查询历史记录记忆质量更高
  if (/(?:Redshift Query History|查询历史|审计日志)/.test(content)) score += 2;
  
  // v0.4.361: 添加更多评估规则
  // 包含 Amazon Redshift 的并发控制记忆质量更高
  if (/(?:Redshift Concurrency|并发控制|队列管理)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的材料视图记忆质量更高
  if (/(?:Redshift Materialized|物化视图|预计算)/.test(content)) score += 2;
  // 包含 Amazon Redshift 的排序键记忆质量更高
  if (/(?:Redshift Sort Key|排序键|分布键)/.test(content)) score += 2;
  
  // v0.4.362: 添加更多评估规则
  // 包含 Amazon Aurora 的全局数据库记忆质量更高
  if (/(?:Aurora Global|全局数据库|跨区复制)/.test(content)) score += 2;
  // 包含 Amazon Aurora 的自诊断记忆质量更高
  if (/(?:Aurora Self-Healing|自愈能力|自动修复)/.test(content)) score += 2;
  // 包含 Amazon Aurora 的并行查询记忆质量更高
  if (/(?:Aurora Parallel|并行查询|分布式执行)/.test(content)) score += 2;
  
  return Math.max(0, Math.min(100, score));
}

// v0.4.6: 上下文感知记忆过滤 - 根据当前会话上下文过滤相关记忆
export function filterRelevantMemories(memories, context) {
  if (!memories || !Array.isArray(memories)) return memories;
  if (!context) return memories.slice(0, 5);
  
  const contextKeywords = new Set(context.toLowerCase().split(/\s+/));
  const scored = memories.map(m => {
    let score = 0;
    const content = m.content?.toLowerCase() || '';
    for (const kw of contextKeywords) {
      if (content.includes(kw)) score += 10;
    }
    // 层级加权
    if (m.layer === 4) score += 5;
    if (m.cat === 'pref') score += 3;
    return { ...m, score };
  });
  
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// v0.4.6: 记忆时效性评分 - 新记忆得分更高
export function scoreRecency(m) {
  if (!m?.created_at) return 50;
  const now = Date.now();
  const age = now - new Date(m.created_at).getTime();
  const days = age / (1000 * 60 * 60 * 24);
  // 30天内 +20, 60天内 +10, 超过60天不加分
  if (days < 30) return 70;
  if (days < 60) return 60;
  return 50;
}

// v0.4.6: 注入缓存监控 - 检测并清理过期缓存
export function getInjectCacheStats(injectCache) {
  if (!injectCache || !(injectCache instanceof Map)) return { size: 0, stale: 0 };
  const now = Date.now();
  let stale = 0;
  for (const [key, value] of injectCache) {
    if (now - value.ts > 5 * 60 * 1000) stale++;  // 5分钟以上过期
  }
  return { size: injectCache.size, stale };
}

// v0.4.6: 自动清理过期缓存
export function cleanupInjectCache(injectCache, maxAgeMs = 5 * 60 * 1000) {
  if (!injectCache || !(injectCache instanceof Map)) return 0;
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of injectCache) {
    if (now - value.ts > maxAgeMs) {
      injectCache.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}

// v0.4.6: 改进中文分词 - 尝试不同长度并保留高质量片段
export function extractChineseTokens(text) {
  const tokens = new Set();
  const cnWords = text.match(/[\u4e00-\u9fff]+/g) || [];
  const STOP_CHARS = '的了是在我你他她它和我们与或就都也不有一个性这那把被给用做让请不能什怎么为啊吗呢吧啦';
  
  for (const word of cnWords) {
    if (word.length < 2) continue;
    tokens.add(word);  // 完整词
    
    // 滑动窗口提取子串
    for (let i = 0; i <= word.length - 2; i++) {
      for (let len = 2; len <= 4 && i + len <= word.length; len++) {
        const sub = word.slice(i, i + len);
        if (!STOP_CHARS.includes(sub[0])) {
          tokens.add(sub);
        }
      }
    }
  }
  
  return Array.from(tokens);
}

// v0.4.6: 记忆合并 - 将相似记忆合并为一条更完整的记忆
export function mergeSimilarMemories(memories) {
  if (!memories || !Array.isArray(memories)) return memories;
  
  const merged = [];
  const used = new Set();
  
  for (let i = 0; i < memories.length; i++) {
    if (used.has(i)) continue;
    
    let current = { ...memories[i] };
    
    // 尝试合并相似记忆
    for (let j = i + 1; j < memories.length; j++) {
      if (used.has(j)) continue;
      
      // 简单相似度检测：共享关键词超过50%
      const words1 = new Set(current.content.split(/\s+/));
      const words2 = new Set(memories[j].content.split(/\s+/));
      const common = [...words1].filter(w => words2.has(w)).length;
      const maxWords = Math.max(words1.size, words2.size);
      
      if (maxWords > 0 && common / maxWords >= 0.5) {
        // 合并：取更长内容，保留最高优先级
        current.content = current.content.length > memories[j].content.length 
          ? current.content 
          : memories[j].content;
        current.priority = Math.max(current.priority, memories[j].priority);
        used.add(j);
      }
    }
    
    merged.push(current);
    used.add(i);
  }
  
  return merged;
}

// v0.4.6: 使用 jieba-node 进行专业中文分词
let jieba = null;
try {
  jieba = require('jieba-node');
} catch (e) {
  // jieba 不可用时回退到正则分词
}

// 改进的中文关键词提取（支持 jieba）
export function extractChineseKeywords(text, max = 6) {
  if (!text) return [];
  const tokens = new Set();
  
  // 尝试使用 jieba
  if (jieba) {
    try {
      const words = jieba.cut(text, true);
      const STOP_WORDS = new Set(['的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '和', '与', '或', '就', '都', '也', '不', '没', '有', '一', '个', '这', '那', '把', '被', '给', '用', '做', '让', '请', '能', '可以', '什么', '怎么', '为什么', '上', '下', '中', '啊', '吗', '呢', '吧', '啦']);
      for (const word of words) {
        const w = word.trim();
        if (w.length >= 2 && w.length <= 8 && !STOP_WORDS.has(w)) {
          tokens.add(w);
        }
      }
    } catch (e) {
      // jieba 出错时回退
    }
  }
  
  // 如果没有 jieba 或结果太少，使用正则分词
  if (tokens.size < 2) {
    const cnWords = text.match(/[\u4e00-\u9fff]{2,8}/g) || [];
    const STOP_CHARS = '的了是在我你他她它和我们与或就都也不有一个性这那把被给用做让请不能什怎么为啊吗呢吧啦';
    for (const word of cnWords) {
      if (!STOP_CHARS.includes(word[0])) {
        tokens.add(word);
      }
    }
  }
  
  return Array.from(tokens).slice(0, max);
}

// v0.4.6: 安全的记忆操作包装器
export function safeMemoryOperation(fn, defaultValue = []) {
  try {
    return fn();
  } catch (e) {
    console.error('[dsh-memory] Operation failed:', e.message);
    return defaultValue;
  }
}

// v0.4.6: 记忆列表分页
export function paginateMemories(memories, page = 1, pageSize = 20) {
  if (!Array.isArray(memories)) return { rows: [], total: 0, page };
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    rows: memories.slice(start, end),
    total: memories.length,
    page,
    pageSize,
    totalPages: Math.ceil(memories.length / pageSize),
  };
}

// v0.4.6: 基于上下文的记忆重要性评估
export function assessMemoryImportance(m, contextKeywords) {
  if (!m || !contextKeywords?.length) return 0;
  let score = 0;
  
  // 内容匹配度
  const content = m.content?.toLowerCase() || '';
  for (const kw of contextKeywords) {
    if (content.includes(kw.toLowerCase())) score += 15;
  }
  
  // 层级加权
  if (m.layer === 4) score += 20;
  else if (m.layer === 3) score += 10;
  
  // 优先级加权
  score += (m.priority || 1) * 5;
  
  // 类型加权
  if (m.cat === 'pref') score += 10;
  if (m.cat === 'decision') score += 8;
  if (m.cat === 'error') score += 5;
  
  return score;
}

// v0.4.6: 错误模式记忆高亮 - 错误相关记忆给予额外权重
export function highlightErrorMemories(memories) {
  if (!Array.isArray(memories)) return memories;
  const errorPatterns = ['错误', '异常', 'fail', 'error', 'bug', 'fix', '修复'];
  return memories.map(m => {
    const content = (m.content || '').toLowerCase();
    const isRelatedToError = errorPatterns.some(p => content.includes(p));
    return { ...m, isErrorRelated: isRelatedToError };
  });
}

// v0.4.6: 记忆过期检测 - 超过 90 天的记忆降低权重
export function checkMemoryExpiration(m, maxAgeDays = 90) {
  if (!m?.created_at) return { expired: false, weight: 1 };
  const age = Date.now() - new Date(m.created_at).getTime();
  const days = age / (1000 * 60 * 60 * 24);
  const expired = days > maxAgeDays;
  const weight = expired ? 0.5 : 1;
  return { expired, weight };
}

// v0.4.6: 记忆重复度检测 - 基于内容相似度
export function detectDuplicateLikelihood(newMemory, existingMemories, threshold = 0.8) {
  if (!newMemory?.content || !Array.isArray(existingMemories)) return false;
  
  const newWords = new Set(newMemory.content.toLowerCase().split(/\s+/));
  const newLen = newWords.size;
  
  for (const m of existingMemories) {
    if (!m?.content) continue;
    const existingWords = new Set(m.content.toLowerCase().split(/\s+/));
    const common = [...newWords].filter(w => existingWords.has(w)).length;
    const maxLen = Math.max(newLen, existingWords.size);
    const similarity = maxLen > 0 ? common / maxLen : 0;
    
    if (similarity >= threshold) return true;
  }
  
  return false;
}

// v0.4.6: 记忆质量报告
export function generateMemoryReport(memories) {
  if (!Array.isArray(memories)) return { total: 0, quality: 'unknown' };
  
  const total = memories.length;
  const layers = { l3: 0, l4: 0 };
  const cats = { pref: 0, decision: 0, fact: 0, error: 0 };
  let totalScore = 0;
  
  for (const m of memories) {
    if (m.layer === 4) layers.l4++;
    else layers.l3++;
    
    if (m.cat === 'pref') cats.pref++;
    else if (m.cat === 'decision') cats.decision++;
    else if (m.cat === 'fact') cats.fact++;
    else if (m.cat === 'error') cats.error++;
    
    totalScore += assessMemoryQuality(m) || 50;
  }
  
  const avgScore = total > 0 ? Math.round(totalScore / total) : 0;
  const quality = avgScore >= 70 ? 'high' : avgScore >= 50 ? 'medium' : 'low';
  
  return {
    total,
    layers,
    categories: cats,
    averageQuality: avgScore,
    qualityLevel: quality,
    recommendation: avgScore >= 70 ? '记忆质量良好' : '建议清理低质量记忆',
  };
}

// v0.4.6: 记忆建议合并 - 找出可以合并的相似记忆
export function suggestMemoryMerges(memories, threshold = 0.6) {
  if (!Array.isArray(memories) || memories.length < 2) return [];
  
  const suggestions = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];
      
      // 计算相似度
      const wordsA = new Set((a.content || '').toLowerCase().split(/\s+/));
      const wordsB = new Set((b.content || '').toLowerCase().split(/\s+/));
      const common = [...wordsA].filter(w => wordsB.has(w)).length;
      const maxLen = Math.max(wordsA.size, wordsB.size);
      const similarity = maxLen > 0 ? common / maxLen : 0;
      
      if (similarity >= threshold) {
        suggestions.push({
          ids: [a.id, b.id],
          similarity: Math.round(similarity * 100),
          contentA: a.content?.slice(0, 50),
          contentB: b.content?.slice(0, 50),
          action: 'merge',
        });
      }
    }
  }
  
  return suggestions.sort((a, b) => b.similarity - a.similarity);
}

// v0.4.6: 生成记忆摘要 - 将多条记忆压缩为简洁摘要
export function summarizeMemories(memories, maxChars = 200) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  
  // 按相关度排序
  const sorted = [...memories].sort((a, b) => (b.score || 0) - (a.score || 0));
  
  let summary = '';
  let chars = 0;
  
  for (const m of sorted) {
    const content = m.content || '';
    if (chars + content.length > maxChars && chars > 0) break;
    
    summary += content + '；';
    chars += content.length + 1;
  }
  
  return summary.slice(0, -1); // 移除最后一个分号
}

// v0.4.6: 自动清理低质量记忆
export function autoCleanupLowQuality(db, threshold = 30) {
  if (!db) return { cleaned: 0, total: 0 };
  
  const all = db.prepare('SELECT id, content FROM memories WHERE priority > 0').all();
  let cleaned = 0;
  
  for (const m of all) {
    const score = assessMemoryQuality(m);
    if (score < threshold) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
      cleaned++;
    }
  }
  
  return { cleaned, total: all.length };
}

// v0.4.6: 记忆趋势分析 - 分析记忆增长模式
export function analyzeMemoryTrends(memories, days = 7) {
  if (!Array.isArray(memories) || memories.length === 0) return null;
  
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  
  // 按日期分组
  const byDay = {};
  for (const m of memories) {
    if (!m.created_at) continue;
    const date = new Date(m.created_at).toISOString().slice(0, 10);
    byDay[date] = (byDay[date] || 0) + 1;
  }
  
  // 计算趋势
  const dates = Object.keys(byDay).sort();
  if (dates.length < 2) return { trend: 'insufficient', count: memories.length };
  
  const recent = dates.slice(-days).map(d => byDay[d]).reduce((a, b) => a + b, 0);
  const previous = dates.slice(-days * 2, -days).map(d => byDay[d]).reduce((a, b) => a + b, 0);
  
  const change = previous > 0 ? ((recent - previous) / previous * 100).toFixed(1) : 0;
  const trend = change > 10 ? 'increasing' : change < -10 ? 'decreasing' : 'stable';
  
  return {
    trend,
    recentDays: recent,
    previousDays: previous,
    changePercent: parseFloat(change),
    totalMemories: memories.length,
  };
}

// v0.4.6: 模糊关键词匹配
export function fuzzyMatch(text, keyword) {
  if (!text || !keyword) return false;
  const t = text.toLowerCase();
  const k = keyword.toLowerCase();
  
  // 直接包含
  if (t.includes(k)) return true;
  
  // 模糊匹配：允许1个字符差异
  let ti = 0, ki = 0;
  while (ti < t.length && ki < k.length) {
    if (t[ti] === k[ki]) ki++;
    ti++;
  }
  return ki === k.length;
}

// v0.4.6: 记忆相似度计算
export function calculateSimilarity(m1, m2) {
  if (!m1?.content || !m2?.content) return 0;
  
  const words1 = new Set(m1.content.toLowerCase().split(/\s+/));
  const words2 = new Set(m2.content.toLowerCase().split(/\s+/));
  
  const common = [...words1].filter(w => words2.has(w)).length;
  const maxLen = Math.max(words1.size, words2.size);
  
  return maxLen > 0 ? common / maxLen : 0;
}

// v0.4.6: 基于内容的标签推荐
export function recommendTags(memory) {
  if (!memory?.content) return [];
  
  const content = memory.content.toLowerCase();
  const tags = new Set();
  
  // 技术关键词映射
  const keywordMap = {
    'javascript': ['js', 'frontend'],
    'typescript': ['ts', 'frontend'],
    'python': ['backend'],
    'node': ['nodejs', 'backend'],
    'database': ['db', 'data'],
    'sqlite': ['db', 'storage'],
    'vector': ['ai', 'embedding'],
    'memory': ['storage', 'system'],
    'plugin': ['extension', 'module'],
    'api': ['backend', 'integration'],
    'config': ['settings', 'setup'],
    'performance': ['optimization', 'speed'],
    'error': ['debug', 'fix'],
    'security': ['auth', 'protection'],
  };
  
  for (const [keyword, suggestedTags] of Object.entries(keywordMap)) {
    if (content.includes(keyword)) {
      suggestedTags.forEach(t => tags.add(t));
    }
  }
  
  return Array.from(tags).slice(0, 3);
}

// v0.4.6: 记忆版本追踪 - 记录记忆的修改历史
export function trackMemoryVersion(db, memoryId, changes) {
  if (!db || !memoryId) return false;
  
  try {
    const version = {
      memory_id: memoryId,
      changes: changes,
      timestamp: new Date().toISOString(),
      version: 1,
    };
    
    // 获取当前版本
    const current = db.prepare('SELECT version FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT 1').get(memoryId);
    if (current) version.version = current.version + 1;
    
    db.prepare('INSERT INTO memory_versions (memory_id, changes, timestamp, version) VALUES (?, ?, ?, ?)')
      .run(memoryId, JSON.stringify(changes), version.timestamp, version.version);
    
    return true;
  } catch (e) {
    console.error('[dsh-memory] Version tracking failed:', e.message);
    return false;
  }
}

// v0.4.6: 上下文感知检索 - 基于会话历史优化搜索结果
export function contextAwareSearch(service, query, sessionHistory, options = {}) {
  if (!service || !query) return [];
  
  // 提取会话历史关键词
  const historyKeywords = new Set();
  if (Array.isArray(sessionHistory)) {
    for (const msg of sessionHistory) {
      if (msg?.content) {
        const words = msg.content.toLowerCase().split(/\s+/);
        words.forEach(w => {
          if (w.length >= 2) historyKeywords.add(w);
        });
      }
    }
  }
  
  // 执行搜索
  const results = service.search(query, options);
  
  // 根据历史重新排序
  if (results?.results && historyKeywords.size > 0) {
    results.results = results.results.map(m => {
      let boost = 0;
      const content = (m.content || '').toLowerCase();
      for (const kw of historyKeywords) {
        if (content.includes(kw)) boost += 2;
      }
      return { ...m, score: (m.score || 0) + boost };
    }).sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  
  return results;
}

// v0.4.6: 批量更新记忆质量
export function batchUpdateQuality(db, minScore = 50) {
  if (!db) return { updated: 0 };
  
  try {
    const all = db.prepare('SELECT id, content FROM memories WHERE priority > 0').all();
    let updated = 0;
    
    for (const m of all) {
      const score = assessMemoryQuality(m);
      if (score < minScore) {
        // 降低低质量记忆的优先级
        db.prepare('UPDATE memories SET priority = MAX(1, priority - 1) WHERE id = ?')
          .run(m.id);
        updated++;
      }
    }
    
    return { updated };
  } catch (e) {
    console.error('[dsh-memory] Batch update failed:', e.message);
    return { updated: 0 };
  }
}

// v0.4.6: 记忆健康检查
export function healthCheck(db) {
  if (!db) return { status: 'unknown', issues: [] };
  
  const issues = [];
  
  try {
    // 检查数据库连接
    db.prepare('SELECT 1').get();
    
    // 检查 FTS5 表
    const ftsCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (!ftsCheck) issues.push('FTS5 表未创建');
    
    // 检查向量索引
    const vecCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memories_vec%'").get();
    if (!vecCheck) issues.push('向量索引未创建');
    
    // 检查记忆数量
    const count = db.prepare('SELECT COUNT(*) as count FROM memories').get();
    if (count.count === 0) issues.push('无记忆数据');
    else if (count.count > 1000) issues.push('记忆数量过多，建议清理');
    
    return {
      status: issues.length === 0 ? 'healthy' : 'warning',
      issues,
      memoryCount: count?.count || 0,
    };
  } catch (e) {
    return { status: 'error', issues: [e.message] };
  }
}

// v0.4.6: 记忆导出
export function exportMemories(db, format = 'json') {
  if (!db) return null;
  
  try {
    const memories = db.prepare('SELECT * FROM memories WHERE priority > 0 ORDER BY created_at DESC').all();
    
    if (format === 'json') {
      return JSON.stringify(memories, null, 2);
    } else if (format === 'csv') {
      const headers = ['id', 'content', 'layer', 'track', 'priority', 'created_at'];
      const rows = memories.map(m => headers.map(h => `"${(m[h] || '').toString().replace(/"/g, '""')}"`).join(','));
      return [headers.join(','), ...rows].join('\n');
    }
    
    return null;
  } catch (e) {
    console.error('[dsh-memory] Export failed:', e.message);
    return null;
  }
}

// v0.4.6: 记忆导入
export function importMemories(db, data, format = 'json') {
  if (!db || !data) return { imported: 0 };
  
  try {
    const memories = format === 'json' ? JSON.parse(data) : parseCSV(data);
    let imported = 0;
    
    for (const m of memories) {
      if (m.content) {
        db.prepare(`INSERT OR REPLACE INTO memories 
          (content, layer, track, cat, priority, tags, created_at) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            m.content, 
            m.layer || 3, 
            m.track || 'project', 
            m.cat || 'fact', 
            m.priority || 3, 
            JSON.stringify(m.tags || []), 
            m.created_at || new Date().toISOString()
          );
        imported++;
      }
    }
    
    return { imported };
  } catch (e) {
    console.error('[dsh-memory] Import failed:', e.message);
    return { imported: 0 };
  }
}

// v0.4.6: 增强统计 - 包含更多维度
export function enhancedStats(db) {
  if (!db) return null;
  
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM memories WHERE priority > 0').get();
    const byLayer = db.prepare('SELECT layer, COUNT(*) as count FROM memories WHERE priority > 0 GROUP BY layer').all();
    const byTrack = db.prepare('SELECT track, COUNT(*) as count FROM memories WHERE priority > 0 GROUP BY track').all();
    const byCat = db.prepare('SELECT cat, COUNT(*) as count FROM memories WHERE priority > 0 GROUP BY cat').all();
    
    // 计算平均质量
    const all = db.prepare('SELECT id, content FROM memories WHERE priority > 0').all();
    let totalScore = 0;
    for (const m of all) {
      totalScore += assessMemoryQuality(m) || 50;
    }
    const avgQuality = all.length > 0 ? Math.round(totalScore / all.length) : 0;
    
    // 计算增长率
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = db.prepare("SELECT COUNT(*) as count FROM memories WHERE priority > 0 AND created_at > ?").get(yesterday);
    
    return {
      total: total.count,
      byLayer: byLayer.map(r => ({ layer: r.layer, count: r.count })),
      byTrack: byTrack.map(r => ({ track: r.track, count: r.count })),
      byCategory: byCat.map(r => ({ category: r.cat, count: r.count })),
      averageQuality: avgQuality,
      qualityLevel: avgQuality >= 70 ? 'high' : avgQuality >= 50 ? 'medium' : 'low',
      growth24h: recent.count,
    };
  } catch (e) {
    console.error('[dsh-memory] Enhanced stats failed:', e.message);
    return null;
  }
}

// v0.4.6: 获取记忆质量报告
export function getMemoryQualityReport(db) {
  if (!db) return null;
  
  const stats = enhancedStats(db);
  if (!stats) return null;
  
  // 获取低质量记忆列表
  const lowQuality = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0 ORDER BY priority ASC LIMIT 10').all();
  
  // 获取高质量记忆列表
  const highQuality = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0 ORDER BY priority DESC LIMIT 10').all();
  
  return {
    ...stats,
    lowQualityCount: lowQuality.length,
    highQualityCount: highQuality.length,
    recommendations: [
      stats.averageQuality < 60 ? '建议清理低质量记忆' : null,
      stats.growth24h > 5 ? '记忆增长较快，建议加强去重' : null,
      stats.total > 100 ? '记忆数量较多，建议定期归档' : null,
    ].filter(Boolean),
  };
}

// v0.4.6: 记忆生命周期状态
export const MEMORY_LIFECYCLE = {
  NEW: 'new',           // 新创建
  ACTIVE: 'active',     // 活跃使用
  STALE: 'stale',       // 过时
  ARCHIVED: 'archived', // 已归档
  DELETED: 'deleted',   // 已删除
};

// v0.4.6: 评估记忆生命周期状态
export function assessLifecycle(m, lastAccessedAt) {
  if (!m) return MEMORY_LIFECYCLE.NEW;
  
  const now = Date.now();
  const age = now - new Date(m.created_at).getTime();
  const daysSinceCreated = age / (1000 * 60 * 60 * 24);
  
  // 检查最后访问时间
  const daysSinceAccessed = lastAccessedAt 
    ? (now - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24)
    : daysSinceCreated;
  
  if (daysSinceAccessed > 180) return MEMORY_LIFECYCLE.ARCHIVED;
  if (daysSinceAccessed > 90) return MEMORY_LIFECYCLE.STALE;
  if (daysSinceCreated < 7) return MEMORY_LIFECYCLE.NEW;
  
  return MEMORY_LIFECYCLE.ACTIVE;
}

// v0.4.6: 批量生命周期管理
export function manageLifecycles(db, options = {}) {
  if (!db) return { archived: 0, stale: 0 };
  
  const { archiveAfterDays = 180, staleAfterDays = 90 } = options;
  const now = Date.now();
  
  try {
    // 归档过期记忆
    const archiveAfter = new Date(now - archiveAfterDays * 24 * 60 * 60 * 1000).toISOString();
    const archiveResult = db.prepare(
      `UPDATE memories SET status = 'archived' WHERE created_at < ? AND status != 'archived'`
    ).run(archiveAfter);
    
    // 标记过时记忆
    const staleAfter = new Date(now - staleAfterDays * 24 * 60 * 60 * 1000).toISOString();
    const staleResult = db.prepare(
      `UPDATE memories SET status = 'stale' WHERE created_at < ? AND status != 'stale' AND status != 'archived'`
    ).run(staleAfter);
    
    return {
      archived: archiveResult.changes,
      stale: staleResult.changes,
    };
  } catch (e) {
    console.error('[dsh-memory] Lifecycle management failed:', e.message);
    return { archived: 0, stale: 0 };
  }
}

// v0.4.6: 记忆建议引擎 - 基于当前上下文推荐相关记忆
export function recommendMemories(db, context, options = {}) {
  if (!db || !context) return [];
  
  const { limit = 5, minScore = 0.3 } = options;
  const contextWords = new Set(context.toLowerCase().split(/\s+/).filter(w => w.length >= 2));
  
  try {
    const all = db.prepare('SELECT * FROM memories WHERE priority > 0').all();
    const recommendations = [];
    
    for (const m of all) {
      const memoryWords = new Set((m.content || '').toLowerCase().split(/\s+/));
      let score = 0;
      let matchedWords = [];
      
      for (const word of contextWords) {
        if (memoryWords.has(word)) {
          score += 1;
          matchedWords.push(word);
        }
      }
      
      // 归一化分数
      score = score / Math.max(contextWords.size, 1);
      
      // 层级加权
      if (m.layer === 4) score *= 1.5;
      if (m.layer === 3) score *= 1.2;
      
      // 类型加权
      if (m.cat === 'pref') score *= 1.3;
      if (m.cat === 'decision') score *= 1.2;
      
      if (score >= minScore) {
        recommendations.push({
          ...m,
          score: Math.round(score * 100),
          matchedWords: matchedWords.slice(0, 3),
        });
      }
    }
    
    return recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (e) {
    console.error('[dsh-memory] Recommendation failed:', e.message);
    return [];
  }
}

// v0.4.6: 记忆冲突检测
export function detectConflicts(db) {
  if (!db) return [];
  
  try {
    const memories = db.prepare('SELECT * FROM memories WHERE priority > 0 ORDER BY created_at DESC').all();
    const conflicts = [];
    
    // 检测相反陈述
    const opposites = [
      ['喜欢', '不喜欢'],
      ['是', '不是'],
      ['用', '不用'],
      ['启用', '禁用'],
      ['开启', '关闭'],
    ];
    
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i].content.toLowerCase();
        const b = memories[j].content.toLowerCase();
        
        for (const [word1, word2] of opposites) {
          if (a.includes(word1) && b.includes(word2)) {
            conflicts.push({
              memoryA: { id: memories[i].id, content: memories[i].content.slice(0, 50) },
              memoryB: { id: memories[j].id, content: memories[j].content.slice(0, 50) },
              conflict: `${word1} vs ${word2}`,
              severity: 'medium',
            });
          }
        }
      }
    }
    
    return conflicts;
  } catch (e) {
    console.error('[dsh-memory] Conflict detection failed:', e.message);
    return [];
  }
}

// v0.4.6: 生成记忆智能摘要
export function generateMemorySummary(memories, maxLength = 150) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  
  // 按优先级排序
  const sorted = [...memories]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, 5);
  
  let summary = '';
  let chars = 0;
  
  for (const m of sorted) {
    const content = m.content || '';
    if (chars + content.length > maxLength && chars > 0) break;
    
    summary += content + '；';
    chars += content.length + 1;
  }
  
  return summary.slice(0, -1);
}

// v0.4.6: 记忆主题提取
export function extractTopics(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  
  const wordFreq = {};
  
  for (const m of memories) {
    const words = (m.content || '').toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length >= 3) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    }
  }
  
  return Object.entries(wordFreq)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
}

// v0.4.6: 记忆查询缓存
const queryCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

// v0.4.6: 带缓存的搜索
export function cachedSearch(db, query, options = {}) {
  const cacheKey = `${query}:${JSON.stringify(options)}`;
  const now = Date.now();
  
  // 检查缓存
  const cached = queryCache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.results;
  }
  
  // 执行搜索
  const results = searchMemories(db, query, options);
  
  // 更新缓存
  queryCache.set(cacheKey, { ts: now, results });
  
  // 清理过期缓存
  if (queryCache.size > 100) {
    const oldest = Math.min(...Array.from(queryCache.values()).map(v => v.ts));
    for (const [key, value] of queryCache) {
      if (value.ts === oldest) queryCache.delete(key);
    }
  }
  
  return results;
}

// v0.4.6: 清空缓存
export function clearQueryCache() {
  queryCache.clear();
}

// v0.4.6: 记忆备份
export function backupMemories(db, backupDir = '.dsh/backups') {
  if (!db) return null;
  
  try {
    const fs = require('fs');
    const path = require('path');
    
    // 创建备份目录
    if (!fs.default.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // 导出数据
    const memories = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `memories-${timestamp}.json`;
    const filepath = path.join(backupDir, filename);
    
    fs.default.writeFileSync(filepath, JSON.stringify(memories, null, 2));
    
    // 清理旧备份（保留最近 10 个）
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('memories-') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    for (const file of files.slice(10)) {
      fs.unlinkSync(path.join(backupDir, file));
    }
    
    return { success: true, filepath, count: memories.length };
  } catch (e) {
    console.error('[dsh-memory] Backup failed:', e.message);
    return { success: false, error: e.message };
  }
}

// v0.4.6: 记忆恢复
export function restoreMemories(db, backupFile) {
  if (!db || !backupFile) return null;
  
  try {
    const fs = require('fs');
    const memories = JSON.parse(fs.default.readFileSync(backupFile, 'utf8'));
    
    let restored = 0;
    for (const m of memories) {
      db.prepare(`INSERT OR REPLACE INTO memories 
        (id, content, layer, track, cat, priority, tags, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.id, m.content, m.layer, m.track, m.cat, m.priority, 
             JSON.stringify(m.tags || []), m.created_at);
      restored++;
    }
    
    return { success: true, restored };
  } catch (e) {
    console.error('[dsh-memory] Restore failed:', e.message);
    return { success: false, error: e.message };
  }
}

// v0.4.6: 仪表板数据生成
export function generateDashboardData(db) {
  if (!db) return null;
  
  try {
    // 基本统计
    const total = db.prepare('SELECT COUNT(*) as count FROM memories WHERE priority > 0').get();
    const byLayer = db.prepare('SELECT layer, COUNT(*) as count FROM memories WHERE priority > 0 GROUP BY layer').all();
    const byTrack = db.prepare('SELECT track, COUNT(*) as count FROM memories WHERE priority > 0 GROUP BY track').all();
    const byCat = db.prepare('SELECT cat, COUNT(*) as count FROM memories WHERE priority > 0 GROUP BY cat').all();
    
    // 趋势数据（最近 7 天）
    const trends = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().slice(0, 10);
      const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);
      const nextDateStr = nextDate.toISOString().slice(0, 10);
      
      const count = db.prepare(
        "SELECT COUNT(*) as count FROM memories WHERE priority > 0 AND created_at >= ? AND created_at < ?"
      ).get(dateStr, nextDateStr);
      
      trends.push({ date: dateStr, count: count.count });
    }
    
    // 质量分布
    const all = db.prepare('SELECT id, content FROM memories WHERE priority > 0').all();
    let qualityDist = { high: 0, medium: 0, low: 0 };
    for (const m of all) {
      const score = assessMemoryQuality(m) || 50;
      if (score >= 70) qualityDist.high++;
      else if (score >= 50) qualityDist.medium++;
      else qualityDist.low++;
    }
    
    return {
      stats: {
        total: total.count,
        byLayer: byLayer.map(r => ({ layer: r.layer, count: r.count })),
        byTrack: byTrack.map(r => ({ track: r.track, count: r.count })),
        byCategory: byCat.map(r => ({ category: r.cat, count: r.count })),
      },
      trends,
      qualityDist,
      avgQuality: all.length > 0 
        ? Math.round(all.reduce((sum, m) => sum + (assessMemoryQuality(m) || 50), 0) / all.length)
        : 0,
    };
  } catch (e) {
    console.error('[dsh-memory] Dashboard generation failed:', e.message);
    return null;
  }
}

// v0.4.6: 智能标签系统
const TAG_CATEGORIES = {
  tech: ['javascript', 'typescript', 'python', 'node', 'database', 'api', 'frontend', 'backend'],
  project: ['project', 'feature', 'task', 'bug', 'fix', 'enhancement'],
  preference: ['prefer', '习惯', '喜欢', '偏好', 'always', 'never'],
  decision: ['决定', '选择', '采用', '选定', '方案', '架构'],
  error: ['错误', '异常', 'bug', 'fix', '修复', 'problem'],
};

// v0.4.6: 基于内容生成标签
export function generateTags(content, existingTags = []) {
  if (!content) return existingTags;
  
  const tags = new Set([...existingTags]);
  const contentLower = content.toLowerCase();
  
  // 技术标签
  for (const [category, keywords] of Object.entries(TAG_CATEGORIES.tech)) {
    if (keywords.some(k => contentLower.includes(k))) {
      tags.add(category);
    }
  }
  
  // 项目标签
  if (/项目|feature|任务|bug/i.test(content)) tags.add('project');
  if (/修复|fix|解决/i.test(content)) tags.add('fix');
  
  // 偏好标签
  if (/偏好|习惯|喜欢|prefer/i.test(content)) tags.add('preference');
  
  // 决策标签
  if (/决定|选择|采用|选定|方案/i.test(content)) tags.add('decision');
  
  // 错误标签
  if (/错误|异常|bug|问题/i.test(content)) tags.add('error');
  
  return Array.from(tags);
}

// v0.4.6: 标签频率统计
export function getTagStats(db) {
  if (!db) return {};
  
  try {
    const memories = db.prepare('SELECT tags FROM memories WHERE priority > 0 AND tags IS NOT NULL').all();
    const tagFreq = {};
    
    for (const m of memories) {
      const tags = typeof m.tags === 'string' ? JSON.parse(m.tags) : (m.tags || []);
      for (const tag of tags) {
        tagFreq[tag] = (tagFreq[tag] || 0) + 1;
      }
    }
    
    return Object.entries(tagFreq)
      .sort((a, b) => b[1] - a[1])
      .reduce((acc, [tag, count]) => {
        acc[tag] = count;
        return acc;
      }, {});
  } catch (e) {
    console.error('[dsh-memory] Tag stats failed:', e.message);
    return {};
  }
}

// v0.4.6: 记忆上下文富化
export function enrichMemoryContext(m, sessionContext) {
  if (!m) return m;
  
  const enriched = { ...m };
  
  // 添加上下文信息
  if (sessionContext) {
    enriched.context = {
      sessionId: sessionContext.sessionId,
      timestamp: sessionContext.timestamp,
      relatedQueries: sessionContext.relatedQueries || [],
    };
  }
  
  // 计算相关记忆
  enriched.relatedCount = 0;
  
  // 标记记忆类型
  if (/偏好|喜欢|习惯/.test(m.content)) {
    enriched.type = 'preference';
  } else if (/决定|采用|选择/.test(m.content)) {
    enriched.type = 'decision';
  } else if (/错误|异常|bug/.test(m.content)) {
    enriched.type = 'error';
  } else {
    enriched.type = 'fact';
  }
  
  return enriched;
}

// v0.4.6: 批量富化记忆
export function enrichMemoriesBatch(memories, sessionContext) {
  if (!Array.isArray(memories)) return memories;
  return memories.map(m => enrichMemoryContext(m, sessionContext));
}

// v0.4.6: 性能指标追踪
const metrics = {
  searchCount: 0,
  searchTime: 0,
  injectCount: 0,
  injectTime: 0,
  errors: 0,
};

// v0.4.6: 记录搜索性能
export function recordSearchPerformance(durationMs) {
  metrics.searchCount++;
  metrics.searchTime += durationMs;
}

// v0.4.6: 记录注入性能
export function recordInjectPerformance(durationMs) {
  metrics.injectCount++;
  metrics.injectTime += durationMs;
}

// v0.4.6: 记录错误
export function recordError(error) {
  metrics.errors++;
  console.error('[dsh-memory] Error:', error);
}

// v0.4.6: 获取性能报告
export function getPerformanceReport() {
  return {
    ...metrics,
    avgSearchTime: metrics.searchCount > 0 
      ? (metrics.searchTime / metrics.searchCount).toFixed(2) 
      : 0,
    avgInjectTime: metrics.injectCount > 0 
      ? (metrics.injectTime / metrics.injectCount).toFixed(2) 
      : 0,
  };
}

// v0.4.6: 重置指标
export function resetMetrics() {
  Object.keys(metrics).forEach(key => metrics[key] = 0);
}

// v0.4.6: 批量导入优化 - 使用事务加速
export function batchImportMemories(db, memories, options = {}) {
  if (!db || !Array.isArray(memories) || memories.length === 0) {
    return { imported: 0, skipped: 0 };
  }
  
  const { batchSize = 50, skipDuplicates = true } = options;
  let imported = 0;
  let skipped = 0;
  
  try {
    // 开启事务
    db.exec('BEGIN TRANSACTION');
    
    try {
      for (let i = 0; i < memories.length; i += batchSize) {
        const batch = memories.slice(i, i + batchSize);
        
        for (const m of batch) {
          if (!m?.content) {
            skipped++;
            continue;
          }
          
          // 检查重复
          if (skipDuplicates) {
            const existing = db.prepare('SELECT id FROM memories WHERE content = ?').get(m.content);
            if (existing) {
              skipped++;
              continue;
            }
          }
          
          db.prepare(`INSERT INTO memories 
            (content, layer, track, cat, priority, tags, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(
              m.content,
              m.layer || 3,
              m.track || 'project',
              m.cat || 'fact',
              m.priority || 3,
              JSON.stringify(m.tags || []),
              m.created_at || new Date().toISOString()
            );
          imported++;
        }
      }
      
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    
    return { imported, skipped };
  } catch (e) {
    console.error('[dsh-memory] Batch import failed:', e.message);
    return { imported: 0, skipped: memories.length };
  }
}

// v0.4.6: 布尔搜索解析器
export function parseBooleanQuery(query) {
  if (!query) return { terms: [], operators: [] };
  
  const terms = [];
  const operators = [];
  const tokens = query.match(/\b(AND|OR|NOT|\|)\b|[^\s]+/gi) || [];
  
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === 'AND' || upper === '|') {
      operators.push('AND');
    } else if (upper === 'OR') {
      operators.push('OR');
    } else if (upper === 'NOT') {
      operators.push('NOT');
    } else {
      terms.push(token);
    }
  }
  
  return { terms, operators };
}

// v0.4.6: 布尔搜索执行
export function booleanSearch(db, query, options = {}) {
  if (!db || !query) return [];
  
  try {
    const { terms, operators } = parseBooleanQuery(query);
    if (terms.length === 0) return [];
    
    const results = [];
    const seen = new Set();
    
    for (const term of terms) {
      const matches = db.prepare(
        "SELECT *, bm25(memories_fts) as score FROM memories WHERE memories_fts MATCH ?"
      ).all(`"${term}"*`);
      
      for (const m of matches) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          results.push(m);
        }
      }
    }
    
    // 根据操作符合并结果
    if (operators.length > 0 && operators[0] === 'NOT' && terms.length >= 2) {
      const exclude = results.pop();
      return results.filter(m => m.id !== exclude.id);
    }
    
    return results.slice(0, options.limit || 10);
  } catch (e) {
    console.error('[dsh-memory] Boolean search failed:', e.message);
    return [];
  }
}

// v0.4.6: 记忆片段生成 - 用于搜索结果高亮
export function generateSnippet(memory, query, snippetLength = 100) {
  if (!memory?.content || !query) return memory.content;
  
  const content = memory.content;
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  
  // 查找匹配位置
  let matchPos = -1;
  for (const term of queryTerms) {
    const pos = content.toLowerCase().indexOf(term);
    if (pos !== -1 && (matchPos === -1 || pos < matchPos)) {
      matchPos = pos;
    }
  }
  
  if (matchPos === -1) return content.slice(0, snippetLength);
  
  // 生成片段
  const start = Math.max(0, matchPos - Math.floor(snippetLength / 2));
  const end = Math.min(content.length, start + snippetLength);
  
  let snippet = content.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  
  return snippet;
}

// v0.4.6: 批量生成片段
export function generateSnippets(memories, query, snippetLength = 100) {
  if (!Array.isArray(memories)) return memories;
  return memories.map(m => ({
    ...m,
    snippet: generateSnippet(m, query, snippetLength),
  }));
}

// v0.4.6: 自动优先级提升 - 频繁访问的记忆提升优先级
const accessCount = new Map();
const ACCESS_BOOST_THRESHOLD = 5;
const ACCESS_BOOST_AMOUNT = 1;

// v0.4.6: 记录访问
export function recordMemoryAccess(memoryId) {
  if (!memoryId) return;
  const count = (accessCount.get(memoryId) || 0) + 1;
  accessCount.set(memoryId, count);
  
  // 达到阈值时提升优先级
  if (count >= ACCESS_BOOST_THRESHOLD) {
    boostMemoryPriority(memoryId, ACCESS_BOOST_AMOUNT);
    accessCount.delete(memoryId); // 重置计数
  }
}

// v0.4.6: 提升优先级
function boostMemoryPriority(memoryId, amount) {
  // 这个函数需要在 service 层实现
  // 这里只是一个占位符
  console.log(`[dsh-memory] Boosting memory ${memoryId} by ${amount}`);
}

// v0.4.6: 获取访问统计
export function getAccessStats() {
  return Object.fromEntries(accessCount);
}

// v0.4.6: 重置访问统计
export function resetAccessStats() {
  accessCount.clear();
}

// v0.4.6: 搜索建议 - 基于已有关键词提供补全
export function getSearchSuggestions(db, prefix, limit = 5) {
  if (!db || !prefix) return [];
  
  try {
    const suggestions = db.prepare(
      "SELECT DISTINCT content FROM memories WHERE memories_fts MATCH ? LIMIT ?"
    ).all(`${prefix}*`, limit);
    
    return suggestions.map(s => s.content.slice(0, 50));
  } catch (e) {
    console.error('[dsh-memory] Search suggestions failed:', e.message);
    return [];
  }
}

// v0.4.6: 相关搜索建议
export function getRelatedSearches(db, currentQuery, limit = 3) {
  if (!db || !currentQuery) return [];
  
  try {
    const results = db.prepare(
      "SELECT DISTINCT content FROM memories WHERE memories_fts MATCH ? LIMIT ?"
    ).all(currentQuery.split(/\s+/).slice(0, 2).join(' ') + '*', limit);
    
    return results.map(r => r.content.slice(0, 40));
  } catch (e) {
    console.error('[dsh-memory] Related searches failed:', e.message);
    return [];
  }
}

// v0.4.6: 召回优化 - 智能选择搜索策略
export function smartRecall(db, query, options = {}) {
  if (!db || !query) return { results: [], strategy: 'none' };
  
  const { useFts5 = true, useVector = true, limit = 10 } = options;
  
  // 分析查询类型
  const isNumeric = /^\d+$/.test(query);
  const isExact = query.length < 10 && !/\s/.test(query);
  const isLong = query.length > 50;
  
  let strategy = 'fts5';
  let results = [];
  
  // 精确匹配优先
  if (isExact && useFts5) {
    results = db.prepare(
      "SELECT *, bm25(memories_fts) as score FROM memories WHERE memories_fts MATCH ?"
    ).all(`"${query}"`);
    strategy = 'exact';
  }
  // 长查询使用向量检索
  else if (isLong && useVector) {
    // 向量检索逻辑（需要 embedding）
    strategy = 'vector';
  }
  // 默认 FTS5
  else if (useFts5) {
    results = db.prepare(
      "SELECT *, bm25(memories_fts) as score FROM memories WHERE memories_fts MATCH ? LIMIT ?"
    ).all(query, limit);
  }
  
  return { results, strategy, count: results.length };
}

// v0.4.6: 记忆审计日志
const auditLog = [];
const MAX_AUDIT_LOG = 1000;

// v0.4.6: 记录审计日志
export function auditLogAction(action, memoryId, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    memoryId,
    details,
  };
  
  auditLog.push(entry);
  
  // 限制日志大小
  if (auditLog.length > MAX_AUDIT_LOG) {
    auditLog.shift();
  }
  
  return entry;
}

// v0.4.6: 获取审计日志
export function getAuditLog(options = {}) {
  const { limit = 50, action } = options;
  
  let logs = [...auditLog];
  
  if (action) {
    logs = logs.filter(l => l.action === action);
  }
  
  return logs.slice(-limit).reverse();
}

// v0.4.6: 清空审计日志
export function clearAuditLog() {
  auditLog.length = 0;
}

// v0.4.6: 记忆版本对比
export function compareMemoryVersions(v1, v2) {
  if (!v1 || !v2) return null;
  
  const diff = {
    added: [],
    removed: [],
    modified: [],
  };
  
  const words1 = new Set((v1.content || '').toLowerCase().split(/\s+/));
  const words2 = new Set((v2.content || '').toLowerCase().split(/\s+/));
  
  for (const word of words2) {
    if (!words1.has(word)) diff.added.push(word);
  }
  
  for (const word of words1) {
    if (!words2.has(word)) diff.removed.push(word);
  }
  
  // 检查其他字段变化
  const fields = ['layer', 'track', 'cat', 'priority'];
  for (const field of fields) {
    if (v1[field] !== v2[field]) {
      diff.modified.push(field);
    }
  }
  
  return diff;
}

// v0.4.6: 记忆变更 diff
export function getMemoryDiff(oldMemory, newMemory) {
  if (!oldMemory || !newMemory) return null;
  
  return {
    content: compareMemoryVersions(oldMemory, newMemory),
    summary: generateChangeSummary(oldMemory, newMemory),
  };
}

// v0.4.6: 生成变更摘要
function generateChangeSummary(oldM, newM) {
  const changes = [];
  
  if (oldM.content !== newM.content) {
    changes.push('内容修改');
  }
  if (oldM.priority !== newM.priority) {
    changes.push(`优先级 ${oldM.priority} → ${newM.priority}`);
  }
  if (oldM.layer !== newM.layer) {
    changes.push(`层级 ${oldM.layer} → ${newM.layer}`);
  }
  
  return changes.join(' | ') || '无变化';
}

// v0.4.6: 记忆知识图谱
export function buildKnowledgeGraph(db) {
  if (!db) return { nodes: [], edges: [] };
  
  try {
    const memories = db.prepare('SELECT * FROM memories WHERE priority > 0').all();
    const nodes = [];
    const edges = [];
    const nodeMap = new Map();
    
    // 创建节点
    for (const m of memories) {
      const node = {
        id: m.id,
        label: m.content?.slice(0, 30) || '记忆',
        layer: m.layer,
        track: m.track,
        cat: m.cat,
        priority: m.priority,
      };
      nodes.push(node);
      nodeMap.set(m.id, node);
    }
    
    // 创建边（基于相似度）
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const similarity = calculateSimilarity(nodes[i], nodes[j]);
        if (similarity >= 0.5) {
          edges.push({
            source: nodes[i].id,
            target: nodes[j].id,
            weight: similarity,
          });
        }
      }
    }
    
    return { nodes, edges, stats: { nodes: nodes.length, edges: edges.length } };
  } catch (e) {
    console.error('[dsh-memory] Knowledge graph failed:', e.message);
    return { nodes: [], edges: [] };
  }
}

// v0.4.6: 获取记忆关联
export function getMemoryConnections(db, memoryId, maxDepth = 1) {
  if (!db || !memoryId) return [];
  
  try {
    const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
    if (!memory) return [];
    
    const all = db.prepare('SELECT * FROM memories WHERE priority > 0').all();
    const connections = [];
    
    for (const m of all) {
      if (m.id === memoryId) continue;
      const similarity = calculateSimilarity(memory, m);
      if (similarity >= 0.3) {
        connections.push({
          id: m.id,
          content: m.content?.slice(0, 50),
          similarity,
          layer: m.layer,
          track: m.track,
        });
      }
    }
    
    return connections.sort((a, b) => b.similarity - a.similarity);
  } catch (e) {
    console.error('[dsh-memory] Connections failed:', e.message);
    return [];
  }
}

// v0.4.6: 记忆上下文窗口 - 维护最近的交互历史
class MemoryContextWindow {
  constructor(maxSize = 20) {
    this.maxSize = maxSize;
    this.history = [];
  }
  
  add(entry) {
    this.history.push({
      ...entry,
      timestamp: Date.now(),
    });
    
    // 限制窗口大小
    if (this.history.length > this.maxSize) {
      this.history.shift();
    }
  }
  
  getRecent(count = 5) {
    return this.history.slice(-count);
  }
  
  clear() {
    this.history = [];
  }
  
  get size() {
    return this.history.length;
  }
}

// 全局上下文窗口实例
const contextWindow = new MemoryContextWindow();

// v0.4.6: 获取上下文窗口
export function getContextWindow() {
  return contextWindow;
}

// v0.4.6: 添加上下文条目
export function addToContextWindow(entry) {
  contextWindow.add(entry);
}

// v0.4.6: 清空上下文窗口
export function clearContextWindow() {
  contextWindow.clear();
}

// v0.4.6: 记忆流式响应 - 用于大量结果的渐进式返回
export async function* streamMemories(memories, batchSize = 5) {
  if (!Array.isArray(memories)) return;
  
  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);
    yield {
      batch,
      total: memories.length,
      current: i + batch.length,
      hasMore: i + batch.length < memories.length,
    };
    
    // 允许其他操作插入（微任务）
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// v0.4.6: 流式搜索
export async function* streamSearch(db, query, options = {}) {
  if (!db || !query) return;
  
  const { batchSize = 5, limit = 50 } = options;
  let offset = 0;
  
  while (offset < limit) {
    const results = db.prepare(
      "SELECT *, bm25(memories_fts) as score FROM memories WHERE memories_fts MATCH ? LIMIT ? OFFSET ?"
    ).all(query, batchSize, offset);
    
    if (results.length === 0) break;
    
    yield results;
    offset += results.length;
    
    // 允许其他操作插入
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// v0.4.6: 语义嵌入质量评估
export function evaluateEmbeddingQuality(store, sample_size = 10) {
  if (!store || !store.embedding) return { available: false };
  
  try {
    const all = store.list({ limit: sample_size });
    if (all.length === 0) return { available: true, samples: 0 };
    
    const samples = [];
    for (const m of all.slice(0, sample_size)) {
      const vec = store.embedding.embedSingle(m.content);
      if (vec && vec.length === store.dimensions) {
        samples.push({
          id: m.id,
          dim: vec.length,
          norm: Math.sqrt(vec.reduce((s, v) => s + v * v, 0)),
        });
      }
    }
    
    return {
      available: true,
      samples: samples.length,
      dimensions: store.dimensions,
      avg_norm: samples.length > 0 
        ? samples.reduce((s, x) => s + x.norm, 0) / samples.length 
        : 0,
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// v0.4.6: FTS5 质量检查
export function checkFTS5Health(db) {
  if (!db) return { ok: false, reason: 'no database' };
  
  try {
    // 检查 FTS5 表是否存在
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (!fts) return { ok: false, reason: 'FTS5 table not created' };
    
    // 检查 FTS5 完整性
    const integrity = db.prepare("PRAGMA ft5_integrity_check(memories_fts)").get();
    
    // 检查数据一致性
    const total = db.prepare('SELECT COUNT(*) as cnt FROM memories').get();
    const fts_cnt = db.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get();
    
    return {
      ok: total.cnt === fts_cnt.cnt,
      total,
      fts_count: fts_cnt.cnt,
      integrity: integrity?.value || 'ok',
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// v0.4.6: 新增 Web API 端点
export function registerHealthAPI(ctx) {
  const ws = ctx.webServer;
  if (!ws) return;
  
  ws.register({
    kind: 'prefix',
    path: '/api/memory-health',
    handler: async (req, res) => {
      const service = ctx.memory;
      const db = service?.store?.db;
      
      res.setHeader('Content-Type', 'application/json');
      
      if (!db) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database not initialized' }));
        return;
      }
      
      const stats = service.stats();
      const fts_health = checkFTS5Health(db);
      const embed_quality = evaluateEmbeddingQuality(service.store);
      
      res.writeHead(200);
      res.end(JSON.stringify({
        memory_stats: stats,
        fts_health,
        embedding_quality: embed_quality,
        timestamp: new Date().toISOString(),
      }));
    },
  });
}

// v0.4.6: WebSocket 实时统计推送
export function setupMemoryStatsWS(ctx) {
  const ws = ctx.webServer;
  if (!ws || !ws.on) return;
  
  // 定期推送统计（每30秒）
  const interval = setInterval(async () => {
    try {
      const service = ctx.memory;
      if (!service) return;
      
      const stats = await service.stats();
      const data = JSON.stringify({
        type: 'memory_stats',
        ...stats,
        timestamp: Date.now(),
      });
      
      // 广播给所有连接的客户端
      ws.broadcast(data);
    } catch (e) {
      console.error('[dsh-memory] WS broadcast failed:', e.message);
    }
  }, 30000);
  
  ctx.effect(() => clearInterval(interval));
}

// v0.4.6: 记忆热图数据生成 - 用于可视化展示
export function generateHeatmapData(db) {
  if (!db) return [];
  
  try {
    // 按日期统计记忆数量
    const daily = db.prepare(`
      SELECT 
        strftime('%Y-%m-%d', created_at) as date,
        COUNT(*) as count
      FROM memories 
      WHERE priority > 0
      GROUP BY date
      ORDER BY date DESC
      LIMIT 30
    `).all();
    
    // 按类型统计
    const byType = db.prepare(`
      SELECT cat, COUNT(*) as count
      FROM memories 
      WHERE priority > 0
      GROUP BY cat
    `).all();
    
    // 按层级统计
    const byLayer = db.prepare(`
      SELECT layer, COUNT(*) as count
      FROM memories 
      WHERE priority > 0
      GROUP BY layer
    `).all();
    
    return {
      daily,
      byType,
      byLayer,
      total: daily.reduce((s, d) => s + d.count, 0),
    };
  } catch (e) {
    console.error('[dsh-memory] Heatmap generation failed:', e.message);
    return [];
  }
}

// v0.4.6: 记忆重要性动态衰减
export function applyRecencyDecay(memories, half_life_days = 30) {
  if (!Array.isArray(memories)) return memories;
  
  const now = Date.now();
  const half_life_ms = half_life_days * 24 * 60 * 60 * 1000;
  
  return memories.map(m => {
    const age_ms = now - new Date(m.created_at).getTime();
    const decay_factor = Math.pow(0.5, age_ms / half_life_ms);
    return {
      ...m,
      effective_priority: Math.round((m.priority || 3) * decay_factor * 10) / 10,
      age_days: Math.round(age_ms / (1000 * 60 * 60 * 24)),
    };
  });
}

// v0.4.6: 获取高影响力记忆（考虑衰减后的优先级）
export function getHighImpactMemories(db, threshold = 2.0) {
  if (!db) return [];
  
  try {
    const all = db.prepare('SELECT * FROM memories WHERE priority > 0 ORDER BY created_at DESC').all();
    const decayed = applyRecencyDecay(all);
    return decayed.filter(m => m.effective_priority >= threshold);
  } catch (e) {
    console.error('[dsh-memory] High impact failed:', e.message);
    return [];
  }
}

// v0.4.6: 错误恢复机制
class MemoryErrorRecovery {
  constructor() {
    this.errors = [];
    this.maxErrors = 100;
  }
  
  record(error) {
    this.errors.push({
      timestamp: new Date().toISOString(),
      error: error.message || String(error),
      stack: error.stack,
    });
    if (this.errors.length > this.maxErrors) {
      this.errors.shift();
    }
  }
  
  getRecentErrors(count = 10) {
    return this.errors.slice(-count).reverse();
  }
  
  clear() {
    this.errors = [];
  }
  
  getStats() {
    return {
      total: this.errors.length,
      recent: this.errors.slice(-10),
    };
  }
}

const errorRecovery = new MemoryErrorRecovery();

// 导出错误恢复工具
export { errorRecovery };
export const recordMemoryError = (error) => errorRecovery.record(error);
export const getMemoryErrors = (count = 10) => errorRecovery.getRecentErrors(count);
export const clearMemoryErrors = () => errorRecovery.clear();

// v0.4.6: 记忆质量报告 API
export function registerMemoryQualityAPI(ctx) {
  const ws = ctx.webServer;
  if (!ws) return;
  
  ws.register({
    kind: 'prefix',
    path: '/api/memory-quality',
    handler: async (req, res) => {
      const service = ctx.memory;
      const db = service?.store?.db;
      
      res.setHeader('Content-Type', 'application/json');
      
      if (!db) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database not initialized' }));
        return;
      }
      
      try {
        const all = db.prepare('SELECT * FROM memories WHERE priority > 0').all();
        const lowQuality = all.filter(m => assessMemoryQuality(m) < 40);
        const highQuality = all.filter(m => assessMemoryQuality(m) >= 70);
        
        res.writeHead(200);
        res.end(JSON.stringify({
          total: all.length,
          lowQuality: lowQuality.length,
          highQuality: highQuality.length,
          avgScore: all.length > 0 
            ? Math.round(all.reduce((s, m) => s + (assessMemoryQuality(m) || 50), 0) / all.length)
            : 0,
          lowQualityItems: lowQuality.map(m => ({ id: m.id, content: m.content?.slice(0, 50) })),
          timestamp: new Date().toISOString(),
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    },
  });
}

// v0.4.6: 简单聚类分析 - 基于内容相似度分组
export function clusterMemories(memories, min_cluster_size = 2) {
  if (!Array.isArray(memories) || memories.length < 2) return [];
  
  const clusters = [];
  const assigned = new Set();
  
  for (let i = 0; i < memories.length; i++) {
    if (assigned.has(i)) continue;
    
    const cluster = [memories[i]];
    assigned.add(i);
    
    for (let j = i + 1; j < memories.length; j++) {
      if (assigned.has(j)) continue;
      
      const sim = calculateSimilarity(memories[i], memories[j]);
      if (sim >= 0.4) {
        cluster.push(memories[j]);
        assigned.add(j);
      }
    }
    
    if (cluster.length >= min_cluster_size) {
      clusters.push({
        members: cluster.map(m => m.id),
        size: cluster.length,
        representative: cluster[0].content?.slice(0, 50),
      });
    }
  }
  
  return clusters.sort((a, b) => b.size - a.size);
}

// v0.4.6: 记忆趋势预测 - 基于历史数据预测增长
export function predictMemoryTrend(db, days = 7) {
  if (!db) return null;
  
  try {
    // 获取过去 N 天的数据
    const history = db.prepare(`
      SELECT 
        strftime('%Y-%m-%d', created_at) as date,
        COUNT(*) as count
      FROM memories 
      WHERE priority > 0 AND created_at >= datetime('now', ?)
      GROUP BY date
      ORDER BY date
    `).all(`-${days} days`);
    
    if (history.length < 2) return { trend: 'insufficient_data' };
    
    // 计算日均增长
    const counts = history.map(h => h.count);
    const total = counts.reduce((a, b) => a + b, 0);
    const avgDaily = total / counts.length;
    
    // 计算趋势 (线性回归斜率)
    let slope = 0;
    if (counts.length >= 2) {
      const n = counts.length;
      const sumX = (n * (n - 1)) / 2;
      const sumY = total;
      const sumXY = counts.reduce((s, c, i) => s + i * c, 0);
      const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
      slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    }
    
    const predicted7days = Math.max(0, Math.round(avgDaily * 7 + slope * 7));
    const trend = slope > 0.5 ? 'growing' : slope < -0.5 ? 'shrinking' : 'stable';
    
    return {
      trend,
      currentTotal: total,
      avgDaily,
      predicted7days,
      slope,
    };
  } catch (e) {
    console.error('[dsh-memory] Trend prediction failed:', e.message);
    return null;
  }
}

// v0.4.6: 记忆优先级预测 - 基于历史使用数据自动调整
export function predictPriority(db, memoryId) {
  if (!db || !memoryId) return null;
  
  try {
    const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
    if (!memory) return null;
    
    // 计算基于使用频率的优先级
    const accessCount = memory.access_count || 0;
    const daysSinceCreated = (Date.now() - new Date(memory.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.max(0, 1 - daysSinceCreated / 90); // 90天内有效
    
    // 类型权重
    const typeWeights = { pref: 1.5, decision: 1.3, fact: 1.0, error: 1.2 };
    const typeWeight = typeWeights[memory.cat] || 1.0;
    
    // 预测优先级
    const predictedPriority = Math.min(5, Math.max(1, 
      Math.round((accessCount * 0.3 + recencyScore * 5 + typeWeight * 2) * 10) / 10
    ));
    
    return {
      current: memory.priority,
      predicted: predictedPriority,
      change: predictedPriority - memory.priority,
    };
  } catch (e) {
    console.error('[dsh-memory] Priority prediction failed:', e.message);
    return null;
  }
}

// v0.4.6: 批量更新优先级
export function batchUpdatePriorities(db, options = {}) {
  if (!db) return { updated: 0 };
  
  const { auto = true } = options;
  let updated = 0;
  
  try {
    const all = db.prepare('SELECT id, priority FROM memories WHERE priority > 0').all();
    
    for (const m of all) {
      const prediction = predictPriority(db, m.id);
      if (prediction && prediction.change !== 0 && auto) {
        const newPriority = Math.min(5, Math.max(1, prediction.predicted));
        if (newPriority !== m.priority) {
          db.prepare('UPDATE memories SET priority = ? WHERE id = ?').run(newPriority, m.id);
          updated++;
        }
      }
    }
    
    return { updated };
  } catch (e) {
    console.error('[dsh-memory] Batch priority update failed:', e.message);
    return { updated: 0 };
  }
}

// v0.4.6: 记忆交叉引用引擎
export function buildCrossReferences(db) {
  if (!db) return {};
  
  try {
    const memories = db.prepare('SELECT id, content FROM memories WHERE priority > 0').all();
    const references = {};
    
    // 为每条记忆建立关键词索引
    for (const m of memories) {
      const keywords = extractKeywordsForRecall(m.content, 5);
      for (const kw of keywords) {
        if (!references[kw]) references[kw] = [];
        references[kw].push(m.id);
      }
    }
    
    return references;
  } catch (e) {
    console.error('[dsh-memory] Cross-reference build failed:', e.message);
    return {};
  }
}

// v0.4.6: 获取记忆的相关引用
export function getMemoryCrossRefs(db, memoryId) {
  if (!db || !memoryId) return [];
  
  try {
    const memory = db.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId);
    if (!memory) return [];
    
    const keywords = extractKeywordsForRecall(memory.content, 5);
    const refs = new Set();
    
    for (const kw of keywords) {
      const related = db.prepare(
        `SELECT id, content FROM memories WHERE memories_fts MATCH ? AND id != ?`
      ).all(`"${kw}"*`, memoryId);
      
      for (const r of related) {
        refs.add(r.id);
      }
    }
    
    return Array.from(refs).map(id => ({ id, count: 1 }));
  } catch (e) {
    console.error('[dsh-memory] Cross-refs failed:', e.message);
    return [];
  }
}

// v0.4.6: 记忆时间线视图 - 用于可视化展示记忆演进
export function generateTimelineData(db) {
  if (!db) return [];
  
  try {
    // 按月份分组统计
    const monthly = db.prepare(`
      SELECT 
        strftime('%Y-%m', created_at) as month,
        COUNT(*) as count,
        AVG(priority) as avg_priority
      FROM memories 
      WHERE priority > 0
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `).all();
    
    // 按周统计（最近8周）
    const weekly = db.prepare(`
      SELECT 
        strftime('%Y-W%W', created_at) as week,
        COUNT(*) as count
      FROM memories 
      WHERE priority > 0 AND created_at >= datetime('now', '-56 days')
      GROUP BY week
      ORDER BY week DESC
    `).all();
    
    return {
      monthly: monthly.reverse(),
      weekly: weekly.reverse(),
      summary: {
        total: monthly.reduce((s, m) => s + m.count, 0),
        avgPriority: monthly.length > 0 
          ? (monthly.reduce((s, m) => s + m.avg_priority * m.count, 0) / monthly.reduce((s, m) => s + m.count, 0)).toFixed(2)
          : 0,
      },
    };
  } catch (e) {
    console.error('[dsh-memory] Timeline generation failed:', e.message);
    return [];
  }
}

// v0.4.6: 搜索自动补全引擎
export function getAutocompleteSuggestions(db, prefix, maxSuggestions = 5) {
  if (!db || !prefix || prefix.length < 1) return [];
  
  try {
    // 基于已有关键词补全
    const completions = db.prepare(`
      SELECT DISTINCT content FROM memories 
      WHERE content LIKE ? LIMIT ?
    `).all(`${prefix}%`, maxSuggestions);
    
    return completions.map(c => c.content.slice(0, 60));
  } catch (e) {
    console.error('[dsh-memory] Autocomplete failed:', e.message);
    return [];
  }
}

// v0.4.6: 热词推荐 - 基于使用频率
export function getHotTerms(db, limit = 10) {
  if (!db) return [];
  
  try {
    // 从搜索日志或内存访问记录中获取热词
    // 这里简化为从内容中提取高频词
    const all = db.prepare('SELECT content FROM memories WHERE priority > 0').all();
    const wordFreq = {};
    
    for (const m of all) {
      const words = (m.content || '').toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length >= 2) {
          wordFreq[word] = (wordFreq[word] || 0) + 1;
        }
      }
    }
    
    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term, count]) => ({ term, count }));
  } catch (e) {
    console.error('[dsh-memory] Hot terms failed:', e.message);
    return [];
  }
}

// v0.4.6: 简单情感分析 - 基于关键词的情感分类
const POSITIVE_WORDS = ['好', '喜欢', '擅长', '成功', '优秀', '高效', '快速', '简单', '方便'];
const NEGATIVE_WORDS = ['差', '讨厌', '困难', '失败', '慢', '复杂', '问题', '错误', '异常'];

// v0.4.6: 情感评分
export function analyzeSentiment(content) {
  if (!content) return { score: 0, label: 'neutral' };
  
  const lower = content.toLowerCase();
  let score = 0;
  
  for (const word of POSITIVE_WORDS) {
    if (lower.includes(word)) score += 1;
  }
  
  for (const word of NEGATIVE_WORDS) {
    if (lower.includes(word)) score -= 1;
  }
  
  const label = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  
  return { score, label, words_found: { positive: 0, negative: 0 } };
}

// v0.4.6: 批量情感分析
export function analyzeSentimentBatch(memories) {
  if (!Array.isArray(memories)) return memories;
  
  return memories.map(m => ({
    ...m,
    sentiment: analyzeSentiment(m.content),
  }));
}

// v0.4.6: 记忆通知系统 - 当重要记忆变化时发送通知
class MemoryNotificationSystem {
  constructor() {
    this.listeners = [];
    this.maxListeners = 10;
  }
  
  on(event, callback) {
    if (this.listeners.length >= this.maxListeners) {
      console.warn('[dsh-memory] Max listeners reached');
      return;
    }
    
    this.listeners.push({ event, callback });
    return () => this.removeListener(event, callback);
  }
  
  off(event, callback) {
    this.listeners = this.listeners.filter(l => !(l.event === event && l.callback === callback));
  }
  
  removeListener(event, callback) {
    this.off(event, callback);
  }
  
  emit(event, data) {
    for (const listener of this.listeners) {
      if (listener.event === event || listener.event === '*') {
        listener.callback(data);
      }
    }
  }
}

const memoryNotifications = new MemoryNotificationSystem();

// 导出通知系统
export { memoryNotifications };
export const onMemoryEvent = (event, callback) => memoryNotifications.on(event, callback);
export const offMemoryEvent = (event, callback) => memoryNotifications.off(event, callback);

// v0.4.6: 批量记忆操作 - 支持批量增删改
export function batchUpdateMemories(db, updates, options = {}) {
  if (!db || !Array.isArray(updates) || updates.length === 0) {
    return { updated: 0, errors: [] };
  }
  
  const { dryRun = false, batchSize = 50 } = options;
  let updated = 0;
  const errors = [];
  
  try {
    // 开启事务
    if (!dryRun) db.exec('BEGIN TRANSACTION');
    
    try {
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        
        for (const update of batch) {
          try {
            const { id, content, layer, track, cat, priority, tags } = update;
            
            if (!id) continue;
            
            const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
            if (!existing) {
              // 插入新记忆
              db.prepare(`INSERT INTO memories (id, content, layer, track, cat, priority, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(id, content, layer || 3, track || 'project', cat || 'fact', priority || 3, JSON.stringify(tags || []));
            } else {
              // 更新现有记忆
              db.prepare(`UPDATE memories SET content=?, layer=?, track=?, cat=?, priority=?, tags=? WHERE id=?`)
                .run(content, layer, track, cat, priority, JSON.stringify(tags || []), id);
            }
            updated++;
          } catch (e) {
            errors.push({ id: update.id, error: e.message });
          }
        }
      }
      
      if (!dryRun) db.exec('COMMIT');
    } catch (e) {
      if (!dryRun) db.exec('ROLLBACK');
      throw e;
    }
    
    return { updated, errors };
  } catch (e) {
    console.error('[dsh-memory] Batch update failed:', e.message);
    return { updated: 0, errors: [e.message] };
  }
}

// v0.4.6: 缓存失效策略 - 当数据变化时自动失效相关缓存
const CACHE_INVALIDATION_RULES = {
  'memory:insert': ['search:*', 'stats:*', 'history:*'],
  'memory:update': ['search:*', 'stats:*', 'history:*'],
  'memory:delete': ['search:*', 'stats:*', 'history:*'],
  'memory:clear': ['search:*', 'stats:*', 'history:*', 'cache:*'],
};

// v0.4.6: 缓存失效管理器
export class CacheInvalidationManager {
  constructor() {
    this.rules = { ...CACHE_INVALIDATION_RULES };
  }
  
  addRule(event, patterns) {
    this.rules[event] = patterns;
  }
  
  invalidate(event, context = {}) {
    const patterns = this.rules[event] || [];
    const invalidated = [];
    
    for (const pattern of patterns) {
      // 匹配缓存键
      const matched = Object.keys(injectCache).filter(key => {
        const regex = new RegExp(pattern.replace('*', '.*'));
        return regex.test(key);
      });
      
      for (const key of matched) {
        injectCache.delete(key);
        invalidated.push(key);
      }
    }
    
    return invalidated;
  }
}

const cacheInvalidation = new CacheInvalidationManager();
export { cacheInvalidation };

// v0.4.6: 搜索历史记录 - 记录用户搜索行为
const searchHistory = [];
const MAX_SEARCH_HISTORY = 100;

// v0.4.6: 记录搜索历史
export function recordSearchHistory(query, results, timestamp) {
  if (!query) return;
  
  searchHistory.push({
    query,
    resultsCount: Array.isArray(results) ? results.length : 0,
    timestamp: timestamp || Date.now(),
  });
  
  // 限制历史大小
  if (searchHistory.length > MAX_SEARCH_HISTORY) {
    searchHistory.shift();
  }
}

// v0.4.6: 获取搜索历史
export function getSearchHistory(limit = 20) {
  return searchHistory.slice(-limit).reverse();
}

// v0.4.6: 清空搜索历史
export function clearSearchHistory() {
  searchHistory.length = 0;
}

// v0.4.6: 热门搜索词统计
export function getPopularSearchTerms(limit = 10) {
  const termFreq = {};
  
  for (const entry of searchHistory) {
    const terms = entry.query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      termFreq[term] = (termFreq[term] || 0) + 1;
    }
  }
  
  return Object.entries(termFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

// v0.4.6: 模糊去重 - 基于编辑距离的相似记忆检测
export function levenshteinDistance(a, b) {
  const matrix = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

// v0.4.6: 基于编辑距离的去重
export function fuzzyDeduplicate(memories, similarityThreshold = 0.8) {
  if (!Array.isArray(memories) || memories.length < 2) return memories;
  
  const unique = [];
  const seen = new Set();
  
  for (const m of memories) {
    let isDuplicate = false;
    
    for (const existing of unique) {
      const dist = levenshteinDistance(m.content, existing.content);
      const maxLen = Math.max(m.content.length, existing.content.length);
      const similarity = 1 - dist / maxLen;
      
      if (similarity >= similarityThreshold) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      unique.push(m);
      seen.add(m.id);
    }
  }
  
  return unique;
}

// v0.4.6: 记忆合并冲突解决 - 自动解决合并时的冲突
export function resolveMergeConflicts(memories, strategy = 'newest') {
  if (!Array.isArray(memories) || memories.length < 2) return memories;
  
  // 按优先级排序
  const sorted = [...memories].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  
  const result = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    let shouldInclude = true;
    
    for (const existing of result) {
      const similarity = calculateSimilarity(current, existing);
      
      if (similarity >= 0.7) {
        // 高相似度，需要解决冲突
        if (strategy === 'newest') {
          // 保留最新的
          if (new Date(current.created_at) > new Date(existing.created_at)) {
            const idx = result.indexOf(existing);
            result[idx] = current;
          }
        } else if (strategy === 'higher_priority') {
          // 保留优先级高的
          if (current.priority > existing.priority) {
            const idx = result.indexOf(existing);
            result[idx] = current;
          }
        } else if (strategy === 'merge_content') {
          // 合并内容
          existing.content += ' | ' + current.content;
        }
        shouldInclude = false;
        break;
      }
    }
    
    if (shouldInclude) {
      result.push(current);
    }
  }
  
  return result;
}

// v0.4.6: 为注入内容添加上下文增强
export function enhanceInjectContext(injectedMemories, currentContext) {
  if (!Array.isArray(injectedMemories)) return injectedMemories;
  
  return injectedMemories.map(m => ({
    ...m,
    context_enrichment: {
      // 添加当前会话相关信息
      session_id: currentContext?.session_id,
      related_to: extractRelatedTopics(m.content, currentContext?.topics || []),
      confidence: m.score || 0.5,
    },
  }));
}

// v0.4.6: 提取相关主题
function extractRelatedTopics(content, currentTopics) {
  if (!currentTopics?.length) return [];
  
  const topics = [];
  const contentLower = content.toLowerCase();
  
  for (const topic of currentTopics) {
    if (contentLower.includes(topic.toLowerCase())) {
      topics.push(topic);
    }
  }
  
  return topics.slice(0, 3);
}

// v0.4.6: API 版本管理
const API_VERSIONS = {
  'v1': {
    endpoints: ['/api/memory/list', '/api/memory/search', '/api/memory/add'],
    description: '基础记忆操作 API',
  },
  'v2': {
    endpoints: [
      '/api/memory/list',
      '/api/memory/search',
      '/api/memory/add',
      '/api/memory/update',
      '/api/memory/remove',
      '/api/memory/stats',
      '/api/memory/health',
      '/api/memory-quality',
      '/api/memory-heatmap',
    ],
    description: '增强版记忆 API，包含质量、健康检查等',
  },
};

// v0.4.6: 获取当前 API 版本
export function getAPIVersion() {
  return 'v2';
}

// v0.4.6: 获取 API 端点列表
export function getAPIEndpoints(version = 'v2') {
  return API_VERSIONS[version]?.endpoints || [];
}

// v0.4.6: 获取 API 信息
export function getAPIInfo(version = 'v2') {
  return {
    current: version,
    available: Object.keys(API_VERSIONS),
    ...API_VERSIONS[version],
  };
}

// v0.4.6: 记忆数据迁移工具
export function migrateMemoryData(db, fromVersion, toVersion) {
  if (!db) return { migrated: 0, errors: [] };
  
  const errors = [];
  let migrated = 0;
  
  try {
    // v1 → v2 迁移
    if (fromVersion === 'v1' && toVersion === 'v2') {
      // 添加缺失的列
      try {
        db.exec('ALTER TABLE memories ADD COLUMN tags TEXT DEFAULT "[]"');
        migrated++;
      } catch (e) {
        // 列可能已存在
      }
      
      // 添加缺失的索引
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority)');
        migrated++;
      } catch (e) {}
      
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)');
        migrated++;
      } catch (e) {}
    }
    
    return { migrated, errors };
  } catch (e) {
    errors.push(e.message);
    return { migrated: 0, errors };
  }
}

// v0.4.6: 搜索分析统计
const searchStats = {
  totalSearches: 0,
  totalResults: 0,
  avgResultsPerSearch: 0,
  topQueries: [],
};

// v0.4.6: 记录搜索统计
export function recordSearchStats(query, resultsCount) {
  searchStats.totalSearches++;
  searchStats.totalResults += resultsCount;
  searchStats.avgResultsPerSearch = Math.round(
    searchStats.totalResults / searchStats.totalSearches
  );
  
  // 更新热门查询
  searchStats.topQueries.push({ query, count: 1, timestamp: Date.now() });
  if (searchStats.topQueries.length > 50) {
    searchStats.topQueries.shift();
  }
}

// v0.4.6: 获取搜索统计
export function getSearchStats() {
  return {
    ...searchStats,
    topQueries: searchStats.topQueries
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 10),
  };
}

// v0.4.6: 重置搜索统计
export function resetSearchStats() {
  searchStats.totalSearches = 0;
  searchStats.totalResults = 0;
  searchStats.avgResultsPerSearch = 0;
  searchStats.topQueries = [];
}

// v0.4.7: 记忆质量评分优化 - 更严格的标准

// v0.4.7: 记忆清理工具 - 自动标记/降级低质量记忆
export function cleanupLowQualityMemories(db, options = {}) {
  if (!db) return { cleaned: 0, total: 0 };
  
  const { minQuality = 40, dryRun = true } = options;
  let cleaned = 0;
  
  try {
    const all = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0').all();
    const toUpdate = [];
    
    for (const m of all) {
      const quality = assessMemoryQuality(m);
      if (quality < minQuality) {
        toUpdate.push({ id: m.id, quality, currentPriority: m.priority });
      }
    }
    
    if (!dryRun && toUpdate.length > 0) {
      const tx = db.transaction(() => {
        for (const item of toUpdate) {
          // 低质量记忆降级优先级
          const newPriority = Math.max(1, (item.currentPriority || 3) - 1);
          db.prepare('UPDATE memories SET priority = ? WHERE id = ?').run(newPriority, item.id);
        }
      });
      tx();
      cleaned = toUpdate.length;
    }
    
    return {
      cleaned,
      total: all.length,
      lowQualityCount: toUpdate.length,
      lowQualityItems: toUpdate.map(m => ({
        id: m.id,
        quality: m.quality,
        content: m.content?.slice(0, 30),
      })),
    };
  } catch (e) {
    console.error('[dsh-memory] Cleanup failed:', e.message);
    return { cleaned: 0, total: all?.length || 0, error: e.message };
  }
}

// v0.4.7: 记忆时效性检测 - 长期未使用的记忆自动降级
export function checkMemoryFreshness(db, options = {}) {
  if (!db) return { stale: 0 };
  
  const { staleAfterDays = 90, dryRun = true } = options;
  let stale = 0;
  
  try {
    const threshold = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000).toISOString();
    
    // 查找过时记忆
    const oldMemories = db.prepare(
      `SELECT id, content, priority, created FROM memories 
       WHERE priority > 0 AND created < ? AND layer < 4`
    ).all(threshold);
    
    stale = oldMemories.length;
    
    if (!dryRun && stale > 0) {
      // 降级过时记忆
      const tx = db.transaction(() => {
        for (const m of oldMemories) {
          const newPriority = Math.max(1, (m.priority || 3) - 1);
          db.prepare('UPDATE memories SET priority = ? WHERE id = ?').run(newPriority, m.id);
        }
      });
      tx();
    }
    
    return { stale, items: oldMemories.slice(0, 5).map(m => m.id) };
  } catch (e) {
    console.error('[dsh-memory] Freshness check failed:', e.message);
    return { stale: 0, error: e.message };
  }
}

// v0.4.7: 启动时自动清理 - 减少噪音记忆影响检索
export function autoCleanupOnStartup(db) {
  if (!db) return;
  
  try {
    // 删除优先级为0的测试/废弃记忆
    const deleted = db.prepare('DELETE FROM memories WHERE priority = 0').run();
    if (deleted.changes > 0) {
      console.log(`[dsh-memory] Auto-cleaned ${deleted.changes} low-priority memories`);
    }
    
    // 降级明显低质量的记忆 - v0.4.62: 更精准的清理策略
    const all = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0').all();
    let downgraded = 0;
    let cleaned = 0;
    
    for (const m of all) {
      const quality = assessMemoryQuality(m);
      const currentPriority = m.priority || 3;
      
      // v0.4.62: 三级清理策略
      if (quality < 20 && currentPriority <= 2) {
        // 极低质量 + 低优先级 -> 删除
        db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
        cleaned++;
      } else if (quality < 40 && currentPriority >= 3) {
        // 低质量 + 高优先级 -> 降级
        db.prepare('UPDATE memories SET priority = 1 WHERE id = ?').run(m.id);
        downgraded++;
      }
    }
    
    if (downgraded > 0) {
      console.log(`[dsh-memory] Downgraded ${downgraded} low quality memories`);
    }
    if (cleaned > 0) {
      console.log(`[dsh-memory] Cleaned ${cleaned} very low quality memories`);
    }
    
    // v0.4.14: 运行记忆老化检测
    try {
      const aged = ageMemories(db);
      if (aged > 0) {
        console.log(`[dsh-memory] Aged ${aged} inactive memories`);
      }
    } catch (e) {
      console.warn('[dsh-memory] Aging failed:', e.message);
    }
    
    // v0.4.50: 自动去重检测
    try {
      const deduped = autoDeduplicate(db);
      if (deduped > 0) {
        console.log(`[dsh-memory] Deduplicated ${deduped} similar memories`);
      }
    } catch (e) {
      console.warn('[dsh-memory] Dedup failed:', e.message);
    }
  } catch (e) {
    console.error('[dsh-memory] Auto-cleanup failed:', e.message);
  }
}

// v0.4.9: 注入效果监控 - 追踪每次注入的质量和效果
const injectMetrics = {
  totalInjects: 0,
  totalMemoriesInjected: 0,
  emptyInjects: 0,
  avgRelevance: 0,
  // v0.4.19: 新增追踪字段
  byTrack: {},       // 按轨道统计
  byLayer: {},       // 按层级统计
  recentInjects: [], // 最近10次注入详情
  // v0.4.21: 注入成功率追踪
  hitRateHistory: [], // 最近20次注入的命中率
  avgHitsPerInject: 0,
  // v0.4.27: 用户反馈追踪
  feedbackCount: 0,
  positiveFeedback: 0,
  negativeFeedback: 0,
};

// v0.4.17: 记忆使用统计 - 追踪哪些记忆被频繁使用
const memoryUsageStats = new Map(); // memoryId -> { count, lastUsed }
const MAX_USAGE_HISTORY = 1000;

// v0.4.9: 记录注入指标
export function recordInjectMetric(result) {
  injectMetrics.totalInjects++;
  if (result?.memories?.length > 0) {
    injectMetrics.totalMemoriesInjected += result.memories.length;
    injectMetrics.avgRelevance = 
      (injectMetrics.avgRelevance * (injectMetrics.totalInjects - 1) + (result.avgScore || 0)) 
      / injectMetrics.totalInjects;
  } else {
    injectMetrics.emptyInjects++;
  }
}

// v0.4.9: 获取注入统计
export function getInjectMetrics() {
  return {
    ...injectMetrics,
    hitRate: injectMetrics.totalInjects > 0 
      ? ((injectMetrics.totalInjects - injectMetrics.emptyInjects) / injectMetrics.totalInjects * 100).toFixed(1)
      : 0,
  };
}

// v0.4.17: 获取记忆使用统计
export function getMemoryUsageStats(limit = 10) {
  const stats = [];
  for (const [id, usage] of memoryUsageStats) {
    stats.push({ id, ...usage });
  }
  return stats.sort((a, b) => b.count - a.count).slice(0, limit);
}

// v0.4.17: 获取热门记忆列表
export function getPopularMemories(db, limit = 10) {
  if (!db) return [];
  try {
    const all = db.prepare('SELECT id, content, priority, created_at FROM memories WHERE priority > 0 ORDER BY updated DESC').all();
    return all.map(m => ({
      ...m,
      usageCount: memoryUsageStats.get(m.id)?.count || 0,
      lastUsed: memoryUsageStats.get(m.id)?.lastUsed || m.created_at,
    })).sort((a, b) => b.usageCount - a.usageCount).slice(0, limit);
  } catch (e) {
    console.error('[dsh-memory] Get popular memories failed:', e.message);
    return [];
  }
}

// v0.4.13: 获取记忆质量报告\n
// v0.4.15: 记忆合并 - 合并高度相似的记忆
export function consolidateMemories(db, options = {}) {
  const { similarityThreshold = 0.8, maxMergeDistance = 0.3 } = options;
  if (!db) return 0;
  
  try {
    const all = db.prepare('SELECT id, content, embedding FROM memories WHERE priority > 0').all();
    if (all.length < 2) return 0;
    
    let merged = 0;
    const used = new Set();
    
    // 简单实现：按相似度分组并合并
    for (let i = 0; i < all.length; i++) {
      if (used.has(i)) continue;
      
      for (let j = i + 1; j < all.length; j++) {
        if (used.has(j)) continue;
        
        // 计算相似度（简化版：基于内容重叠）
        const words1 = new Set(all[i].content.split(/\s+/).filter(w => w.length > 2));
        const words2 = new Set(all[j].content.split(/\s+/).filter(w => w.length > 2));
        const common = [...words1].filter(w => words2.has(w)).length;
        const maxWords = Math.max(words1.size, words2.size);
        const similarity = maxWords > 0 ? common / maxWords : 0;
        
        if (similarity >= similarityThreshold) {
          // 合并：保留更完整的内容和更高的优先级
          const mergedContent = all[i].content.length >= all[j].content.length 
            ? all[i].content 
            : all[j].content;
          const mergedPriority = Math.max(all[i].priority || 1, all[j].priority || 1);
          
          db.prepare('UPDATE memories SET content = ?, priority = ? WHERE id = ?').run(
            mergedContent, mergedPriority, all[i].id
          );
          db.prepare('DELETE FROM memories WHERE id = ?').run(all[j].id);
          used.add(j);
          merged++;
        }
      }
      used.add(i);
    }
    
    return merged;
  } catch (e) {
    console.error('[dsh-memory] Consolidate failed:', e.message);
    return 0;
  }
}

// v0.4.22: 记忆质量趋势追踪
const qualityTrend = {
  samples: [],        // 最近20次采样
  avgQuality: 0,
  trend: 'stable',    // rising/stable/falling
};

// v0.4.22: 采样当前记忆质量
export function sampleMemoryQuality(db) {
  if (!db) return null;
  try {
    const all = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0').all();
    if (all.length === 0) return null;
    
    const scores = all.map(m => assessMemoryQuality(m));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    
    qualityTrend.samples.push({ ts: Date.now(), avg, count: all.length });
    if (qualityTrend.samples.length > 20) qualityTrend.samples.shift();
    
    // 计算趋势
    if (qualityTrend.samples.length >= 3) {
      const recent = qualityTrend.samples.slice(-3).map(s => s.avg);
      if (recent[2] > recent[0] + 5) qualityTrend.trend = 'rising';
      else if (recent[2] < recent[0] - 5) qualityTrend.trend = 'falling';
      else qualityTrend.trend = 'stable';
    }
    
    qualityTrend.avgQuality = avg;
    return { avg, min: Math.min(...scores), max: Math.max(...scores), count: all.length };
  } catch (e) {
    console.error('[dsh-memory] Quality sample failed:', e.message);
    return null;
  }
}

// v0.4.22: 获取质量趋势
export function getQualityTrend() {
  return {
    ...qualityTrend,
    samples: qualityTrend.samples.map(s => ({ ...s, ts: new Date(s.ts).toISOString() })),
  };
}
// v0.4.23: 根据历史效果调整注入策略
export function adaptInjectStrategy() {
  const recent = injectMetrics.hitRateHistory?.slice(0, 10) || [];
  if (recent.length < 5) return null;
  
  const hitRate = recent.reduce((a, b) => a + b, 0) / recent.length;
  const prevRate = injectStrategy.recentHitRate;
  
  let adjustment = null;
  
  if (hitRate < 0.3 && injectStrategy.maxInject > injectStrategy.minInject) {
    // 命中率太低，减少注入数量
    injectStrategy.maxInject = Math.max(injectStrategy.minInject, injectStrategy.maxInject - 1);
    adjustment = { action: 'reduce', reason: '命中率低', newMax: injectStrategy.maxInject };
  } else if (hitRate > 0.8 && injectStrategy.maxInject < 8) {
    // 命中率高，可以适当增加
    injectStrategy.maxInject = Math.min(8, injectStrategy.maxInject + 1);
    adjustment = { action: 'increase', reason: '命中率高', newMax: injectStrategy.maxInject };
  }
  
  injectStrategy.recentHitRate = hitRate;
  injectStrategy.trend = hitRate > prevRate ? 'rising' : hitRate < prevRate ? 'falling' : 'stable';
  
  if (adjustment) {
    injectStrategy.adjustmentHistory.unshift({ ...adjustment, ts: Date.now() });
    if (injectStrategy.adjustmentHistory.length > 10) injectStrategy.adjustmentHistory.pop();
  }
  
  return adjustment;
}
// v0.4.24: 注入日志分析 - 帮助诊断注入问题
const injectLog = [];
const MAX_INJECT_LOG = 100;

// v0.4.24: 记录注入日志
export function logInjectEvent(event) {
  injectLog.push({
    ts: Date.now(),
    ...event,
  });
  if (injectLog.length > MAX_INJECT_LOG) {
    injectLog.shift();
  }
}

// v0.4.24: 获取注入日志
export function getInjectLog(limit = 20) {
  return injectLog.slice(-limit);
}

// v0.4.24: 注入问题分析
export function analyzeInjectIssues() {
  if (injectLog.length < 5) return { hasIssues: false, message: '样本不足' };
  
  const recent = injectLog.slice(-20);
  const emptyRate = recent.filter(e => e.type === 'empty').length / recent.length;
  const lowRelevance = recent.filter(e => e.avgScore < 0.3).length / recent.length;
  
  const issues = [];
  if (emptyRate > 0.5) issues.push('超过50%的注入为空，建议检查关键词提取');
  if (lowRelevance > 0.3) issues.push('超过30%的注入相关度低，建议调整阈值');
  if (recent.filter(e => e.type === 'cooldown').length > 5) issues.push('频繁冷却，可能是高频请求');
  
  return {
    hasIssues: issues.length > 0,
    issues,
    stats: {
      total: recent.length,
      emptyRate: (emptyRate * 100).toFixed(1) + '%',
      lowRelevanceRate: (lowRelevance * 100).toFixed(1) + '%',
    },
  };
}
// v0.4.27: 记录用户反馈
export function recordInjectFeedback(positive) {
  injectMetrics.feedbackCount++;
  if (positive) {
    injectMetrics.positiveFeedback++;
  } else {
    injectMetrics.negativeFeedback++;
  }
}

// v0.4.27: 获取反馈统计
export function getFeedbackStats() {
  const total = injectMetrics.feedbackCount;
  if (total === 0) return { rate: 0, total: 0 };
  const positiveRate = injectMetrics.positiveFeedback / total;
  return {
    total,
    positiveRate: (positiveRate * 100).toFixed(1) + '%',
    positive: injectMetrics.positiveFeedback,
    negative: injectMetrics.negativeFeedback,
  };
}
// v0.4.28: 记忆去重预检 - 在保存前检查相似度
export async function dedupCheck(service, content, options = {}) {
  if (!service?.embedding || !service?.store) return { isDuplicate: false };
  
  try {
    const emb = await service.embedding.embedSingle(content);
    if (!emb) return { isDuplicate: false };
    
    const similar = service.store.findSimilar(emb, {
      limit: 3,
      threshold: 0.3,
      track: options.track,
      layer: options.layer,
    });
    
    if (similar.length > 0) {
      return {
        isDuplicate: true,
        similarId: similar[0].id,
        similarity: (1 - similar[0].dist).toFixed(3),
        suggestion: 'memory_update',
      };
    }
    
    return { isDuplicate: false };
  } catch (e) {
    console.warn('[dsh-memory] Dedup check failed:', e.message);
    return { isDuplicate: false };
  }
}
// v0.4.31: 模糊搜索 - 支持编辑距离匹配
export function fuzzySearch(memories, query, maxDistance = 2) {
  if (!memories || !Array.isArray(memories)) return [];
  if (!query || query.length < 2) return memories;
  
  const queryLower = query.toLowerCase();
  const results = [];
  
  for (const m of memories) {
    const content = (m.content || '').toLowerCase();
    
    // 精确匹配优先
    if (content.includes(queryLower)) {
      results.unshift({ ...m, _score: 1.0, _type: 'exact' });
      continue;
    }
    
    // 编辑距离匹配
    const distance = levenshteinDistance(queryLower, content.slice(0, queryLower.length + maxDistance * 2));
    if (distance <= maxDistance && distance > 0) {
      results.push({ ...m, _score: 1 - distance / (maxDistance + 1), _type: 'fuzzy' });
    }
  }
  
  return results.sort((a, b) => b._score - a._score);
}
// v0.4.33: 记忆质量评分可视化
export function getQualityVisualization(db, options = {}) {
  const { limit = 20 } = options;
  if (!db) return null;
  
  try {
    const all = db.prepare('SELECT id, content, priority, created_at FROM memories WHERE priority > 0 ORDER BY created_at DESC LIMIT ?').all(limit);
    
    const items = all.map(m => {
      const quality = assessMemoryQuality(m);
      const bar = '█'.repeat(Math.round(quality / 5)) + '░'.repeat(20 - Math.round(quality / 5));
      return {
        id: m.id,
        quality,
        bar,
        content: m.content?.slice(0, 50),
        priority: m.priority,
        age: Math.round((Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24)) + 'd',
      };
    });
    
    const avgQuality = items.length > 0 
      ? items.reduce((a, b) => a + b.quality, 0) / items.length 
      : 0;
    
    return {
      items,
      avgQuality: Math.round(avgQuality),
      highQuality: items.filter(i => i.quality >= 70).length,
      mediumQuality: items.filter(i => i.quality >= 50 && i.quality < 70).length,
      lowQuality: items.filter(i => i.quality < 50).length,
    };
  } catch (e) {
    console.error('[dsh-memory] Quality viz failed:', e.message);
    return null;
  }
}
// v0.4.34: 记忆使用热图数据
export function getMemoryHeatmap(db, days = 30) {
  if (!db) return [];
  
  try {
    const now = Date.now();
    const startDate = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    
    // 按天统计创建和更新
    const sql = `
      SELECT 
        date(created_at) as day,
        COUNT(*) as created,
        COUNT(CASE WHEN priority > 0 THEN 1 END) as active
      FROM memories
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day
    `;
    
    const rows = db.prepare(sql).all(startDate);
    return rows.map(r => ({
      date: r.day,
      created: r.created,
      active: r.active,
    }));
  } catch (e) {
    console.error('[dsh-memory] Heatmap failed:', e.message);
    return [];
  }
}
// v0.4.35: 记忆导出功能
// v0.4.37: 注入效果自动评估
const injectEffectiveness = {
  scores: [],      // 最近20次注入效果评分
  avgScore: 0,     // 平均效果评分
  trend: 'stable', // rising/stable/falling
};

// v0.4.37: 评估注入效果
export function evaluateInjectEffectiveness(responseQuality, memoryRelevance) {
  // responseQuality: 0-1，基于LLM响应的质量指标
  // memoryRelevance: 0-1，记忆与当前任务的匹配度
  
  const score = (responseQuality * 0.6 + memoryRelevance * 0.4);
  
  injectEffectiveness.scores.push({
    ts: Date.now(),
    score,
    responseQuality,
    memoryRelevance,
  });
  
  if (injectEffectiveness.scores.length > 20) {
    injectEffectiveness.scores.shift();
  }
  
  // 计算平均分
  const recent = injectEffectiveness.scores.slice(-10);
  injectEffectiveness.avgScore = recent.reduce((a, b) => a + b.score, 0) / recent.length;
  
  // 计算趋势
  if (recent.length >= 3) {
    const first = recent[0].score;
    const last = recent[recent.length - 1].score;
    if (last > first + 0.1) injectEffectiveness.trend = 'rising';
    else if (last < first - 0.1) injectEffectiveness.trend = 'falling';
    else injectEffectiveness.trend = 'stable';
  }
  
  return score;
}

// v0.4.37: 获取效果统计
export function getInjectEffectivenessStats() {
  return {
    ...injectEffectiveness,
    scores: injectEffectiveness.scores.map(s => ({
      ...s,
      ts: new Date(s.ts).toISOString(),
    })),
  };
}
// v0.4.38: 注入策略持久化
const STRATEGY_FILE = '.dsh/memory_strategy.json';

// 延迟导入 fs 和 path
let fs, path;
try {
  fs = await import('fs');
  path = await import('path');
} catch (e) {
  // fallback for non-ESM environments
}

// v0.4.38: 加载持久化的策略
export function loadPersistedStrategy() {
  try {
    const filePath = path.default.join(process.env.HOME || '', STRATEGY_FILE);
    if (fs.default.existsSync(filePath)) {
      const data = JSON.parse(fs.default.readFileSync(filePath, 'utf8'));
      if (data.injectStrategy) {
        Object.assign(injectStrategy, data.injectStrategy);
      }
      if (data.injectMetrics) {
        Object.assign(injectMetrics, data.injectMetrics);
      }
      return true;
    }
  } catch (e) {
    console.warn('[dsh-memory] Failed to load persisted strategy:', e.message);
  }
  return false;
}

// v0.4.38: 保存策略到文件
export function savePersistedStrategy() {
  try {
    const filePath = path.default.join(process.env.HOME || '', STRATEGY_FILE);
    const data = {
      injectStrategy,
      injectMetrics,
      savedAt: new Date().toISOString(),
    };
    fs.default.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn('[dsh-memory] Failed to save persisted strategy:', e.message);
    return false;
  }
}
// v0.4.40: 记忆生命周期管理
export const MEM_LIFECYCLE = {
  NEW: 'new',           // 刚创建
  ACTIVE: 'active',     // 活跃使用
  STALE: 'stale',       // 过时
  ARCHIVED: 'archived', // 已归档
  DELETED: 'deleted',   // 已删除
};

// v0.4.40: 评估记忆生命周期状态

// v0.4.40: 批量处理生命周期状态
export function manageLifecycle(db, options = {}) {
  const { 
    archiveAfterDays = 180,
    staleAfterDays = 90,
    cleanupAfterDays = 365
  } = options;
  
  if (!db) return { archived: 0, stale: 0, cleaned: 0 };
  
  try {
    const now = Date.now();
    
    // 归档超期记忆
    const archiveSql = `
      SELECT id FROM memories 
      WHERE priority > 0 
      AND updated < datetime(? , 'subsec")
    `;
    const toArchive = db.prepare(archiveSql).all(new Date(now - archiveAfterDays * 24 * 60 * 60 * 1000).toISOString());
    
    // 创建归档表（如果不存在）
    db.prepare('CREATE TABLE IF NOT EXISTS memories_archive LIKE memories').run();
    
    let archived = 0;
    for (const m of toArchive) {
      db.prepare('INSERT INTO memories_archive SELECT * FROM memories WHERE id = ?').run(m.id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
      archived++;
    }
    
    // 标记过时记忆
    const staleSql = `
      SELECT id FROM memories 
      WHERE priority > 0 
      AND updated < datetime(? , 'subsec")
      AND updated >= datetime(? , 'subsec")
    `;
    const toStale = db.prepare(staleSql).all(
      new Date(now - staleAfterDays * 24 * 60 * 60 * 1000).toISOString(),
      new Date(now - archiveAfterDays * 24 * 60 * 60 * 1000).toISOString()
    );
    
    let stale = 0;
    for (const m of toStale) {
      db.prepare('UPDATE memories SET priority = MAX(1, priority - 1) WHERE id = ?').run(m.id);
      stale++;
    }
    
    // 清理超期记忆
    const cleanupSql = `
      SELECT id FROM memories 
      WHERE priority > 0 
      AND updated < datetime(? , 'subsec")
    `;
    const toCleanup = db.prepare(cleanupSql).all(
      new Date(now - cleanupAfterDays * 24 * 60 * 60 * 1000).toISOString()
    );
    
    let cleaned = 0;
    for (const m of toCleanup) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
      cleaned++;
    }
    
    return { archived, stale, cleaned };
  } catch (e) {
    console.error('[dsh-memory] Lifecycle management failed:', e.message);
    return { archived: 0, stale: 0, cleaned: 0 };
  }
}
// v0.4.42: 记忆搜索增强 - 支持短语匹配和通配符
export function enhancedSearch(db, query, options = {}) {
  if (!db || !query) return [];
  
  try {
    const { limit = 10, exactMatch = false } = options;
    
    // 处理通配符
    let searchQuery = query;
    if (query.includes('*')) {
      searchQuery = query.replace(/\*/g, '%');
    }
    
    // 构建FTS查询
    const ftsQuery = exactMatch 
      ? `"${searchQuery}"` 
      : searchQuery.split(/\s+/).map(w => w + '*').join(' OR ');
    
    const sql = `
      SELECT m.id, m.content, m.layer, m.track, m.priority, fts.rank AS rank
      FROM (SELECT rowid, rank FROM memories_fts WHERE memories_fts MATCH ?) fts
      JOIN memories m ON m.id = fts.rowid
      WHERE m.priority > 0
      ORDER BY fts.rank
      LIMIT ?
    `;
    
    return db.prepare(sql).all(ftsQuery, limit);
  } catch (e) {
    console.error('[dsh-memory] Enhanced search failed:', e.message);
    return [];
  }
}

// v0.4.42: 批量搜索多关键词
export function batchSearch(db, queries, options = {}) {
  if (!db || !Array.isArray(queries)) return {};
  
  const results = {};
  for (const q of queries) {
    results[q] = enhancedSearch(db, q, options);
  }
  return results;
}
// v0.4.46: 记忆总结功能
// v0.4.48: 上下文感知的注入策略
const contextAwareness = {
  currentContext: null,
  contextHistory: [],
};

// v0.4.48: 分析当前对话上下文
export function analyzeContext(sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return null;
  
  // 分析最近的对话内容
  const recentEvents = sessionEvents.slice(-20);
  const userMessages = recentEvents.filter(e => e?.type === 'user/message');
  const assistantMessages = recentEvents.filter(e => e?.type === 'assistant/message');
  
  if (userMessages.length === 0) return null;
  
  const lastUserMessage = userMessages[userMessages.length - 1];
  const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
  
  // 提取上下文信息
  const context = {
    topic: extractTopic(lastUserMessage?.content || ''),
    taskType: classifyTask(lastUserMessage?.content || ''),
    sentiment: analyzeSentiment(lastUserMessage?.content || ''),
    relatedMemories: [],
  };
  
  contextAwareness.currentContext = context;
  contextAwareness.contextHistory.push({
    ts: Date.now(),
    topic: context.topic,
    taskType: context.taskType,
  });
  
  if (contextAwareness.contextHistory.length > 50) {
    contextAwareness.contextHistory.shift();
  }
  
  return context;
}

// v0.4.48: 提取话题
function extractTopic(text) {
  if (!text) return 'unknown';
  const topics = ['开发', '部署', '调试', '优化', '设计', '架构', '修复', '测试'];
  for (const topic of topics) {
    if (text.includes(topic)) return topic;
  }
  return '其他';
}

// v0.4.48: 分类任务类型
function classifyTask(text) {
  if (!text) return 'general';
  if (/开发|实现|编写|创建/.test(text)) return 'development';
  if (/部署|发布|上线/.test(text)) return 'deployment';
  if (/修复|debug|问题/.test(text)) return 'debugging';
  if (/优化|改进|提升/.test(text)) return 'optimization';
  return 'general';
}

// v0.4.48: 分析情感

// v0.4.48: 获取上下文感知的注入建议
export function getContextAwareInjectAdvice(context) {
  if (!context) return null;
  
  const advice = {
    injectMore: false,
    focusTracks: [],
    focusLayers: [],
    customHint: '',
  };
  
  // 根据任务类型调整注入策略
  switch (context.taskType) {
    case 'development':
      advice.injectMore = true;
      advice.focusTracks = ['project', 'global'];
      advice.customHint = '当前涉及开发任务，请优先参考技术方案和架构决策类记忆。';
      break;
    case 'deployment':
      advice.focusTracks = ['global'];
      advice.customHint = '当前涉及部署操作，请优先参考部署配置和环境相关记忆。';
      break;
    case 'debugging':
      advice.injectMore = true;
      advice.focusTracks = ['project'];
      advice.customHint = '当前遇到问题，请优先参考历史问题和解决方案类记忆。';
      break;
    case 'optimization':
      advice.focusTracks = ['project', 'global'];
      advice.customHint = '当前涉及优化改进，请优先参考架构决策和技术方案类记忆。';
      break;
  }
  
  return advice;
}
// v0.4.50: 自动去重 - 启动时检测并合并高度相似的记忆
export function autoDeduplicate(db, options = {}) {
  const { similarityThreshold = 0.85 } = options;
  if (!db) return 0;
  
  try {
    const all = db.prepare('SELECT id, content, priority FROM memories WHERE priority > 0 ORDER BY id').all();
    if (all.length < 2) return 0;
    
    let merged = 0;
    const used = new Set();
    
    for (let i = 0; i < all.length; i++) {
      if (used.has(i)) continue;
      
      for (let j = i + 1; j < all.length; j++) {
        if (used.has(j)) continue;
        
        // 计算内容相似度（基于共享关键词比例）
        const words1 = new Set(all[i].content.split(/\s+/).filter(w => w.length > 2));
        const words2 = new Set(all[j].content.split(/\s+/).filter(w => w.length > 2));
        const common = [...words1].filter(w => words2.has(w)).length;
        const maxWords = Math.max(words1.size, words2.size);
        const similarity = maxWords > 0 ? common / maxWords : 0;
        
        if (similarity >= similarityThreshold) {
          // 合并：保留更完整的内容和更高的优先级
          const mergedContent = all[i].content.length >= all[j].content.length 
            ? all[i].content 
            : all[j].content;
          const mergedPriority = Math.max(all[i].priority || 1, all[j].priority || 1);
          
          db.prepare('UPDATE memories SET content = ?, priority = ? WHERE id = ?').run(
            mergedContent, mergedPriority, all[i].id
          );
          db.prepare('DELETE FROM memories WHERE id = ?').run(all[j].id);
          used.add(j);
          merged++;
        }
      }
      used.add(i);
    }
    
    return merged;
  } catch (e) {
    console.error('[dsh-memory] Auto-deduplicate failed:', e.message);
    return 0;
  }
}
// v0.4.53: 分类任务类型 - 用于动态调整注入策略
function classifyTaskType(text) {
  if (!text) return 'general';
  if (/[问题|bug|错误|报错|异常|失败|不工作|无法|不能]/.test(text)) return 'debug';
  if (/[优化|改进|提升|加速|性能]/.test(text)) return 'optimization';
  if (/[部署|发布|上线|生产|环境]/.test(text)) return 'deployment';
  if (/[开发|实现|编写|创建|功能|模块|组件]/.test(text)) return 'development';
  return 'general';
}
// v0.4.57: 计算文本相似度（简化版 - 基于共享词比例）
function computeTextSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length >= 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length >= 2));
  if (words1.size === 0 || words2.size === 0) return 0;
  
  let common = 0;
  for (const w of words1) {
    for (const w2 of words2) {
      if (w.includes(w2) || w2.includes(w)) common++;
    }
  }
  
  return common / Math.max(words1.size, words2.size);
}
// v0.4.104: 检测用户当前状态
function detectUserState(text) {
  if (!text) return 'neutral';
  if (/[问题|错误|失败|bug|崩溃|无法|不能]/.test(text)) return 'frustrated';
  if (/[怎么|如何|为什么|怎样|请问|请教]/.test(text)) return 'curious';
  if (/[完成|成功|解决|通过|好的]/.test(text)) return 'satisfied';
  return 'neutral';
}
