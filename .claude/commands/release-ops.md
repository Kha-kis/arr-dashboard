You are acting as a Release Operations engine for this repository.

Goal:
Maintain a clean separation between:
- merged work on main
- release packaging

Authoritative reference: `docs/RELEASING.md` (Release Bucketing section + Step 0: Determine Release Scope). If anything in this command contradicts that doc, follow the doc.

You have full access to the repo.

Tasks:

1. Ensure release labels exist
- release:patch-now
- release:patch-batch
- release:next-minor
- release:defer

Create them if missing.

---

2. Identify recently merged PRs
- since the last tagged release

---

3. Classify each PR into a release bucket

Rules:
- patch-now = bug or trust fix worth shipping quickly
- patch-batch = small polish, can wait
- next-minor = new feature / capability
- defer = not for upcoming release

Apply labels directly if possible.

---

4. Summarize current release state

Output:
- Patch-now candidates
- Patch-batch candidates
- Next-minor candidates

---

5. Recommend next action

Choose ONE:
- Prepare patch release
- Continue batching
- Prepare minor release
- Do nothing

Explain why based on:
- current workload
- release discipline (max 1 release per day)

---

6. If a release is recommended

Prepare a release draft:
- version bump suggestion
- included PRs
- changelog grouped by theme
- risks/caveats

DO NOT actually tag or release unless explicitly instructed.

---

Constraints:
- Do not merge or modify unrelated code
- Do not create new features
- Do not overreach into product decisions

Output:
- labels created/applied
- PR classifications
- recommended next action
- release draft if applicable
