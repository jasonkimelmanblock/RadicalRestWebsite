// Netlify Forms trigger: fires whenever the "registration" form receives a
// verified submission. Each submission is persisted to the registrations
// table so that the booked room is reflected in /api/availability and the
// number of available rooms goes down.
import type { Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { ENSUITE, SHARED_SINGLE_BED, maxOccupancy } from "../lib/retreats.mjs";

interface FormPayload {
  form_name: string;
  data: Record<string, string>;
}

// Coerce a form string to a positive integer, or null when absent/invalid.
function toInt(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const n = parseInt(String(value).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// Checkboxes only appear in the submission when they were ticked.
function checked(value: string | undefined): boolean {
  return value != null && String(value).trim() !== "";
}

// Accept only an ISO yyyy-mm-dd date (what <input type="date"> sends).
function isoDate(value: string | undefined): string | null {
  const v = clean(value);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function clean(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

export default async (req: Request, _context: Context) => {
  let payload: FormPayload | undefined;
  try {
    ({ payload } = (await req.json()) as { payload: FormPayload });
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Only handle the registration form.
  if (!payload || payload.form_name !== "registration") {
    return new Response("Ignored", { status: 200 });
  }

  const d = payload.data || {};

  const retreat = clean(d.retreat);
  const accommodation = clean(d.accommodation);
  const firstName = clean(d.first_name);
  const lastName = clean(d.last_name);
  const email = clean(d.email);

  // Required fields — without these the registration is meaningless.
  if (!retreat || !accommodation || !firstName || !lastName || !email) {
    console.warn("registration submission missing required fields", {
      retreat,
      accommodation,
      hasName: !!(firstName && lastName),
      hasEmail: !!email,
    });
    return new Response("Missing required fields", { status: 200 });
  }

  const requested = toInt(d.occupancy) || 1;
  const occupancy = Math.min(Math.max(requested, 1), maxOccupancy(accommodation));
  // A solo guest in the ensuite always reserves a single bed in a shared room.
  const mattress =
    accommodation === ENSUITE && occupancy === 1 ? SHARED_SINGLE_BED : clean(d.mattress);
  const waiverAccepted = checked(d.waiver_read_understood) && checked(d.waiver_adult) &&
    checked(d.waiver_voluntary) && checked(d.waiver_maryland_law);
  // Calculate the deposit on the server instead of trusting submitted prices.
  const deposit = 100 * occupancy;

  try {
    const db = getDatabase();
    await db.sql`
      INSERT INTO registrations (
        retreat, accommodation, occupancy,
        first_name, last_name, email, phone,
        guest2_first_name, guest2_last_name, guest2_email, guest2_phone,
        guest3_first_name, guest3_last_name, guest3_email, guest3_phone,
        mattress, how_heard, notes, price, deposit,
        date_of_birth, emergency_contact_name, emergency_contact_phone,
        dietary_restrictions, accommodation_requests, medical_conditions,
        motivation, questions,
        commit_full_attendance, commit_tech_free, waiver_accepted, waiver_accepted_at
      ) VALUES (
        ${retreat}, ${accommodation}, ${occupancy},
        ${firstName}, ${lastName}, ${email}, ${clean(d.phone)},
        ${occupancy >= 2 ? clean(d.guest2_first_name) : null}, ${occupancy >= 2 ? clean(d.guest2_last_name) : null},
        ${occupancy >= 2 ? clean(d.guest2_email) : null}, ${occupancy >= 2 ? clean(d.guest2_phone) : null},
        ${occupancy >= 3 ? clean(d.guest3_first_name) : null}, ${occupancy >= 3 ? clean(d.guest3_last_name) : null},
        ${occupancy >= 3 ? clean(d.guest3_email) : null}, ${occupancy >= 3 ? clean(d.guest3_phone) : null},
        ${mattress}, ${clean(d.how_heard)}, ${clean(d.notes)}, ${deposit}, ${deposit},
        ${isoDate(d.date_of_birth)}, ${clean(d.emergency_contact_name)}, ${clean(d.emergency_contact_phone)},
        ${clean(d.dietary_restrictions)}, ${clean(d.accommodation_requests)}, ${clean(d.medical_conditions)},
        ${clean(d.motivation)}, ${clean(d.questions)},
        ${checked(d.commit_full_attendance)}, ${checked(d.commit_tech_free)},
        ${waiverAccepted}, ${waiverAccepted ? new Date().toISOString() : null}
      )
    `;
    return new Response("Registration stored", { status: 200 });
  } catch (err) {
    console.error("failed to persist registration", err);
    return new Response("Failed to store registration", { status: 500 });
  }
};
