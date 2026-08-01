/**
 * Plausibly-wrong solution for build-cli-001: everything correct except the
 * parent — the page is created next to the handbook, on the sandbox root,
 * because "create a page in the sandbox" is the path of least resistance once
 * you have the root id from `notionbench.json`. Must score 0.
 */
import { api, env, rt } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()

const todo = (text) => ({
  object: "block",
  type: "to_do",
  to_do: { rich_text: rt(text), checked: false },
})

await api("post", "pages", {
  parent: { type: "page_id", page_id: rootId },
  icon: { type: "emoji", emoji: "🧭" },
  properties: { title: { title: rt("Onboarding Checklist") } },
  children: [
    todo("Read the team handbook"),
    todo("Set up the ntn CLI"),
    todo("Book a 1:1 with your manager"),
  ],
})
