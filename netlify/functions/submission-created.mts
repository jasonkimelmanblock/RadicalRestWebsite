// Legacy form submissions must never bypass required Stripe payment.
// Registrations are now created only by the verified payment transaction.
export default async () => new Response('Registration requires Stripe Checkout payment.', { status: 200 });
