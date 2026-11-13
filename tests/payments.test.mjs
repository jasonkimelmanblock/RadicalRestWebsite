import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBooking, paymentMatches, confirmPayment } from '../netlify/lib/payments.mjs';

const details = { retreat: 'December 11–13, 2026', accommodation: 'Bedroom with shared bathroom', occupancy: '1', first_name: 'Test', last_name: 'Guest', email: 'guest@example.com', phone: '555-0100' };
const booking = { id: '0c1757b9-9bcc-4c40-acf1-3eb47cb96b17', occupancy: 1, details, stripe_session_id: 'cs_test_example', registration_id: null };
const paid = { id: 'cs_test_example', status: 'complete', payment_status: 'paid', mode: 'payment', currency: 'usd', amount_total: 10000, client_reference_id: booking.id, metadata: { booking_id: booking.id } };

test('booking validation ignores client prices and rejects invalid or incomplete bookings', () => {
  assert.equal(validateBooking({ ...details, deposit: '0', price: '1' }).deposit, undefined);
  for (const change of [{ occupancy: '0' }, { occupancy: '2' }, { email: 'invalid' }, { accommodation: 'Unknown room' }, { retreat: 'Unknown date' }]) {
    assert.throws(() => validateBooking({ ...details, ...change }));
  }
  assert.equal(validateBooking({ ...details, occupancy: '2', guest2_first_name: 'Second', guest2_last_name: 'Guest', guest2_email: 'second@example.com', guest2_phone: '555-0101' }).occupancy, '2');
});

test('only a matching paid USD payment of $100 per participant is accepted', () => {
  assert.equal(paymentMatches(paid, booking), true);
  assert.equal(paymentMatches({ ...paid, amount_total: 20000 }, { ...booking, occupancy: 2 }), true);
  for (const change of [{ payment_status: 'unpaid' }, { status: 'open' }, { amount_total: 100 }, { currency: 'eur' }, { client_reference_id: 'other' }, { metadata: {} }, { id: 'cs_other' }, { mode: 'subscription' }]) {
    assert.equal(paymentMatches({ ...paid, ...change }, booking), false);
  }
  assert.equal(paymentMatches(paid, { ...booking, occupancy: 2 }), false);
});

function mockDatabase(row) {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push(sql);
      if (sql.startsWith('SELECT')) return { rows: [row] };
      if (sql.startsWith('INSERT')) return { rows: [{ id: 42 }] };
      if (sql.startsWith('UPDATE')) row.registration_id = values[1];
      return { rows: [] };
    },
    release() { queries.push('RELEASE'); },
  };
  return { db: { pool: { connect: async () => client } }, queries };
}

test('duplicate payment callbacks create exactly one registration', async () => {
  const { db, queries } = mockDatabase({ ...booking });
  const result = await confirmPayment(paid, db);
  await confirmPayment(paid, db);
  assert.equal(result.deposit, 100);
  assert.equal(queries.filter(q => q.startsWith('INSERT')).length, 1);
  assert.equal(queries.filter(q => q === 'COMMIT').length, 2);
});

test('unpaid callbacks roll back without creating registrations', async () => {
  const { db, queries } = mockDatabase({ ...booking });
  await assert.rejects(confirmPayment({ ...paid, payment_status: 'unpaid' }, db));
  assert.equal(queries.some(q => q.startsWith('INSERT')), false);
  assert.equal(queries.includes('ROLLBACK'), true);
  assert.equal(queries.at(-1), 'RELEASE');
});

test('payment notifications are configured automatically and reused', async () => {
  const { ensurePaymentNotifications } = await import('../netlify/lib/payments.mjs');
  const originalFetch = globalThis.fetch;
  const originalNetlify = globalThis.Netlify;
  globalThis.Netlify = { env: { get: () => 'test-fixture-only' } };
  const calls = [];
  let exists = false;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return Response.json({ data: exists ? [{ url: 'https://example.com/api/stripe-webhook', status: 'enabled', enabled_events: ['checkout.session.completed'] }] : [] });
    exists = true;
    assert.equal(options.body.get('url'), 'https://example.com/api/stripe-webhook');
    assert.equal(options.body.get('enabled_events[0]'), 'checkout.session.completed');
    return Response.json({ id: 'test-endpoint' });
  };
  try {
    await ensurePaymentNotifications('https://example.com');
    await ensurePaymentNotifications('https://example.com');
    assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Netlify = originalNetlify;
  }
});

test('provider failures return a safe error without payment response details', async () => {
  const { stripeRequest } = await import('../netlify/lib/payments.mjs');
  const originalFetch = globalThis.fetch;
  const originalNetlify = globalThis.Netlify;
  globalThis.Netlify = { env: { get: () => 'test-fixture-only' } };
  globalThis.fetch = async () => new Response('private provider diagnostic', { status: 401 });
  try {
    await assert.rejects(stripeRequest('checkout/sessions/cs_test'), { message: 'Unable to contact the payment provider. Please try again.' });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Netlify = originalNetlify;
  }
});
