// Admin API for managing stored registrations.
//
//   GET    /api/registrations        -> list every registration
//   DELETE /api/registrations/:id     -> cancel one registration (frees its room)
//
// Why this exists: new bookings flow in through Netlify Forms and are mirrored
// into the `registrations` table by submission-created.mts, which is what
// /api/availability counts. Netlify Forms does not notify the site when a
// submission is deleted in the Forms UI, and submissions cannot be read back
// from the Forms API at runtime — so deletions there can never reach the
// database, and the booked room stays held forever. This endpoint makes the
// database (the source of truth for availability) directly manageable, so an
// administrator can release a room by cancelling its registration here.
//
// Cancelling sets status = 'cancelled' rather than deleting the row, so the
// record is preserved for reference; /api/availability already ignores any row
// whose status is 'cancelled', so the room becomes available immediately.
import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { createHash, timingSafeEqual } from "node:crypto";

// Compare two secrets without leaking length/contents through timing. Hashing
// first lets timingSafeEqual operate on equal-length buffers.
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Returns null when the request is authorised, or a Response to send back.
function checkAuth(req: Request): Response | null {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return Response.json(
      {
        error:
          "Admin access is not configured. Set an ADMIN_PASSWORD environment variable for this site in the Netlify UI, then reload this page.",
      },
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !secretsMatch(provided, expected)) {
    return Response.json({ error: "Incorrect admin password." }, { status: 401 });
  }
  return null;
}

export default async (req: Request, context: Context) => {
  const denied = checkAuth(req);
  if (denied) return denied;

  const db = getDatabase();

  try {
    if (req.method === "GET") {
      const rows = await db.sql`
        SELECT id, retreat, accommodation, occupancy,
               first_name, last_name, email, phone, status, created_at
        FROM registrations
        ORDER BY created_at DESC, id DESC
      `;
      return Response.json(
        { registrations: rows },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (req.method === "DELETE") {
      const id = Number(context.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return Response.json({ error: "Invalid registration id." }, { status: 400 });
      }
      const updated = await db.sql`
        UPDATE registrations
        SET status = 'cancelled'
        WHERE id = ${id} AND status <> 'cancelled'
        RETURNING id
      `;
      if (updated.length === 0) {
        return Response.json(
          { error: "Registration not found or already cancelled." },
          { status: 404 },
        );
      }
      return Response.json({ ok: true, id });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (err) {
    console.error("registrations admin error", err);
    return new Response("Failed to manage registrations", { status: 500 });
  }
};

export const config: Config = {
  path: ["/api/registrations", "/api/registrations/:id"],
};
