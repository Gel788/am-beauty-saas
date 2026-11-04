-- Phase 4 · NET-*: several branches in one salon network.

-- NET-SWITCH-01: the branch a user works in right now (the shell switcher).
ALTER TABLE user_preferences ADD COLUMN current_branch_id uuid REFERENCES branches (id) ON DELETE SET NULL;

-- NET-BRANCH-01: a phone per branch (address and timezone already exist).
ALTER TABLE branches ADD COLUMN phone text NOT NULL DEFAULT '';
