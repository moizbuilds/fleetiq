/**
 * AI maintenance-schedule generation — asks Claude to draft a full
 * maintenance schedule for a specific vehicle, tuned for Qatar/Gulf driving
 * conditions. Called from app/api/ai/schedule/route.ts (a live request) and
 * directly from Task 10's eval script (no network/Next.js request needed).
 *
 * WHY the Anthropic client is a PARAMETER (`client: Anthropic`) instead of
 * this file calling getAnthropic() itself: same dependency-injection
 * reasoning as lib/rate-limit.ts's injected db — Task 10's eval harness
 * needs to call this function directly, in a plain script, against the
 * real Anthropic API, without going through a Next.js request at all. If
 * this file reached for the singleton itself, an eval script would still
 * work (getAnthropic() doesn't need a request context), but every call site
 * would be hard-coupled to that one global instance instead of being
 * explicit about what it depends on.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { MODEL } from './client';
import { extractJson } from './parse';
import { aiScheduleSchema, type AiSchedule } from '../types';

// The ten maintenance categories every generated schedule must cover (see
// task-5-brief.md) — spelled out in the prompt itself so the model can't
// quietly drop one under token pressure.
const REQUIRED_CATEGORIES = [
  'oil change',
  'oil filter',
  'air filter',
  'cabin filter',
  'brake pads',
  'tyres',
  'battery',
  'coolant',
  'transmission fluid',
  'belts',
] as const;

export interface VehicleForSchedule {
  make: string | null;
  model: string | null;
  year: number | null;
  engine: string | null;
}

// Builds the vehicle description line from whatever fields are actually
// known — a manually-added vehicle with no VIN decode may be missing make/
// model/engine entirely, and the prompt should say so plainly rather than
// interpolate "null" into the sentence.
function describeVehicle(vehicle: VehicleForSchedule): string {
  const parts = [
    vehicle.year?.toString(),
    vehicle.make,
    vehicle.model,
    vehicle.engine ? `(${vehicle.engine} engine)` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' ') : 'a vehicle with no make/model/engine on file';
}

function buildPrompt(vehicle: VehicleForSchedule): string {
  return `Identify this vehicle and draft its recommended maintenance schedule: ${describeVehicle(vehicle)}.

Region context: Qatar (GCC): extreme heat, dusty conditions, mostly urban delivery driving. Adjust intervals for these conditions where it matters (e.g. shorter oil/filter/coolant intervals than a temperate-climate manual would suggest, tyre checks for heat-related pressure swings).

Cover ALL of the following maintenance categories, one item each: ${REQUIRED_CATEGORIES.join(', ')}.

For each item, provide:
- "name": the maintenance item's name
- "intervalKm": a positive integer distance interval in kilometers, or null if this item genuinely isn't tracked by distance
- "intervalMonths": a positive integer time interval in months, or null if this item genuinely isn't tracked by a calendar interval
  (at least one of intervalKm/intervalMonths must be a number — never both null)
- "brandRecommendations": 2-3 brand names commonly available in the Gulf/Qatar for this item
- "rationale": one line explaining the interval choice for this vehicle and climate

Respond with ONLY a JSON object of this exact shape, no other text, no markdown fence:
{"items": [{"name": string, "intervalKm": number | null, "intervalMonths": number | null, "brandRecommendations": string[], "rationale": string}, ...]}

Numbers must be numbers, not strings.`;
}

export async function generateSchedule(
  client: Anthropic,
  vehicle: VehicleForSchedule,
): Promise<AiSchedule> {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: buildPrompt(vehicle) }],
  });

  return extractJson(msg, aiScheduleSchema);
}
