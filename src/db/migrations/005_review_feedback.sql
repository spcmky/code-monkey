-- =============================================================================
-- 005: store the automated review an issue's rework must address
--
-- Written in the same transaction as the UNDER_REVIEW -> IN_PROGRESS
-- transition, so the feedback cannot be lost between the state change and
-- the coder's next run. The coder receives it in its task; the comment posted
-- on the pull request is for humans only.
-- =============================================================================

ALTER TABLE issues ADD COLUMN IF NOT EXISTS review_feedback TEXT;

COMMENT ON COLUMN issues.review_feedback IS 'Latest automated review that requested changes; given to the coder on rework.';
