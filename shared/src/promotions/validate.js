const { asMinor } = require('../money');
const {
  BENEFIT, BENEFIT_TYPES, RESOLUTIONS, STATUSES, TIER_ON, AUDIENCE, TRIGGER,
} = require('./types');

/**
 * What has to be true before a promotion may go live.
 *
 * ── Errors stop activation; warnings do not ─────────────────────────────────
 *
 * The distinction is whether the configuration is INCOHERENT or merely
 * surprising. "Percentage discount with no percentage" cannot mean anything, so
 * it is an error. "95% off" almost certainly means somebody typed an extra
 * digit, but it is a thing a company may legitimately do — so it is a warning
 * that must be read and dismissed, not a refusal.
 *
 * Catching these at save time is the entire value. A promotion that computes to
 * nothing does not fail loudly at checkout; it quietly gives no discount, and
 * the first anybody hears is a customer asking where their advertised 20% went.
 */

const error = (code, message, at = null) => ({ severity: 'error', code, message, at });
const warn = (code, message, at = null) => ({ severity: 'warning', code, message, at });

const validatePromotion = (promotion = {}) => {
  const findings = [];

  if (!String(promotion.name || '').trim()) {
    findings.push(error('name_missing', 'Give the promotion a name — it is what everyone will recognise it by.'));
  }

  if (promotion.status && !STATUSES.includes(promotion.status)) {
    findings.push(error('status_unknown', `"${promotion.status}" is not a status this system knows.`));
  }

  if (!BENEFIT_TYPES.includes(promotion.benefit_type)) {
    findings.push(error('benefit_type_unknown',
      'Choose what the promotion actually gives — a percentage, an amount, a free unit, or tiers.'));
  }

  if (promotion.resolution && !RESOLUTIONS.includes(promotion.resolution)) {
    findings.push(error('resolution_unknown', 'The rule for choosing between competing offers is not one this system knows.'));
  }

  // ── dates ────────────────────────────────────────────────────────────────
  const starts = promotion.starts_at ? new Date(promotion.starts_at) : null;
  const ends = promotion.ends_at ? new Date(promotion.ends_at) : null;
  if (starts && Number.isNaN(starts.getTime())) findings.push(error('starts_at_invalid', 'The start date is not a date.'));
  if (ends && Number.isNaN(ends.getTime())) findings.push(error('ends_at_invalid', 'The end date is not a date.'));
  if (starts && ends && !Number.isNaN(starts.getTime()) && !Number.isNaN(ends.getTime()) && ends < starts) {
    findings.push(error('dates_reversed', 'The promotion ends before it starts.'));
  }
  if (!ends) {
    findings.push(warn('no_end_date',
      'This promotion has no end date, so it runs until somebody switches it off.'));
  }

  // ── scope ────────────────────────────────────────────────────────────────
  const scope = promotion.scope || {};
  const hasScope = (scope.unit_ids || []).length || (scope.property_ids || []).length;
  if (!hasScope) {
    findings.push(warn('scope_empty',
      'No property or unit is named, so this applies to everything the company sells.'));
  }

  // ── the benefit itself ───────────────────────────────────────────────────
  switch (promotion.benefit_type) {
    case BENEFIT.PERCENTAGE: {
      const percentage = Number(promotion.percentage);
      if (!(percentage > 0)) {
        findings.push(error('percentage_missing', 'Set the discount percentage.', 'percentage'));
      } else if (percentage > 100) {
        findings.push(error('percentage_over_100', 'A discount cannot be more than 100%.', 'percentage'));
      } else if (percentage >= 50) {
        findings.push(warn('percentage_high',
          `${percentage}% off is a large discount — check it is what you meant.`, 'percentage'));
      }
      break;
    }

    case BENEFIT.FIXED_AMOUNT:
      if (!(asMinor(promotion.amount_minor) > 0)) {
        findings.push(error('amount_missing', 'Set the amount to take off.', 'amount_minor'));
      }
      break;

    case BENEFIT.TIERED: {
      const tiers = promotion.tiers || [];
      if (!tiers.length) {
        findings.push(error('tiers_missing', 'Add at least one tier, or choose a simpler discount type.', 'tiers'));
        break;
      }
      if (promotion.tier_on && !Object.values(TIER_ON).includes(promotion.tier_on)) {
        findings.push(error('tier_on_unknown', 'Tiers must be measured by quantity or by value.', 'tier_on'));
      }
      const thresholds = new Set();
      tiers.forEach((tier, index) => {
        const from = Number(tier.from ?? tier.min ?? 0);
        if (!Number.isFinite(from)) {
          findings.push(error('tier_threshold_invalid', `Tier ${index + 1} has no starting point.`, `tiers[${index}]`));
        }
        /**
         * Two tiers starting at the same number is not merely untidy — one of
         * them can never be reached, and which one wins is an accident of
         * ordering rather than a decision.
         */
        if (thresholds.has(from)) {
          findings.push(error('tier_duplicate',
            `Two tiers both start at ${from}; one of them can never apply.`, `tiers[${index}]`));
        }
        thresholds.add(from);

        const hasBenefit = Number(tier.percentage) > 0 || asMinor(tier.amount_minor) > 0;
        if (!hasBenefit) {
          findings.push(error('tier_benefit_missing',
            `Tier ${index + 1} gives nothing.`, `tiers[${index}]`));
        }
      });
      if (!tiers.some((tier) => Number(tier.from ?? tier.min ?? 0) <= 1)) {
        findings.push(warn('tiers_start_high',
          'No tier covers a small purchase, so buyers below the first threshold get nothing.'));
      }
      break;
    }

    case BENEFIT.BUY_X_GET_Y: {
      const config = promotion.buy_x_get_y || {};
      if (!(Number(config.buy_quantity) > 0)) {
        findings.push(error('buy_quantity_missing', 'Say how many must be bought.', 'buy_x_get_y.buy_quantity'));
      }
      if (!(Number(config.reward_quantity) > 0)) {
        findings.push(error('reward_quantity_missing', 'Say how many are given.', 'buy_x_get_y.reward_quantity'));
      }
      const rewardPercentage = config.reward_discount_percentage;
      if (rewardPercentage != null && (Number(rewardPercentage) < 0 || Number(rewardPercentage) > 100)) {
        findings.push(error('reward_discount_invalid',
          'The reward discount must be between 0 and 100%.', 'buy_x_get_y.reward_discount_percentage'));
      }
      /**
       * The reward being the same unit as the qualifier is legitimate ("buy 2,
       * get the 3rd free") but it changes the arithmetic — the qualifying units
       * are consumed and cannot themselves be the reward. Worth saying, because
       * the admin who configured "buy 2 get 1" on a basket of exactly 2 will
       * otherwise wonder why nothing happened.
       */
      if (config.reward_unit_id != null && Number(config.reward_unit_id) === Number(config.buy_unit_id)) {
        findings.push(warn('reward_is_qualifier',
          'The reward is the same unit that qualifies, so a buyer needs more than the qualifying quantity to get one.'));
      }
      if (config.repeatable && !config.max_rewards) {
        findings.push(warn('repeatable_uncapped',
          'This repeats with no limit, so a large purchase could earn many free units. Consider a maximum.'));
      }
      break;
    }

    case BENEFIT.NON_MONETARY:
      if (!(promotion.perks || []).length) {
        findings.push(error('perks_missing',
          'Name what the buyer receives — otherwise this promotion promises nothing.', 'perks'));
      }
      break;

    default:
      break;
  }

  // ── restrictions ─────────────────────────────────────────────────────────
  const eligibility = promotion.eligibility || {};
  if (eligibility.audience && !Object.values(AUDIENCE).includes(eligibility.audience)) {
    findings.push(error('audience_unknown',
      'The eligibility rule is not one this system knows, so nobody would qualify.', 'eligibility.audience'));
  }
  if (eligibility.audience === AUDIENCE.SELECTED_CUSTOMERS && !(eligibility.customer_ids || []).length) {
    findings.push(error('customers_not_chosen', 'Choose the customers this is for.', 'eligibility.customer_ids'));
  }
  if (eligibility.audience === AUDIENCE.SELECTED_REALTORS && !(eligibility.realtor_ids || []).length) {
    findings.push(error('realtors_not_chosen', 'Choose the agents this is for.', 'eligibility.realtor_ids'));
  }

  if ((promotion.trigger || TRIGGER.AUTOMATIC) === TRIGGER.CODE && !String(promotion.code || '').trim()) {
    findings.push(error('code_missing',
      'A code-based promotion needs a code, or nobody can claim it.', 'code'));
  }

  const ceiling = asMinor(promotion.max_discount_minor);
  if (ceiling > 0 && promotion.benefit_type === BENEFIT.FIXED_AMOUNT
    && asMinor(promotion.amount_minor) > ceiling) {
    findings.push(warn('cap_below_amount',
      'The maximum discount is lower than the fixed amount, so buyers will never receive the full amount.'));
  }

  const combination = promotion.combination || [];
  combination.forEach((requirement, index) => {
    if (!(Number(requirement.quantity) > 0)) {
      findings.push(error('combination_quantity_invalid',
        `Combination requirement ${index + 1} has no quantity.`, `combination[${index}]`));
    }
    if (requirement.unit_id == null) {
      findings.push(error('combination_unit_missing',
        `Combination requirement ${index + 1} names no unit.`, `combination[${index}]`));
    }
  });

  /**
   * A combination that names units outside the promotion's own scope can never
   * be satisfied: the scope filters the basket before the combination is
   * checked, so the required unit is removed before it can be counted.
   */
  if (combination.length && (scope.unit_ids || []).length) {
    const inScope = new Set(scope.unit_ids.map(Number));
    const unreachable = combination
      .filter((requirement) => !inScope.has(Number(requirement.unit_id)))
      .map((requirement) => requirement.label || `#${requirement.unit_id}`);
    if (unreachable.length) {
      findings.push(error('combination_outside_scope',
        `The combination needs ${unreachable.join(', ')}, which the promotion's scope excludes — it could never apply.`));
    }
  }

  const errors = findings.filter((f) => f.severity === 'error');
  return {
    ok: errors.length === 0,
    errors,
    warnings: findings.filter((f) => f.severity === 'warning'),
  };
};

module.exports = { validatePromotion };
