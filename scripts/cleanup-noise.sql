-- scripts/cleanup-noise.sql
-- 用启发式规则软删除 (priority = 0) 噪音记忆。
-- ⚠️  这是 dry-run candidate 列表，请在 review 之后手动执行 UPDATE 语句。
--  软删除的好处：错了可恢复 (UPDATE memories SET priority = <原值> WHERE id = <id>)。
--
-- 规则：
--   1. 内容触发 META_THOUGHT_RE 扩展黑名单（"我用/我选了/我准备..."）
--   2. 内容短于 10 字符（"测试记忆" "用户偏好测试"）
--   3. 内容含 dedup 留下的空壳标记（"[补充: |]" / "[补充: ]"）
--   4. 开头是 markdown 列表标记（"- " / "* " / "• "）
--
-- Step 1: 干运行，列出候选
.headers on
.mode column
SELECT
  id,
  layer,
  track,
  priority,
  substr(content, 1, 70) AS preview
FROM memories
WHERE priority > 0
  AND (
    -- META_THOUGHT_RE 扩展黑名单
    content ~ '(我|咱们|我们)(需要|打算|想|要|得|应该|先|正在|看下|看看|检查|确认|验证|测试|搜|找|读|写|查|思考|分析|认为|觉得|考虑|用了?|选(择|了|取|用)|准备|接下来|下面|来|尝试|开始|继续|用|使用|改|改用|改成)'
    -- 极短
    OR length(content) < 10
    -- dedup 空壳
    OR content LIKE '%[补充: |]%'
    OR content LIKE '%[补充: ]%'
    -- markdown 列表
    OR content LIKE '- %'
    OR content LIKE '* %'
    OR content LIKE '• %'
  )
ORDER BY id;

-- Step 2: 备份当前活跃记忆
-- （推荐先做这个！出错时可恢复）
-- $ sqlite3 ~/.dsh/memory.db ".backup /tmp/memory-pre-cleanup-$(date +%Y%m%d).db"

-- Step 3: 软删除
-- （review 上面 SELECT 列表，确认无重要内容后执行）
-- BEGIN;
-- UPDATE memories
-- SET    priority = 0, updated = CURRENT_TIMESTAMP
-- WHERE  priority > 0
--   AND (
--     content ~ '(我|咱们|我们)(需要|打算|想|要|得|应该|先|正在|看下|看看|检查|确认|验证|测试|搜|找|读|写|查|思考|分析|认为|觉得|考虑|用了?|选(择|了|取|用)|准备|接下来|下面|来|尝试|开始|继续|用|使用|改|改用|改成)'
--     OR length(content) < 10
--     OR content LIKE '%[补充: |]%'
--     OR content LIKE '%[补充: ]%'
--     OR content LIKE '- %'
--     OR content LIKE '* %'
--     OR content LIKE '• %'
--   );
-- COMMIT;

-- Step 4: 验证
-- SELECT COUNT(*) AS active FROM memories WHERE priority > 0;
-- SELECT COUNT(*) AS soft_deleted FROM memories WHERE priority = 0;

-- Step 5: 物理清理（可选，需先 review 软删除列表）
-- $ sqlite3 ~/.dsh/memory.db "DELETE FROM memories WHERE priority = 0;"

-- 恢复示例（如果误删）
-- UPDATE memories SET priority = 3, updated = CURRENT_TIMESTAMP WHERE id IN (1, 7, 35, ...);
