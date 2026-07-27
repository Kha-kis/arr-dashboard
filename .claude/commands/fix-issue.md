Fix GitHub issue $ARGUMENTS

1. Read the issue and its comments with `gh issue view $ARGUMENTS`.
2. Record the reported version, deployment, database, connected services,
   exact expected behavior, actual behavior, and supplied evidence.
3. Determine the release line before editing:
   - stable 2.x maintenance targets `main`;
   - 3.0 beta work targets `next`;
   - if both are affected, reproduce both and plan a stable fix plus a separate
     forward-port.
4. Fetch the intended base. Confirm the working tree and current branch contain
   no unrelated work. Create a focused task branch from the intended base when
   necessary; never edit `main` or `next` directly.
5. Reproduce the reporter's actual scenario. If it cannot be reproduced,
   continue diagnosis and describe the missing evidence; do not claim a fix.
6. Trace the root cause through the real data and mutation path. Do not patch a
   plausible symptom without proving why it occurs.
7. Write a regression test that fails for the reported scenario, then implement
   the smallest coherent fix.
8. If the issue touches deletion, file removal, unmonitoring, restore, cleanup,
   schema changes, or an upstream write, run the `data-safety-reviewer` agent.
9. Run focused tests while iterating, then `/validate`. Live-verify
   user-visible behavior in a browser when applicable.
10. Report the diff, risks, validation, and whether a forward-port or patch
    release is required.

Do not commit, push, open a PR, close the issue, or post an issue comment unless
the user asks for that action. A future PR may use standalone `Closes #N` only
after the exact reported scenario was reproduced and verified; otherwise use
`Related to #N`.
