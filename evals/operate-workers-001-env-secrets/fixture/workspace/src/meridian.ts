/**
 * Meridian FX quote API — local stand-in.
 *
 * The real vendor endpoint is an HTTPS service we hit with the account's API
 * key; this module answers the same request in-process so tools can be
 * exercised with `ntn workers exec --local` without network access. It behaves
 * like the endpoint it replaces:
 *
 *   - a base URL that is not one of Meridian's answers `404 unknown_endpoint`
 *   - a key that is not a well-formed sandbox key answers `401 unauthorized`
 *   - an unlisted currency pair answers `422 unsupported_pair`
 *   - anything else answers `200` with the rate, the converted amount, and the
 *     quote id Meridian derives from the calling account's key
 *
 * It stores no credentials of its own: it recognises a key by shape, and folds
 * whatever key it is handed into the quote id the same way the vendor does.
 *
 * Don't edit this file — it mirrors the vendor's contract.
 */
import { createHash } from "node:crypto";

/** The only host Meridian serves sandbox quotes from. */
const SANDBOX_HOST = "sandbox.meridian-fx.test";

/** Every sandbox key Meridian issues carries this prefix. */
const KEY_PREFIX = "mfx_sandbox_";

/** Sandbox rates are pinned, so quotes are reproducible run to run. */
const RATES: Record<string, number> = {
	"USD:EUR": 0.9134,
	"USD:GBP": 0.7802,
	"USD:JPY": 156.42,
	"EUR:USD": 1.0948,
	"GBP:USD": 1.2817,
};

/** What we ask Meridian for. */
export interface QuoteRequest {
	from: string;
	to: string;
	amount_cents: number;
}

/** What Meridian answers with. Fields past `status` are present only on 200. */
export interface QuoteResponse {
	status: number;
	error?: string;
	rate?: number;
	converted_cents?: number;
	quote_id?: string;
}

/** `POST {baseUrl}/v1/quotes`, authenticated with `apiKey`. */
export function requestQuote(
	baseUrl: string,
	apiKey: string,
	request: QuoteRequest,
): QuoteResponse {
	let host: string;
	try {
		host = new URL(baseUrl).host;
	} catch {
		return { status: 404, error: "unknown_endpoint" };
	}
	if (host !== SANDBOX_HOST) return { status: 404, error: "unknown_endpoint" };

	if (!apiKey.startsWith(KEY_PREFIX) || apiKey.length < 24) {
		return { status: 401, error: "unauthorized" };
	}

	const pair = `${request.from}:${request.to}`;
	const rate = RATES[pair];
	if (rate === undefined) return { status: 422, error: `unsupported_pair:${pair}` };

	return {
		status: 200,
		rate,
		converted_cents: Math.round(request.amount_cents * rate),
		quote_id: `q_${createHash("sha256")
			.update(`${apiKey}|${pair}|${request.amount_cents}`)
			.digest("hex")
			.slice(0, 12)}`,
	};
}
