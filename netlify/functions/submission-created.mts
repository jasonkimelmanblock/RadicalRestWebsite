// Netlify Forms trigger: fires whenever the "registration" form receives a
// verified submission. Each submission is persisted to the registrations
// table so that the booked room is reflected in /api/availability and the
// number of available rooms goes down.
import type { Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";

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

  const occupancy = toInt(d.occupancy) ?? 1;

  try {
    const db = getDatabase();
    await db.sql`
      INSERT INTO registrations (
        retreat, accommodation, occupancy,
        first_name, last_name, email, phone,
        guest2_first_name, guest2_last_name, guest2_email, guest2_phone,
        mattress, how_heard, notes, price, deposit
      ) VALUES (
        ${retreat}, ${accommodation}, ${occupancy},
        ${firstName}, ${lastName}, ${email}, ${clean(d.phone)},
        ${clean(d.guest2_first_name)}, ${clean(d.guest2_last_name)}, ${clean(d.guest2_email)}, ${clean(d.guest2_phone)},
        ${clean(d.mattress)}, ${clean(d.how_heard)}, ${clean(d.notes)}, ${toInt(d.price)}, ${toInt(d.deposit)}
      )
    `;
    return new Response("Registration stored", { status: 200 });
  } catch (err) {
    console.error("failed to persist registration", err);
    return new Response("Failed to store registration", { status: 500 });
  }
};
