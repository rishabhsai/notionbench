/**
 * Oracle for build-cli-001. QC only — never visible to an agent, never run
 * during a benchmark trial. See the header of ../EVAL.ts for why the oracle
 * uses `fetch` while the agent under test uses the `ntn` CLI.
 */
import { api, env, findPage, rt } from "../../_lib/live/oracle-fetch.mjs"

const { rootId } = env()
const handbook = await findPage(rootId, "Team Handbook")

const todo = (text) => ({
  object: "block",
  type: "to_do",
  to_do: { rich_text: rt(text), checked: false },
})

await api("post", "pages", {
  parent: { type: "page_id", page_id: handbook },
  icon: { type: "emoji", emoji: "🧭" },
  properties: { title: { title: rt("Onboarding Checklist") } },
  children: [
    todo("Read the team handbook"),
    todo("Set up the ntn CLI"),
    todo("Book a 1:1 with your manager"),
  ],
})
