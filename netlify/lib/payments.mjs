import { createHash } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { RETREATS, ACCOMMODATIONS } from './retreats.mjs';

export function validateBooking(input) {
  const d = {};
  for (const key of ['retreat', 'accommodation', 'occupancy', 'first_name', 'last_name', 'email', 'phone', 'guest2_first_name', 'guest2_last_name', 'guest2_email', 'guest2_phone', 'mattress', 'how_heard', 'notes']) {
    d[key] = typeof input[key] === 'string' ? input[key].trim() : '';
    if (d[key].length > (key === 'notes' ? 5000 : 300)) throw new Error('Please shorten your registration details.');
  }
  if (!RETREATS.includes(d.retreat) || !ACCOMMODATIONS.some(a => a.name === d.accommodation)) throw new Error('Select a valid retreat and accommodation.');
  if (!['1', '2'].includes(d.occupancy)) throw new Error('Select single or double occupancy.');
  const required = ['first_name', 'last_name', 'email', 'phone'];
  if (d.occupancy === '2') required.push('guest2_first_name', 'guest2_last_name', 'guest2_email', 'guest2_phone');
  if (required.some(k => !d[k]) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) || (d.occupancy === '2' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.guest2_email))) throw new Error('Enter complete participant names, emails, and phone numbers.');
  if ((d.accommodation === 'Bedroom with ensuite bathroom' || (d.accommodation === 'Glamping tent' && d.occupancy === '2')) && !d.mattress) throw new Error('Select a bed preference.');
  return d;
}

export async function stripeRequest(path, body, idempotencyKey) {
  const key = Netlify.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Payments are temporarily unavailable. Please try again later.');
  const response = await fetch('https://api.stripe.com/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Unable to contact the payment provider. Please try again.');
  return response.json();
}

// Notifications never authorize registration themselves: the receiver retrieves
// the session from Stripe using the private API key before verifying payment.
export async function ensurePaymentNotifications(origin) {
  const url = origin + '/api/stripe-webhook';
  const endpoints = await stripeRequest('webhook_endpoints?limit=100');
  const endpoint = endpoints.data?.find(endpoint => endpoint.url === url && endpoint.status === 'enabled' && (endpoint.enabled_events.includes('checkout.session.completed') || endpoint.enabled_events.includes('*')));
  if (endpoint) return;
  await stripeRequest('webhook_endpoints', {
    url,
    'enabled_events[0]': 'checkout.session.completed',
    description: 'Retreat registration payment confirmation',
  }, 'registration-webhook-' + createHash('sha256').update(url).digest('hex'));
}

export function paymentMatches(session, booking) {
  return session.status === 'complete' && session.payment_status === 'paid' && session.mode === 'payment' && session.currency === 'usd' && session.amount_total === Number(booking.occupancy) * 10000 && session.client_reference_id === booking.id && session.metadata?.booking_id === booking.id && (!booking.stripe_session_id || booking.stripe_session_id === session.id);
}

// Browser returns and notifications verified with Stripe use one idempotent transaction.
export async function confirmPayment(session, database = getDatabase()) {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM registration_checkouts WHERE id = $1 FOR UPDATE', [session.metadata?.booking_id]);
    const booking = result.rows[0];
    if (!booking || !paymentMatches(session, booking)) throw new Error('Payment has not been completed for this registration.');
    const d = booking.details;
    if (!booking.registration_id) {
      const deposit = Number(booking.occupancy) * 100;
      const inserted = await client.query(`INSERT INTO registrations (retreat, accommodation, occupancy, first_name, last_name, email, phone, guest2_first_name, guest2_last_name, guest2_email, guest2_phone, mattress, how_heard, notes, price, deposit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`, [d.retreat, d.accommodation, Number(d.occupancy), d.first_name, d.last_name, d.email, d.phone, d.guest2_first_name, d.guest2_last_name, d.guest2_email, d.guest2_phone, d.mattress, d.how_heard, d.notes, deposit]);
      await client.query('UPDATE registration_checkouts SET registration_id = $2, stripe_session_id = $3 WHERE id = $1', [booking.id, inserted.rows[0].id, session.id]);
    }
    await client.query('COMMIT');
    return { firstName: d.first_name, retreat: d.retreat, accommodation: d.accommodation, deposit: Number(d.occupancy) * 100 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
