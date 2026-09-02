-- AquaRoute E3.10: conflict review workflow semantics.
-- resolution = merge-time RECOMMENDATION (immutable audit of what merge chose).
-- status     = human REVIEW state (open → accepted | rejected | deferred).
-- Does NOT apply geometry changes. Does NOT rewrite historical resolution values
-- except retiring 'deferred' from the resolution domain (moved to status).

ALTER TABLE water.object_conflicts
  DROP CONSTRAINT IF EXISTS object_conflicts_status_check;

ALTER TABLE water.object_conflicts
  DROP CONSTRAINT IF EXISTS object_conflicts_resolution_check;

-- Legacy status aliases → review workflow
UPDATE water.object_conflicts
SET status = 'accepted'
WHERE status = 'resolved';

UPDATE water.object_conflicts
SET status = 'rejected'
WHERE status = 'ignored';

-- 'deferred' belongs to review status, not recommendation
UPDATE water.object_conflicts
SET status = 'deferred',
    resolution = CASE
      WHEN resolution = 'deferred' THEN 'keep_canonical'
      ELSE resolution
    END
WHERE resolution = 'deferred';

ALTER TABLE water.object_conflicts
  ADD CONSTRAINT object_conflicts_resolution_check
  CHECK (resolution IN (
    'keep_canonical', 'take_incoming', 'merged'
  ));

ALTER TABLE water.object_conflicts
  ADD CONSTRAINT object_conflicts_status_check
  CHECK (status IN (
    'open', 'accepted', 'rejected', 'deferred'
  ));

ALTER TABLE water.object_conflicts
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE water.object_conflicts
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

COMMENT ON COLUMN water.object_conflicts.resolution IS
  'E3.10: merge-time RECOMMENDATION only (keep_canonical / take_incoming / merged). '
  'Not a final human decision. Applying recommendation to canonical is a separate '
  'explicit operation (not implemented in E3.10 for safety).';

COMMENT ON COLUMN water.object_conflicts.status IS
  'E3.10 human review workflow: open → accepted | rejected | deferred. '
  'accept/reject refers to the recommendation, not silent geometry mutation.';

COMMENT ON COLUMN water.object_conflicts.reviewed_at IS
  'When a human set status to accepted/rejected/deferred.';

COMMENT ON COLUMN water.object_conflicts.review_notes IS
  'Optional human rationale for the review decision.';
