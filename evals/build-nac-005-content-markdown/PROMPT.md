---
id: build-nac-005-content-markdown
title: Author a page of structured Notion content from supplied copy
suite: benchmark
family: nac
stage: build
topics: [markdown, page-content, callouts, toggles, tables]
difficulty: L3
runtime: offline
fixture: none
verify: [static, intents]
limits: { time: 900, cost: 3.0 }
---

I've written the copy for our on-call handbook and I want the page generated
from this project rather than pasted in by hand — every region gets its own copy
and I'm not maintaining four of them. Please write it into `src/main.ts`.

A teamspace **Engineering**, open access, on the anchor that's already at the
top of the file (the workspace exists). One page in it, titled **On-call
handbook**, with the 📟 emoji as its icon. No databases, no other pages.

The page content, in order, using real Notion blocks — I want this to look like
a handbook in Notion, not like a README:

1. A **callout** with the 🚨 icon reading:
   `Page the incident lead **before** you touch production.` (the word *before*
   is bold).

2. A heading-2: `Severity ladder`.

3. A **table** with a header row (and no other table options set), three
   columns, four rows:

   | Severity | Response time     | Who to wake                         |
   | -------- | ----------------- | ----------------------------------- |
   | Sev 1    | 5 minutes         | Incident lead and platform on-call  |
   | Sev 2    | 30 minutes        | Platform on-call                    |
   | Sev 3    | Next business day | Nobody, file a ticket               |

4. A heading-2: `First fifteen minutes`.

5. A **bulleted list**, where the second level really is nested under the first:

   - Acknowledge the page in the alerting channel
     - Say your name so nobody double-responds
     - Start a thread for the timeline
   - Read the status dashboard before you read any code
     - Error rate
     - Latency p99
     - Queue depth
   - Say the severity out loud and write it in the thread

6. A heading-2: `When you are stuck`.

7. Two **toggles**, collapsed sections people open only when they need them:

   - Summary `You cannot reach the incident lead`, containing:
     `Escalate to the engineering manager on the rotation, then to the VP. Do
     not sit on a Sev 1 waiting for a reply.`
   - Summary `The dashboard itself is down`, containing:
     `Treat it as a Sev 2 until proven otherwise and fall back to the raw
     metrics endpoint.`

8. A closing **callout** with the 📝 icon reading:
   `Write the timeline as you go. Reconstructing it afterwards always loses the
   detail that mattered.`

Use the flavour of Markdown this project's page content actually expects — the
callouts, toggles and table need to come out as those block types in Notion, not
as paragraphs that happen to start with an emoji. The wording above is final
copy, so please keep it exactly as written.

`npm run build` should succeed and `dist/intents.json` should describe exactly
that page.
