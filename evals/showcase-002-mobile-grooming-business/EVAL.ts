/**
 * showcase-002-mobile-grooming-business — an exhibition placard. Always scores 1.
 *
 * This is not a scorer and must never behave like one. The gallery is judged by
 * people looking at screenshots; the job here is to produce the caption that
 * goes underneath one, from the workspace the agent actually built.
 *
 * Two kinds of number come out, and the split is deliberate:
 *
 *   - **subscores** are the element checklist — one 0/1 per part of the
 *     owner's problem (clients, appointments, the link between them, repeat
 *     visits, supplies, van servicing, the money question). Objective, and
 *     *unscored*: `score` is 1 no matter how many are 0. They exist so a
 *     placard can say "10 of 13 elements" without anyone having to count.
 *   - **counts** — pages, databases, rows, views, rollups — go into a single
 *     machine-readable `PLACARD {…}` diagnostic line rather than into
 *     subscores, because `packages/core`'s results schema constrains every
 *     subscore to [0, 1] and a workspace with 40 blocks is not a fraction.
 *     Parse that line; do not widen the schema for an exhibition.
 *
 * Every check below is generous about naming and shape, on purpose. The prompt
 * prescribes no structure, so the honest question is "did they model this part
 * of the problem at all", not "did they call it what we expected". A supplies
 * database is as likely to be called Stock, Products or Kit as Inventory, and
 * "every four weeks" is legitimately modelled as a property, a template or a
 * sentence in a written page. Each check documents the shapes it accepts, so a
 * gallery caption that says `recurring_handled ✓` can be trusted.
 *
 * Failure is not a failure state. If there is no token, no root page, or the
 * workspace has been torn down already, the placard says so and the score is
 * still 1 — an exhibition entry that could not be measured is a missing
 * caption, not a lost run.
 */
import { resolveLiveContext } from "../_lib/live/context.ts"
import {
  DATEISH,
  describe,
  describeChecklist,
  emptySurvey,
  hasGroupedView,
  hasOptionLike,
  hasPropertyNamed,
  hasPropertyType,
  mentions,
  pickByTitleThenShape,
  related,
  survey,
  titleMatches,
  type Survey,
  type SurveyDatabase,
} from "../_lib/live/showcase.ts"
import type { EvalArgs, EvalResult } from "../_lib/types.ts"

// ---------------------------------------------------------------------------
// Which database is which
//
// Each finder is title-OR-structure: a fuzzy title match is enough on its own,
// and so is the property shape, so an agent that names nothing the way we
// guessed still gets credit for the architecture. First match in workspace
// order wins.
// ---------------------------------------------------------------------------

/**
 * The client book. Accepts clients/customers/dogs/pets/owners/contacts by
 * title, or any database carrying contact-shaped properties (phone, mobile,
 * email, address, postcode) — which is what a client record is regardless of
 * what it is called. "Dogs" and "Clients" are both fine, and an agent that
 * split them gets matched on whichever comes first.
 */
function findClients(databases: SurveyDatabase[]): SurveyDatabase | undefined {
  const contact = /phone|mobile|email|address|postcode|zip|contact|breed|\bdogs?\b|\bpets?\b/
  return pickByTitleThenShape(
    databases,
    (db) => titleMatches(db, /client|customer|dog|pet|owner|contact|people|househol/),
    (db) => hasPropertyNamed(db, contact),
  )
}

/**
 * The diary. Accepts appointments/bookings/schedule/visits/grooms/jobs/routes
 * by title, or any *other* database with a date-ish property plus something
 * that reads like a job (van, groomer, service, duration, slot, status) —
 * that is an appointment however it is spelled.
 */
function findAppointments(
  databases: SurveyDatabase[],
  clients: SurveyDatabase | undefined,
): SurveyDatabase | undefined {
  const jobish = /\bvans?\b|vehicle|groomer|staff|service|duration|slot|time|status|price|assign/
  return pickByTitleThenShape(
    databases,
    (db) => titleMatches(db, /appoint|booking|book|schedul|visit|groom|job|route|diary|calendar/),
    (db) => db.id !== clients?.id && hasPropertyType(db, DATEISH) && hasPropertyNamed(db, jobish),
  )
}

/**
 * The van cupboard. Accepts supplies/inventory/stock/products/shampoo/
 * consumables/kit/orders-to-place by title, or any database with a
 * stock-shaped property (on hand, in stock, qty, reorder, restock, low, par,
 * unit). Never the clients or appointments database.
 */
function findSupplies(
  databases: SurveyDatabase[],
  used: Array<SurveyDatabase | undefined>,
): SurveyDatabase | undefined {
  const stock = /on hand|in stock|stock|qty|quantity|reorder|restock|low|par level|unit|supplier/
  const named = /suppl|inventor|stock|shampoo|product|consumab|kit|restock|shop|equipment|material/
  const taken = new Set(used.filter(Boolean).map((db) => (db as SurveyDatabase).id))
  const free = (db: SurveyDatabase) => !taken.has(db.id)
  return pickByTitleThenShape(
    databases,
    (db) => free(db) && titleMatches(db, named),
    (db) => free(db) && hasPropertyNamed(db, stock),
  )
}

/** The elements the owner's problem calls for. Reported, never enforced. */
function checklist(s: Survey): Record<string, number> {
  const p = s.placard
  const clients = findClients(s.databases)
  const appointments = findAppointments(s.databases, clients)
  const supplies = findSupplies(s.databases, [clients, appointments])

  // Repeat visits. Notion models this three legitimate ways and the prompt
  // names none of them, so any of the three passes:
  //   - a property or select option that reads as a cadence — recurring,
  //     repeat, frequency, interval, weekly, 4 weeks, regular, standing,
  //     next visit, rebook;
  //   - a page whose title says template/recurring/regulars;
  //   - the convention written down in prose ("regulars are every four weeks;
  //     rebook at the door"), which is a real answer a property-only check
  //     would caption as a miss.
  // The prose arm uses a tighter pattern than the property arm on purpose: a
  // column called "Frequency" is unambiguous, the word "every" in a sentence
  // is not.
  const cadenceProp = /recur|repeat|frequen|cadence|interval|weekly|4 ?week|four.week|regular|standing|rebook|next (visit|appointment|groom)/
  const cadenceProse = /recurring|repeat (visit|client|customer|book)|rebook|every (four|4|two|2|six|6|three|3|eight|8) weeks|standing (appointment|slot|booking)|regulars/
  const recurring =
    s.databases.some((db) => hasPropertyNamed(db, cadenceProp) || hasOptionLike(db, cadenceProp)) ||
    s.pages.some((page) =>
      /template|recurring|regular|standing|rebook/.test(page.title.toLowerCase()),
    ) ||
    mentions(s, cadenceProse)

  // Van servicing. Passes on either:
  //   - upkeep vocabulary in a *structural* place — a database title, a page
  //     title or a property name: "Servicing", "Next service", "MOT", "Mileage",
  //     "Oil change", "Road tax". In a dog-grooming workspace a structural
  //     element with those words is about the vans and nothing else;
  //   - or van/vehicle/fleet words plus upkeep words in the written prose,
  //     for the agent who documented the routine instead of tabulating it.
  // The upkeep pattern deliberately does not match a bare "Service": in this
  // business that column means the groom package, not the garage. "Servicing",
  // "Service due" and "Next service" do match.
  const vehicleWord = /\bvans?\b|\bvehicles?\b|\bfleet\b|\btrucks?\b/
  const upkeep = /maintenance|servicing|service (due|date|history|log|interval|reminder)|next service|\bmot\b|mileage|oil change|\btyres?\b|\btires?\b|road tax|inspection|breakdown|garage/
  const structuralUpkeep =
    s.databases.some((db) => titleMatches(db, upkeep) || hasPropertyNamed(db, upkeep)) ||
    s.pages.some((page) => upkeep.test(page.title.toLowerCase()))
  const writtenUpkeep = mentions(s, vehicleWord) && upkeep.test(s.text.toLowerCase())

  // Money math. Any rollup at all counts (a rollup exists to aggregate, and
  // there is nothing else here to aggregate but money and visits), as does a
  // formula or number property whose name reads financial.
  const money = /price|cost|total|revenue|amount|paid|charge|fee|income|profit|margin|takings|£|\$|€/
  const revenue =
    p.rollups >= 1 ||
    s.databases.some((db) =>
      db.properties.some(
        (prop) =>
          (prop.type === "formula" || prop.type === "rollup" || prop.type === "number") &&
          money.test(prop.name.toLowerCase()),
      ),
    )

  return {
    // Any child page under the sandbox root. The root itself is not counted —
    // an agent that dumped everything onto the root page built no home.
    home_page: p.pages >= 1 ? 1 : 0,
    // See findClients.
    clients_db: clients ? 1 : 0,
    // See findAppointments.
    appointments_db: appointments ? 1 : 0,
    // A relation whose target is the other database — or, where the API omits
    // the relation target, either database carrying any relation or rollup.
    clients_appointments_related: related(clients, appointments) ? 1 : 0,
    // Cadence modelled as a property, a template page, or a written convention.
    recurring_handled: recurring ? 1 : 0,
    // See findSupplies.
    inventory_or_supplies_db: supplies ? 1 : 0,
    // Upkeep named structurally, or vans-plus-upkeep written down; see above.
    vehicle_maintenance: structuralUpkeep || writtenUpkeep ? 1 : 0,
    // A calendar view anywhere. Timeline counts: for "which dog, when, which
    // van" it answers the same question, and refusing it would grade
    // view-picking rather than whether the diary is legible.
    calendar_view: p.calendar_views + p.timeline_views >= 1 ? 1 : 0,
    // A board view, or any view whose configuration groups rows — a table
    // grouped by van or by status is the same idea drawn differently.
    board_or_status_view: p.board_views >= 1 || hasGroupedView(s.views) ? 1 : 0,
    // See the money-math comment above.
    revenue_rollup: revenue ? 1 : 0,
    // Real prose: 300+ characters of block text across 6+ text-bearing blocks,
    // with at least one paragraph-length run. Deliberately not "10 blocks" —
    // ten empty dividers are not writing.
    written_content: s.text.length >= 300 && s.textBlocks >= 6 && s.longestBlock >= 60 ? 1 : 0,
    // Seeded example data, anywhere. Empty databases photograph as abandoned.
    populated_rows: p.rows >= 8 ? 1 : 0,
    // Emoji icons on 3+ pages or databases.
    icons: p.icons >= 3 ? 1 : 0,
  }
}

/** Extra colour for the caption — never a check, just something to read. */
function flavour(s: Survey): string {
  const bits: string[] = []
  const clients = findClients(s.databases)
  if (clients) bits.push(`clients: "${clients.title}" (${clients.rows} row(s))`)
  const appointments = findAppointments(s.databases, clients)
  if (appointments) bits.push(`appointments: "${appointments.title}" (${appointments.rows} row(s))`)
  const supplies = findSupplies(s.databases, [clients, appointments])
  if (supplies) bits.push(`supplies: "${supplies.title}" (${supplies.rows} row(s))`)
  if (s.databases.length > 0) {
    bits.push(`databases: ${s.databases.map((db) => `"${db.title}"`).join(", ")}`)
  }
  return bits.join(" · ") || "nothing found under the sandbox root"
}

export default async function evaluate({ workspaceDir, ctx }: EvalArgs): Promise<EvalResult> {
  const diagnostics: string[] = []
  let s = emptySurvey()

  try {
    const live = await resolveLiveContext({ workspaceDir, ctx })
    diagnostics.push(`api=${live.apiBase} root=${live.rootId} (${live.source.root})`)
    s = await survey(live.client, live.rootId)
  } catch (err) {
    diagnostics.push(
      `placard not measured: ${(err as Error).message} — the exhibition entry still stands, it just has no caption`,
    )
  }

  const checks = checklist(s)
  diagnostics.push(`PLACARD ${JSON.stringify(s.placard)}`)
  diagnostics.push(describe(s.placard))
  diagnostics.push(flavour(s))
  diagnostics.push(describeChecklist(checks))
  diagnostics.push("exhibition entry: unscored by construction, judged by people")

  return { score: 1, subscores: checks, diagnostics }
}
