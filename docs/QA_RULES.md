# QA rules

## Policy

The QA engine is deterministic pure TypeScript over a typed in-memory context. It does not ask a model whether a report is ready. The service adapter builds that context from the current project, sources, evidence, claims, questions, and latest deliverable, persists findings, and updates workflow state.

A finding blocks only when its severity is `BLOCKER`, but resolution is strict:

```text
BLOCKER + OPEN          -> blocks
BLOCKER + ACCEPTED_RISK -> blocks
BLOCKER + RESOLVED      -> clear
HIGH/MEDIUM/LOW         -> does not block the domain pass decision
```

Accepting risk records a decision for non-blocking findings. It is not a waiver for a blocker.

## Canonical rules

| Rule code | Severity | Trigger | Required remediation |
| --- | --- | --- | --- |
| `UNSOURCED_KEY_CLAIM` | BLOCKER | An included critical/high claim has no verified supporting evidence | Link and verify support, or remove the claim from the report |
| `INVALID_CITATION_ID` | BLOCKER | A citation ID is malformed, duplicated, or unknown to the project | Use one unique, well-formed ID for an existing source |
| `OUTDATED_SOURCE` | HIGH | A cited source is older than the project's maximum age | Replace it or explain why historical evidence is necessary |
| `DUPLICATE_SOURCE` | MEDIUM | A source declares a duplicate or shares a nonblank content hash | Retain a canonical source and relink evidence |
| `SOURCE_CONCENTRATION` | HIGH | At least three cited sources have publishers and one publisher supplies more than 50% | Add independent evidence or disclose the concentration |
| `UNRESOLVED_SOURCE_CONFLICT` | BLOCKER | Conflicting evidence is unresolved, or verified support/refutation has no recorded conflict | Resolve or explain the conflict and its effect on conclusions |
| `FACT_INFERENCE_MIX` | HIGH | A report statement is classified as mixed fact and inference | Split and label the factual and inferential statements |
| `UNSUPPORTED_NUMBER` | BLOCKER | A numeric assertion lacks verified evidence | Link verified evidence or remove the number |
| `DATE_OR_UNIT_MISMATCH` | HIGH | A quantitative assertion's date or unit differs from its source evidence | Correct the date/unit and recheck the statement |
| `OUT_OF_SCOPE_CONTENT` | HIGH | A report statement is outside the approved scope | Remove it or explicitly expand and reapprove scope |
| `UNREFERENCED_SOURCE` | LOW | A project source is not cited in the report | Cite it where used or remove it from the delivery source list |
| `SOURCE_NUMBER_MISMATCH` | BLOCKER | A reported numeric value differs from its source evidence | Correct the value and dependent calculations |
| `OPEN_RESEARCH_GAP` | BLOCKER | A question's gap state is `OPEN` | Resolve it or explicitly accept and disclose the limitation |
| `EMPTY_REQUIRED_SECTION` | BLOCKER | A required report section is blank | Complete the section before requesting approval |

## Citation IDs

A domain citation ID must:

- be a string of 1–128 characters;
- start with an ASCII letter or digit;
- contain only ASCII letters, digits, `.`, `_`, `:`, or `-` afterward;
- exist in the known source-ID set;
- appear only once in the list being validated.

Malformed, unknown, and duplicate problems are reported independently. A value can therefore yield more than one issue (for example, duplicated and unknown). This duplicate rule applies to structured provider/domain ID lists, where each identifier represents one selected source. Reusing the same valid source citation at multiple places in report prose is legal.

## Freshness and claim support

Freshness uses whole UTC dates relative to the project's research date:

- missing or future publication date → `UNKNOWN`
- age greater than `source_max_age_days` → `OUTDATED`
- age at or beyond the final 20% of the allowed window → `AGING`
- otherwise → `CURRENT`

Only `VERIFIED` evidence with `SUPPORTS` or `REFUTES` affects support status. Context-only, pending, and rejected evidence does not prove a claim. Support/refutation conflict takes precedence over age; otherwise all-outdated support yields `OUTDATED`.

## Required report sections

The service requires nonblank content for research purpose, executive summary, research scope, methodology, key findings, detailed analysis, risks and limitations, recommendations, and references. Comparison table and appendix are optional.

## Persistence behavior

On each QA run, the service:

1. Loads the latest deliverable and project graph.
2. Runs all canonical rules.
3. Deletes only prior `OPEN` findings tagged `generatedBy: qa-engine`.
4. Inserts the new findings as `OPEN`.
5. Sets `qa_passed_at` and `APPROVAL_REQUIRED` when no blocker exists; otherwise clears the pass and sets `QA`.
6. Records a `QA_PASSED` or `QA_BLOCKED` audit event.
7. Refreshes progress.

Historical resolved/manual findings remain. Changing a finding status does not silently rewrite report, evidence, or claim content; fix the underlying problem and rerun QA.

## Current service normalization

The pure engine accepts explicit normalized statements and quantitative comparisons. The database adapter currently derives them with bounded heuristics:

- Citations are bracketed tokens extracted from report sections, such as `[source-demo-2]`.
- The adapter intentionally deduplicates report citation occurrences into a set of referenced sources. Repeating `[source-id]` in prose is valid; structured provider/source-ID lists are validated separately and reject duplicate entries.
- Fact/inference and scope statements come from report-included claims. Claim creation/review stores explicit classification and `within_scope`; cross-project question IDs are rejected.
- Quantitative assertions come from included claim text and from prose in the six decision-bearing report sections. Numbers are simple decimal tokens; units use a small allowlist (`percent`, `hour`, `day`, `month`, `year`, `usd`, `dollar`, `kg`, `km`).
- Numeric/date/unit comparison aggregates verified supporting evidence selected by a matching claim or cited source. Publication dates and evidence text are parsed directly; no magic resolution-note token changes a comparison.
- A conflict is derived only when verified links both support and refute a claim; nonblank resolution notes mark the conflict resolved.
- Arbitrary prose typed directly into report sections is checked for citations and quantitative assertions, but fact/inference and approved-scope classification still rely on the normalized claim ledger. Unlinked prose therefore cannot receive those two semantic classifications automatically in this MVP.

These bounded heuristics should be treated as known limits, not as reasons to weaken the rules. Production use needs a richer statement-to-claim mapping and domain-specific unit/date normalization without delegating pass/fail authority to a model.

## Verification expectations

- Pure unit tests should exercise every rule, multiple simultaneous findings, exact severity, citation issue types, freshness boundaries, support/refutation combinations, open-gap counts, and accepted-risk blocker semantics.
- Service integration tests should prove context construction, finding replacement/preservation, status changes, audit rows, and progress refresh against PostgreSQL.
- Browser tests should prove a user can locate, remediate, resolve, rerun, and understand blocker state.
- Approval/export tests must attempt to bypass QA and accepted-risk blockers, not merely inspect stored status fields.
