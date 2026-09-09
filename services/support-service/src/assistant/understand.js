const { ARTICLES, DOCUMENTS, DOCUMENT_ALIASES } = require('./knowledge');

/**
 * Turning a typed question into an intent and its entities.
 *
 * The bot this replaces scored a hit if ANY single keyword appeared, so
 * "payment" alone matched three different topics and the first one won. Here a
 * match must be a whole phrase, longer phrases outrank shorter ones, and a
 * total below a floor is treated as "I do not know" rather than guessed.
 */

/** Fold case, strip punctuation, and normalise the ways people write naira. */
const normalise = (text) => String(text || '')
  .toLowerCase()
  .replace(/[₦,]/g, '')
  .replace(/[^\w\s.']/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Common spellings that mean the same thing to us. */
const SYNONYMS = [
  [/\binstall?ments?\b/g, 'instalment'],
  [/\bpayments?\b/g, 'payment'],
  [/\bproperties\b/g, 'property'],
  [/\bhouses\b/g, 'house'],
  [/\binvoices\b/g, 'invoice'],
  [/\bowing\b/g, 'owe'],
  [/\bam i owing\b/g, 'do i owe'],
  [/\bhow much am i owe\b/g, 'how much do i owe'],
  [/\bwan\b/g, 'want'],          // light pidgin, common in typed Nigerian English
  [/\babeg\b/g, 'please'],
  [/\bhw\b/g, 'how'],
  [/\bpls\b/g, 'please'],
];

const expand = (text) => SYNONYMS.reduce((acc, [from, to]) => acc.replace(from, to), text);

/**
 * Money written the way people actually type it: 8m, 8 million, 8000000, 8.5m.
 * Returns every amount found, largest first.
 */
const extractAmounts = (text) => {
  const found = [];
  const patterns = [
    { re: /(\d+(?:\.\d+)?)\s*(?:m|million)\b/g, factor: 1_000_000 },
    { re: /(\d+(?:\.\d+)?)\s*(?:k|thousand)\b/g, factor: 1_000 },
    { re: /(\d+(?:\.\d+)?)\s*(?:b|billion)\b/g, factor: 1_000_000_000 },
  ];
  let stripped = text;
  for (const { re, factor } of patterns) {
    stripped = stripped.replace(re, (whole, value) => {
      found.push(Math.round(Number(value) * factor));
      return ' ';
    });
  }
  // Bare numbers, but only ones large enough to be money rather than a count.
  for (const match of stripped.matchAll(/\b(\d{4,})\b/g)) found.push(Number(match[1]));
  return found.sort((a, b) => b - a);
};

/** "over 24 months", "for 2 years", "24 month plan". */
const extractMonths = (text) => {
  const months = text.match(/(\d+)\s*month/);
  if (months) return Number(months[1]);
  const years = text.match(/(\d+)\s*year/);
  if (years) return Number(years[1]) * 12;
  return null;
};

/** Which title document, if any, the question is about. */
const extractDocument = (text) => {
  for (const [alias, canonical] of Object.entries(DOCUMENT_ALIASES)) {
    if (text.includes(alias)) return canonical;
  }
  for (const name of Object.keys(DOCUMENTS)) {
    if (text.includes(name)) return name;
  }
  return null;
};

/** A rough intent that needs a person rather than an answer. */
const NEEDS_HUMAN = [
  'speak to someone', 'talk to a person', 'talk to someone', 'human', 'agent', 'call me',
  'complain', 'complaint', 'refund', 'dispute', 'scam', 'fraud', 'lawyer', 'legal advice',
  'negotiate', 'discount', 'reduce the price', 'sue',
];

/** Longer phrases are stronger evidence, so score by phrase length. */
const scoreArticle = (article, text) => article.match.reduce((total, phrase) => (
  text.includes(phrase) ? total + phrase.split(' ').length : total
), 0);

/**
 * Reads one message.
 * Returns the best article (or null), the entities found, and whether the user
 * is asking for a human.
 */
const understand = (message, role) => {
  const text = expand(normalise(message));
  const amounts = extractAmounts(text);

  // Score EVERY article, then prefer one written for this role.
  //
  // Filtering by audience first was wrong: it deleted the topic rather than
  // adapting the answer, so an admin asking how a realtor gets verified — the
  // person who approves it — was told the question was not understood.
  const scored = ARTICLES
    .map((a) => ({ article: a, score: scoreArticle(a, text) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const inRole = scored.filter((c) => c.article.audience.includes(role));
  const candidates = inRole.length ? inRole : scored;
  const outOfRole = !inRole.length && scored.length > 0;

  let article = candidates[0]?.article ?? null;
  let confidence = candidates[0]?.score ?? 0;
  const months = extractMonths(text);

  // "7 million over 24 months" carries no keyword but is unmistakably a
  // payment-plan question — the figures themselves are the intent.
  if (!article && amounts.length && months) {
    article = ARTICLES.find((a) => a.id === 'instalments') ?? null;
    confidence = 3;
  }

  return {
    text,
    article,
    confidence,
    // A close second means the question was ambiguous, worth a clarifier.
    ambiguous: candidates.length > 1 && candidates[0].score === candidates[1].score,
    wantsHuman: NEEDS_HUMAN.some((p) => text.includes(p)),
    // True when the best answer belongs to another role — the reply says so
    // rather than pretending it is a step this user can take.
    outOfRole,
    amounts,
    months,
    document: extractDocument(text),
  };
};

module.exports = { understand, normalise, extractAmounts, extractMonths, extractDocument };
