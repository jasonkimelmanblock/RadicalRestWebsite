import type { Config } from '@netlify/functions';
import { getDatabase } from '@netlify/database';
import { stripeRequest, confirmPayment } from '../lib/payments.mjs';

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    // Treat the entire notification as untrusted. In particular, never use its
    // payment status, amount, metadata, or customer fields to confirm a booking.
    const event = await req.json();
    if (event.type !== 'checkout.session.completed') return Response.json({ received: true });
    const id = event.data?.object?.id;
    if (typeof id !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(id)) return new Response('Invalid session', { status: 400 });
    const bookings = await getDatabase().sql`SELECT id FROM registration_checkouts WHERE stripe_session_id = ${id}`;
    // Other sites and deploy previews can share the Stripe account.
    if (!bookings.length) return Response.json({ received: true });
    const session = await stripeRequest('checkout/sessions/' + encodeURIComponent(id));
    await confirmPayment(session);
    return Response.json({ received: true });
  } catch { return new Response('Unable to verify payment; retry required', { status: 500 }); }
};
export const config: Config = { path: '/api/stripe-webhook' };
