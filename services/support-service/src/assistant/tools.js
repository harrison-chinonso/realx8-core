const GATEWAY = process.env.GATEWAY_URL || `http://localhost:${process.env.GATEWAY_PORT || 3000}`;

/**
 * Janet's tools.
 *
 * SECURITY: every call is made to the public gateway carrying the END USER'S
 * OWN bearer token — never a service account and never a direct database read.
 * That is deliberate: the assistant then inherits, unchanged, every rule the
 * app already enforces (company scoping, client-only invoice access, realtor
 * downline limits, draft invoices hidden from buyers). An assistant that read
 * the database directly would quietly become a way around all of it.
 *
 * A tool therefore cannot show a user anything they could not already open in
 * the UI. A 403 is a real answer, not an error to work around.
 */

const request = async (token, path, { method = 'GET', body } = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }

  if (!response.ok) {
    // Hand the model a plain refusal rather than an exception, so it can tell
    // the user honestly instead of retrying or inventing.
    return {
      ok: false,
      status: response.status,
      message: payload?.message || `Request failed (${response.status})`,
    };
  }
  return { ok: true, data: payload?.data ?? payload };
};

const money = (value) => Number(value) || 0;

/** Trim a property to what is useful in a chat reply. */
const slimProperty = (p) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  location: [p.city, p.state, p.country].filter(Boolean).join(', '),
  description: p.description ? String(p.description).slice(0, 300) : null,
  amenities: (p.amenities || []).map((a) => a.name),
  units: (p.units || []).map((u) => ({
    id: u.id,
    name: u.name,
    price: money(u.price),
    size: u.size,
    measured_in: u.unit,
    available: u.quantity_available ?? u.quantity,
  })),
  cheapest_unit_price: (p.units || []).length
    ? Math.min(...p.units.map((u) => money(u.price)).filter((n) => n > 0))
    : null,
});

/**
 * Instalment maths. Pure arithmetic, no API — so it is exact and cannot drift
 * from what the invoice actually says when paired with get_invoice.
 */
const buildSchedule = ({ total, deposit = 0, months, monthly_income = null }) => {
  const financed = Math.max(money(total) - money(deposit), 0);
  const term = Math.max(Math.round(Number(months) || 0), 1);
  const perMonth = Math.round(financed / term);

  const result = {
    total: money(total),
    deposit: money(deposit),
    financed,
    months: term,
    monthly_payment: perMonth,
  };

  if (monthly_income != null && money(monthly_income) > 0) {
    const income = money(monthly_income);
    const share = perMonth / income;
    result.income_check = {
      monthly_income: income,
      share_of_income_percent: Math.round(share * 100),
      // A widely used affordability guide, stated as guidance not a rule.
      verdict: share <= 0.33 ? 'comfortable' : share <= 0.45 ? 'tight' : 'over-stretched',
    };
  }
  return result;
};

/** Definitions the model sees. Descriptions double as usage instructions. */
const TOOL_SCHEMAS = [
  {
    name: 'search_properties',
    description: 'Search approved, available properties the user may buy. Use for any "what can I afford / show me properties" question. Returns real listings only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text matched against name, city, state, country, type.' },
        max_price: { type: 'number', description: 'Highest unit price the buyer can afford, in the platform currency.' },
        min_price: { type: 'number' },
        limit: { type: 'number', description: 'Default 8.' },
      },
    },
  },
  {
    name: 'get_property',
    description: 'Full detail for one property: unit configurations with prices and availability, amenities, description, location. Use before recommending or explaining a specific property.',
    input_schema: {
      type: 'object',
      properties: { property_id: { type: 'number' } },
      required: ['property_id'],
    },
  },
  {
    name: 'list_my_invoices',
    description: "The signed-in user's own invoices with amount, status and outstanding balance. Use for 'what do I owe', 'my payments', 'is my payment confirmed'.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_invoice_payment_options',
    description: 'How the user can pay a specific invoice: the company bank account details to transfer to, and whether an online gateway is available. Use when they ask how to pay.',
    input_schema: {
      type: 'object',
      properties: { invoice_id: { type: 'number' } },
      required: ['invoice_id'],
    },
  },
  {
    name: 'calculate_payment_plan',
    description: 'Work out an instalment schedule: monthly payment for a total over a number of months, optionally checked against the buyer\'s stated monthly income. Use whenever discussing affordability. Get the total from a real property unit or invoice first.',
    input_schema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        deposit: { type: 'number' },
        months: { type: 'number' },
        monthly_income: { type: 'number', description: "Only if the user volunteered it." },
      },
      required: ['total', 'months'],
    },
  },
  {
    name: 'list_my_leads',
    description: 'REALTORS ONLY. The leads this realtor may book an inspection for. Call this before book_inspection so you can ask which person the viewing is for.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'book_inspection',
    description: 'REALTORS ONLY. Book a property viewing for one of the realtor\'s leads. Needs the property, the lead, and a date and time. An admin approves it afterwards. Confirm the details with the user before calling.',
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'number' },
        lead_id: { type: 'number', description: 'From list_my_leads.' },
        scheduled_at: { type: 'string', description: 'ISO date-time, e.g. 2026-10-14T10:30. Must be in the future.' },
        attendees: { type: 'number', description: 'How many people will attend. Default 1.' },
      },
      required: ['property_id', 'lead_id', 'scheduled_at'],
    },
  },
  {
    name: 'request_inspection',
    description: "CLIENTS. A client cannot book a viewing themselves — inspections are arranged by a realtor. This raises a tracked request naming the property and their preferred time, and alerts their realtor. Confirm the property and timing with the user before calling.",
    input_schema: {
      type: 'object',
      properties: {
        property_id: { type: 'number' },
        preferred_time: { type: 'string', description: "The user's own words, e.g. 'Saturday morning'." },
        notes: { type: 'string' },
      },
      required: ['property_id', 'preferred_time'],
    },
  },
  {
    name: 'hand_off_to_human',
    description: 'Raise a support ticket for a human agent. Use for negotiations, complaints, payment disputes, legal questions, or when the user asks for a person. Confirm with the user before calling.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        summary: { type: 'string', description: 'What the user needs, in your words, including anything already established.' },
      },
      required: ['subject', 'summary'],
    },
  },
];

/** Executors. Each receives the caller's token and returns a plain result. */
const executors = {
  async search_properties(token, { query, max_price, min_price, limit = 8 }) {
    const params = new URLSearchParams({ limit: String(Math.min(Number(limit) || 8, 24)) });
    if (query) params.set('search', String(query));
    const res = await request(token, `/properties/listed?${params}`);
    if (!res.ok) return res;

    let items = (res.data || []).map(slimProperty);
    // Price filtering is applied here because a property has several unit
    // configurations at different prices — "affordable" means it has at least
    // one unit within reach, which the list endpoint cannot express.
    if (max_price != null) items = items.filter((p) => p.cheapest_unit_price != null && p.cheapest_unit_price <= money(max_price));
    if (min_price != null) items = items.filter((p) => p.cheapest_unit_price != null && p.cheapest_unit_price >= money(min_price));
    return { ok: true, data: { count: items.length, properties: items } };
  },

  async get_property(token, { property_id }) {
    const res = await request(token, `/properties/listed/${Number(property_id)}`);
    return res.ok ? { ok: true, data: slimProperty(res.data) } : res;
  },

  async list_my_invoices(token) {
    const res = await request(token, '/invoices');
    if (!res.ok) return res;
    const invoices = (res.data || []).map((i) => {
      const paid = (i.payments || [])
        .filter((p) => p.status === 'completed')
        .reduce((sum, p) => sum + money(p.amount), 0);
      return {
        id: i.id,
        reference: i.invoice_id,
        total: money(i.amount),
        paid,
        outstanding: Math.max(money(i.amount) - paid, 0),
        status: i.status,
        due_date: i.due_date,
      };
    });
    return { ok: true, data: { count: invoices.length, invoices } };
  },

  async get_invoice_payment_options(token, { invoice_id }) {
    const res = await request(token, `/invoices/${Number(invoice_id)}/payment-options`);
    if (!res.ok) return res;
    const d = res.data || {};
    return {
      ok: true,
      data: {
        outstanding: d.invoice?.balance ?? null,
        bank_transfer: (d.bank?.accounts || []).map((a) => ({
          bank: a.bank_name, account_name: a.name, account_number: a.account_number,
        })),
        online_payment: d.online ? d.online.label : null,
        note: 'After paying, upload proof of payment on the invoice. An admin confirms it before it is credited.',
      },
    };
  },

  async calculate_payment_plan(_token, args) {
    return { ok: true, data: buildSchedule(args) };
  },

  async list_my_leads(token) {
    const res = await request(token, '/inspections/leads');
    if (!res.ok) return res;
    const leads = (res.data || []).map((l) => ({ id: l.id, name: l.name, email: l.email, phone: l.phone }));
    return { ok: true, data: { count: leads.length, leads } };
  },

  async book_inspection(token, { property_id, lead_id, scheduled_at, attendees = 1 }, { userName }) {
    const when = new Date(scheduled_at);
    if (Number.isNaN(when.getTime())) return { ok: false, message: 'That date and time could not be read.' };
    if (when.getTime() < Date.now()) return { ok: false, message: 'That time is in the past — pick a future slot.' };

    // The API needs the property's name, so read it first. This also confirms
    // the property is one this user may actually see.
    const property = await request(token, `/properties/listed/${Number(property_id)}`);
    if (!property.ok) return property;

    const res = await request(token, '/inspections', {
      method: 'POST',
      body: {
        property_id: Number(property_id),
        property_name: property.data?.name,
        lead_id: Number(lead_id),
        realtor_name: userName || 'Realtor',
        scheduled_at: when.toISOString(),
        attendees: Math.max(Number(attendees) || 1, 1),
      },
    });
    if (!res.ok) return res;
    return {
      ok: true,
      data: {
        reference: res.data?.ref_number ?? null,
        scheduled_at: res.data?.scheduled_at ?? when.toISOString(),
        status: res.data?.status ?? 'pending',
        note: 'Booked. An administrator reviews and approves inspections before they are confirmed.',
      },
    };
  },

  async request_inspection(token, { property_id, preferred_time, notes }, { userId }) {
    const property = await request(token, `/properties/listed/${Number(property_id)}`);
    if (!property.ok) return property;

    const res = await request(token, '/support', {
      method: 'POST',
      body: {
        subject: `Inspection request — ${property.data?.name}`,
        description: `Client would like to view ${property.data?.name}`
          + `${property.data?.location ? ` (${property.data.location})` : ''}.`
          + `\nPreferred time: ${preferred_time}.`
          + `${notes ? `\nNotes: ${notes}` : ''}`,
        user_id: userId,
        priority: 'medium',
      },
    });
    if (!res.ok) return res;
    return {
      ok: true,
      data: {
        ticket_id: res.data?.id ?? null,
        property: property.data?.name,
        note: 'Request logged. A realtor will contact them to confirm a slot — clients cannot book a viewing directly.',
      },
    };
  },

  async hand_off_to_human(token, { subject, summary }, { userId }) {
    const res = await request(token, '/support', {
      method: 'POST',
      body: { subject: String(subject).slice(0, 200), description: String(summary), user_id: userId, priority: 'medium' },
    });
    if (!res.ok) return res;
    return { ok: true, data: { ticket_id: res.data?.id ?? null, message: 'A support ticket was raised; an agent will follow up.' } };
  },
};

const runTool = async (name, args, { token, userId, userName }) => {
  const executor = executors[name];
  if (!executor) return { ok: false, message: `Unknown tool: ${name}` };
  try {
    return await executor(token, args || {}, { userId, userName });
  } catch (error) {
    console.error(`[assistant] tool ${name} failed:`, error.message);
    return { ok: false, message: 'That lookup failed. Try again in a moment.' };
  }
};

module.exports = { TOOL_SCHEMAS, runTool, buildSchedule };
