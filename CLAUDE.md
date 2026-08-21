# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Delegation: Main Agent Does Not Write Code

**The main agent analyzes and plans. Sub-agents implement and review.**

The main agent MUST NOT call Write, Edit, or NotebookEdit on source code. Its job is:

1. **Analyze** — understand the request, read enough code to scope it, surface ambiguities and tradeoffs (Rule 1).
2. **Plan** — decompose into concrete steps with verification criteria (Rule 4).
3. **Delegate to `coder`** — hand off the plan via the Agent tool with `subagent_type: "coder"`. The handoff must include: the goal, the relevant file paths, the acceptance criteria, and any constraints or decisions already made. Do not make the coder re-derive what you already know.
4. **Delegate to `reviewer`** — once the coder reports back, hand the result to `subagent_type: "reviewer"`. Tell it what changed and what to focus on.
5. **Handle the verdict** —
   - *Approve* → report to the user.
   - *Request changes* → send the findings back to `coder` for a fix round, then re-review. Repeat until clean or until a finding needs a user decision.
6. **Report** — summarize to the user: what was built, how it was verified, what the review found, what remains.

The main agent MAY directly edit non-source files when that IS the task: config, docs, `.claude/` agent definitions, CLAUDE.md itself.

The main agent MAY skip delegation only for trivial one-line mechanical edits, and must say so explicitly when it does.

Never report a task complete on the coder's word alone — it must have passed review.

## 6. This Repo: Mandatory Build Steps After UI Edits

The static site in `ui/` ships prebuilt assets. After editing, run the matching build step YOURSELF as part of the task — never leave it to the user, and never report a task done with a stale artifact. (Full procedures: DEPLOY.md §4–5.)

| Change made | Required step |
|---|---|
| Added a Tailwind class not previously used anywhere in `ui/*.html` or in the three scanned scripts (`ui/assets/js/oak-api.js`, `oak-header.js`, `oak-i18n.js` — the customer header lives entirely in `oak-header.js`, so its classes come from there, not from the pages) | `cd tools/tailwind && npm install` (first time) `&& npm run build:css`, commit the regenerated `ui/assets/css/oak-tailwind.css` together with the HTML |
| Used a Material Symbols icon name not listed in `tools/icons/icon-names.txt` | Add the name to that file, regenerate the subset font per DEPLOY.md §5, commit both |
| Added an image | No build step — but compress it first (WebP/JPG, never a multi-MB PNG) and add `loading="lazy"` if it sits below the fold |

When unsure whether the CSS is stale, `npm run check:css` in `tools/tailwind/` answers without overwriting anything. There is no CI safety net: a missed rebuild ships silently as an unstyled element or a blank icon.

Gotcha: the Tailwind extractor scans `ui/*.html` as plain text, including comments — a bare utility word like "invisible" in a CSS/HTML comment emits that utility into the artifact and flips `check:css` to stale. If `check:css` goes stale after a comment-only edit, reword the comment instead of rebuilding.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.