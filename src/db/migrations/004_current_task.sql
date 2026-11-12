-- =============================================================================
-- 004: track the agent task an issue is currently waiting on
--
-- Set when the controller dispatches a coder or reviewer task and cleared by
-- every state transition. A NULL value on an IN_PROGRESS or UNDER_REVIEW issue
-- means no task is outstanding, so the controller dispatches one. Results are
-- only accepted when their task id matches this column.
-- =============================================================================

ALTER TABLE issues ADD COLUMN IF NOT EXISTS current_task_id UUID;

COMMENT ON COLUMN issues.current_task_id IS 'Task id of the agent work this issue is waiting on; NULL when none is outstanding.';
