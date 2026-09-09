const { understand } = require('./understand');
const { DOCUMENTS } = require('./knowledge');
const { runTool, buildSchedule } = require('./tools');

/**
 * Composes a reply.
 *
 * Knowledge comes from ./knowledge, figures come from the user's own data via
 * ./tools, and the two are stitched together here. No model is involved, so an
 * answer about money is arithmetic on live rows rather than a paraphrase — the
 * same question always produces the same number.
 */

const fmt = (value, currency = 'NGN') => {
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString('en-US')}`;
  }
};

const shortDate = (value) => (value
  ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  : null);

/** Data lookups, one per `enrich` key an article can declare. */
const enrichers = {
  async invoices(ctx) {
    const res = await runTool('list_my_invoices', {}, ctx);
    if (!res.ok) return { text: null };
    const owing = (res.data.invoices || []).filter((i) => i.outstanding > 0);

    if (!res.data.count) return { text: 'You have no invoices at the moment.' };
    if (!owing.length) return { text: 'Good news — everything on your account is settled.' };

    const total = owing.reduce((sum, i) => sum + i.outstanding, 0);
    const lines = owing.slice(0, 4).map((i) => {
      const due = shortDate(i.due_date);
      const part = i.paid > 0 ? ` (${fmt(i.paid, ctx.currency)} already paid)` : '';
      return `• ${i.reference} — ${fmt(i.outstanding, ctx.currency)} outstanding${part}${due ? `, due ${due}` : ''}`;
    });
    const header = owing.length === 1
      ? 'You have one invoice outstanding:'
      : `You have ${owing.length} invoices outstanding, ${fmt(total, ctx.currency)} in total:`;
    return { text: [header, ...lines].join('\n'), invoices: owing };
  },

  async payment_options(ctx) {
    const invoices = await runTool('list_my_invoices', {}, ctx);
    if (!invoices.ok) return { text: null };
    const target = (invoices.data.invoices || []).find((i) => i.outstanding > 0);
    if (!target) return { text: null };

    const options = await runTool('get_invoice_payment_options', { invoice_id: target.id }, ctx);
    if (!options.ok) return { text: null };

    const parts = [`For ${target.reference}, ${fmt(options.data.outstanding, ctx.currency)} is outstanding.`];
    for (const account of options.data.bank_transfer || []) {
      parts.push(`• ${account.bank} — ${account.account_number} (${account.account_name})`);
    }
    if (options.data.online_payment) parts.push(`• Or pay online with ${options.data.online_payment}.`);
    if (!(options.data.bank_transfer || []).length && !options.data.online_payment) {
      parts.push('No payment account has been published yet — I can put you through to someone.');
    }
    return { text: parts.join('\n') };
  },

  async properties(ctx, read) {
    const budget = read.amounts[0] ?? null;
    const res = await runTool('search_properties', { max_price: budget ?? undefined, limit: 6 }, ctx);
    if (!res.ok) return { text: null };

    const items = res.data.properties || [];
    if (!items.length) {
      return {
        text: budget
          ? `I could not find anything at ${fmt(budget, ctx.currency)} or below right now.`
          : 'There are no properties listed for you at the moment.',
      };
    }

    const header = budget
      ? `Here is what fits ${fmt(budget, ctx.currency)}:`
      : 'Here is what is available:';
    const lines = items.slice(0, 4).map((p) => {
      const from = p.cheapest_unit_price ? ` — from ${fmt(p.cheapest_unit_price, ctx.currency)}` : '';
      return `• **${p.name}**${p.location ? `, ${p.location}` : ''}${from}`;
    });
    const tail = read.months
      ? null
      : 'Tell me how many months you would want to spread payment over and I will work out the monthly figure.';
    return { text: [header, ...lines, tail].filter(Boolean).join('\n') };
  },

  async documents(_ctx, read) {
    if (!read.document) {
      return { text: `Tell me which document you mean — ${Object.keys(DOCUMENTS).slice(0, 3).join(', ')} — and I will explain it.` };
    }
    return {
      text: `**${read.document.replace(/\b\w/g, (c) => c.toUpperCase())}** — ${DOCUMENTS[read.document]}\n\nIf you want this checked against a specific property, I can put you through to someone.`,
    };
  },

  async inspection_request_hint() {
    return { text: 'Which property, and roughly when suits you?' };
  },
};

/** Instalment answer, from figures the user gave. */
const planAnswer = (read, ctx) => {
  const total = read.amounts[0];
  const months = read.months;
  if (!total || !months) return null;

  const deposit = read.amounts.length > 1 ? read.amounts[1] : 0;
  const plan = buildSchedule({ total, deposit, months });
  const lines = [
    `On ${fmt(plan.total, ctx.currency)}${deposit ? ` with ${fmt(deposit, ctx.currency)} down` : ''} over ${plan.months} months, that is about **${fmt(plan.monthly_payment, ctx.currency)} a month**.`,
  ];
  if (deposit) lines.push(`You would be financing ${fmt(plan.financed, ctx.currency)}.`);
  lines.push('Tell me your monthly income and I will tell you honestly whether that is comfortable.');
  return lines.join('\n\n');
};

/** Affordability, when they volunteered an income. */
const affordabilityAnswer = (read, ctx) => {
  if (read.amounts.length < 2 || !read.months) return null;
  const [total, income] = read.amounts;
  const plan = buildSchedule({ total, months: read.months, monthly_income: income });
  const check = plan.income_check;
  if (!check) return null;

  const verdicts = {
    comfortable: 'That sits comfortably within what you earn.',
    tight: 'That is workable but tight — it leaves little room if something changes.',
    'over-stretched': 'Honestly, that is more than I would advise on that income. A longer term or a smaller unit would sit better.',
  };
  return `${fmt(plan.monthly_payment, ctx.currency)} a month is about ${check.share_of_income_percent}% of ${fmt(income, ctx.currency)}.\n\n${verdicts[check.verdict]}`;
};

/**
 * Answers one message.
 * `ctx` carries the caller's token, id, role, currency and app name — every
 * data lookup runs as that user.
 */
const answerMessage = async (message, ctx) => {
  const read = understand(message, ctx.role);
  const used = [];
  const track = async (name, args) => { used.push(name); return runTool(name, args, ctx); };

  if (read.wantsHuman) {
    return {
      text: 'Let me put you through to someone. Tell me in a sentence what it is about and I will pass it on.',
      handoff: true,
      tools: used,
    };
  }

  // Figures beat prose: if they gave an amount and a term, answer with numbers.
  const affordability = affordabilityAnswer(read, ctx);
  if (affordability) return { text: affordability, tools: used };
  const plan = planAnswer(read, ctx);
  if (plan && read.article?.id === 'instalments') return { text: plan, tools: used };

  if (!read.article) {
    return {
      text: `I did not quite catch that. I can help with finding a property, what you owe, how to pay, payment plans, or what a title document means.\n\nIf you would rather talk to a person, just say so.`,
      tools: used,
    };
  }

  const parts = [];
  // Answer the question, but be clear when it describes someone else's step.
  if (read.outOfRole) {
    const who = read.article.audience.includes('realtor') ? 'a realtor' : 'an administrator';
    parts.push(`That is something ${who} does — here is how it works.`);
  }
  if (read.article.answer) parts.push(read.article.answer({ appName: ctx.appName, role: ctx.role }));

  if (read.article.enrich) {
    const enrich = enrichers[read.article.enrich];
    if (enrich) {
      used.push(read.article.enrich);
      const extra = await enrich({ ...ctx, track }, read);
      if (extra?.text) parts.push(extra.text);
    }
  }

  if (!parts.length) {
    parts.push('I could not find anything for that. Would you like me to pass it to a person?');
  }
  return { text: parts.join('\n\n'), tools: used };
};

module.exports = { answerMessage, fmt };
