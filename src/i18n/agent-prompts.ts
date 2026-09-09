// Agent-facing prompt payloads (NOT UI strings): these are sent to PI as
// instructions, so they stay zh regardless of the interface language. Living
// under src/i18n/ exempts them from the no-CJK guard by design.
export const PROMPT_WEEKLY_REPORT = '帮我根据本周的提交记录整理一份周报'
export const PROMPT_FIX_ERRORS = '帮我排查并修复项目里当前的报错'
export const PROMPT_MAKE_PPT = '帮我制作一份 PPT，主题：'
export const PROMPT_TIDY_DOCS = '帮我整理项目文档，顺便清理无用代码'
