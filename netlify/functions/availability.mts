// GET /api/availability
// Returns live room availability for every retreat date, derived from the
// number of confirmed registrations currently stored in the database.
import type { Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { buildAvailability } from "../lib/retreats.mjs";

export default async () => {
  try {
    const db = getDatabase();
    const counts = await db.sql`
      SELECT retreat, accommodation, COUNT(*)::int AS taken
      FROM (
        SELECT retreat, accommodation FROM registrations WHERE status <> 'cancelled'
        UNION ALL
        SELECT retreat, accommodation FROM registration_checkouts
        WHERE registration_id IS NULL AND hold_until > now()
      ) AS occupied
      GROUP BY retreat, accommodation
    `;

    const payload = buildAvailability(counts);
    return Response.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("availability error", err);
    return new Response("Failed to load availability", { status: 500 });
  }
};

export const config: Config = {
  path: "/api/availability",
};
