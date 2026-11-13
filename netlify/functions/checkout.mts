import type { Config } from '@netlify/functions';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { ACCOMMODATIONS } from '../lib/retreats.mjs';
import { validateBooking, stripeRequest, confirmPayment, ensurePaymentNotifications } from '../lib/payments.mjs';

export default async (req: Request) => {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (req.method === 'GET') {
      const id = new URL(req.url).searchParams.get('session_id') || '';
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return Response.json({ error: 'Invalid payment session.' }, { status: 400, headers });
      const session = await stripeRequest('checkout/sessions/' + encodeURIComponent(id));
      return Response.json(await confirmPayment(session), { headers });
    }
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!Netlify.env.get('STRIPE_SECRET_KEY')) return Response.json({ error: 'Payments are temporarily unavailable. Please try again later.' }, { status: 503, headers });
    let d;
    try {
      const input = await req.json();
      if (input['bot-field']) return new Response('Invalid submission', { status: 400 });
      d = validateBooking(input);
    } catch (err) { return Response.json({ error: err instanceof Error ? err.message : 'Invalid registration.' }, { status: 400, headers }); }
    const origin = new URL(req.url).origin;
    await ensurePaymentNotifications(origin);
    const id = randomUUID();
    const expires = Math.floor(Date.now() / 1000) + 1860;
    const client = await getDatabase().pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize room holds, so simultaneous checkouts cannot sell the same last room.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [d.retreat + ':' + d.accommodation]);
      const count = await client.query(`SELECT (SELECT COUNT(*) FROM registrations WHERE retreat=$1 AND accommodation=$2 AND status <> 'cancelled') + (SELECT COUNT(*) FROM registration_checkouts WHERE retreat=$1 AND accommodation=$2 AND registration_id IS NULL AND hold_until > now()) AS taken`, [d.retreat, d.accommodation]);
      if (Number(count.rows[0].taken) >= ACCOMMODATIONS.find(a => a.name === d.accommodation)!.capacity) {
        await client.query('ROLLBACK');
        return Response.json({ error: 'This accommodation is fully booked or temporarily held for payment. Please choose another option or try again later.' }, { status: 409, headers });
      }
      await client.query(`INSERT INTO registration_checkouts (id, retreat, accommodation, occupancy, details, hold_until) VALUES ($1,$2,$3,$4,$5,to_timestamp($6))`, [id, d.retreat, d.accommodation, Number(d.occupancy), JSON.stringify(d), expires + 240]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
    const session = await stripeRequest('checkout/sessions', {
      mode: 'payment', 'payment_method_types[0]': 'card',
      customer_email: d.email, client_reference_id: id, 'metadata[booking_id]': id,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '10000',
      'line_items[0][price_data][product_data][name]': 'Retreat registration deposit per participant',
      'line_items[0][quantity]': d.occupancy,
      expires_at: String(expires),
      success_url: origin + '/register.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/register.html?payment=cancelled',
    }, id);
    await getDatabase().sql`UPDATE registration_checkouts SET stripe_session_id = ${session.id} WHERE id = ${id}`;
    return Response.json({ url: session.url }, { headers });
  } catch {
    // Avoid logging payment responses or personal registration data.
    return Response.json({ error: 'Unable to complete registration. If you have paid, please reload this page to verify your payment; otherwise try again shortly.' }, { status: 503, headers });
  }
};
export const config: Config = { path: '/api/checkout' };
