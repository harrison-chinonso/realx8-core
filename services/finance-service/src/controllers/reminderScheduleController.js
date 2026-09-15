const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, ReminderSchedule, Invoice } = require('../models');
const { BUILT_IN_OFFSETS, describeOffset } = require('../../../../shared/src/reminderSchedule');

/**
 * Configuring when buyers are reminded about an installment.
 *
 * ── Copy on write, which is the whole shape of this ─────────────────────────
 *
 * A company does not edit the platform default — it edits what it SEES, and
 * what it sees is the platform default until it has one of its own. The first
 * save therefore creates a company row rather than updating the platform's;
 * every save afterwards updates that row. Without this, the first company to
 * change its reminders would change them for every other company on the
 * platform, and would have no way of knowing it had.
 *
 * The same idea one level down: an invoice put on its own schedule gets a named
 * schedule of its own, and the company default carries on unchanged for
 * everything else.
 *
 * ── Edits apply going forward, never backwards ──────────────────────────────
 *
 * Reminders already sent are recorded per installment in
 * schedule_reminder_sends. Adding an offset does not retroactively send it for
 * an installment whose date has passed unless that offset is now due and
 * unsent; removing one does not unsend anything. So an edit changes what
 * happens next, which is the only thing an edit can honestly promise.
 */

/** Offsets are days relative to the due date. Sane, ordered, and de-duplicated. */
const MAX_OFFSET_DAYS = 365;

const cleanOffsets = (raw) => {
  const list = Array.isArray(raw) ? raw : [];
  const days = list
    .map((entry) => (entry && typeof entry === 'object' ? Number(entry.days) : Number(entry)))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.trunc(value))
    .filter((value) => Math.abs(value) <= MAX_OFFSET_DAYS);
  return [...new Set(days)].sort((a, b) => a - b);
};

/** The company a request acts for — null for a platform admin acting globally. */
const companyOf = (req) => {
  if (req.user?.type === 'superior_admin' && !req.user?.company_id) return null;
  return req.user?.company_id ?? null;
};

const present = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  company_id: row.company_id ?? null,
  is_default: Boolean(row.is_default),
  is_active: row.is_active !== false,
  offsets: Array.isArray(row.offsets) ? row.offsets : cleanOffsets(row.offsets),
  // So the screen does not have to reimplement the phrasing the emails use.
  summary: (Array.isArray(row.offsets) ? row.offsets : cleanOffsets(row.offsets)).map(describeOffset),
});

/**
 * The schedule in force for the caller's company, and where it came from.
 *
 * `source` is the part a person needs: "platform" means nothing has been
 * decided here and editing will create a company schedule, while "company"
 * means this is theirs. A screen that does not say which is showing settings
 * that may or may not be the company's own.
 */
const getDefault = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);

  let row = companyId
    ? await ReminderSchedule.findOne({
      where: { company_id: companyId, is_default: true, is_active: true },
      order: [['id', 'DESC']],
    })
    : null;

  if (row) return res.json({ success: true, data: { ...present(row), source: 'company' } });

  const platform = await ReminderSchedule.findOne({
    where: { company_id: null, is_default: true, is_active: true },
    order: [['id', 'DESC']],
  });

  if (platform) {
    return res.json({
      success: true,
      data: {
        ...present(platform),
        source: companyId ? 'platform' : 'company',
        // A company admin is looking at somebody else's row; saying so stops
        // the screen offering to edit it in place.
        editable_in_place: !companyId,
      },
    });
  }

  /**
   * Nothing configured at all — which happens only before the seed migration
   * has run. The built-in is described rather than invented silently, so the
   * screen shows what will actually happen instead of an empty form.
   */
  return res.json({
    success: true,
    data: {
      id: null, name: 'Standard reminders', company_id: null, is_default: true, is_active: true,
      offsets: BUILT_IN_OFFSETS, summary: BUILT_IN_OFFSETS.map(describeOffset),
      source: 'built-in', editable_in_place: false,
    },
  });
});

/**
 * Save the company's default — creating it on the first edit.
 *
 * A platform admin with no company edits the platform row in place, which is
 * the only way the platform default can ever be changed.
 */
const saveDefault = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const offsets = cleanOffsets(req.body?.offsets);

  if (!offsets.length) {
    return res.status(400).json({
      message: 'Choose at least one day to send a reminder on, or turn reminders off instead.',
    });
  }

  const payload = {
    name: String(req.body?.name || '').trim() || 'Payment reminders',
    description: String(req.body?.description || '').trim() || null,
    offsets,
    is_default: true,
    is_active: req.body?.is_active !== false,
  };

  if (!companyId) {
    // Platform admin: this IS the platform default.
    const platform = await ReminderSchedule.findOne({
      where: { company_id: null, is_default: true }, order: [['id', 'DESC']],
    });
    if (platform) {
      await platform.update(payload);
      return res.json({ success: true, data: { ...present(platform), source: 'platform' } });
    }
    const created = await ReminderSchedule.create({
      ...payload, company_id: null, created_by: req.user?.id ?? null,
    });
    return res.status(201).json({ success: true, data: { ...present(created), source: 'platform' } });
  }

  const existing = await ReminderSchedule.findOne({
    where: { company_id: companyId, is_default: true }, order: [['id', 'DESC']],
  });

  if (existing) {
    await existing.update(payload);
    return res.json({ success: true, data: { ...present(existing), source: 'company' } });
  }

  // The copy-on-write moment. See the note at the top of the file.
  const created = await ReminderSchedule.create({
    ...payload, company_id: companyId, created_by: req.user?.id ?? null,
  });
  return res.status(201).json({ success: true, data: { ...present(created), source: 'company' } });
});

/** Every named schedule this company can put an invoice on. */
const listSchedules = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const rows = await ReminderSchedule.findAll({
    where: companyId ? { company_id: companyId } : {},
    order: [['is_default', 'DESC'], ['name', 'ASC']],
  });
  res.json({ success: true, data: rows.map(present) });
});

/** A named schedule, for invoices that need something other than the default. */
const createSchedule = asyncHandler(async (req, res) => {
  const offsets = cleanOffsets(req.body?.offsets);
  if (!offsets.length) {
    return res.status(400).json({ message: 'Choose at least one day to send a reminder on.' });
  }
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ message: 'Give the schedule a name so it can be recognised later.' });

  const created = await ReminderSchedule.create({
    name,
    description: String(req.body?.description || '').trim() || null,
    offsets,
    company_id: companyOf(req),
    is_default: false,
    is_active: true,
    created_by: req.user?.id ?? null,
  });
  res.status(201).json({ success: true, data: present(created) });
});

const updateSchedule = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const row = await ReminderSchedule.findOne({
    where: { id: req.params.id, ...(companyId ? { company_id: companyId } : {}) },
  });
  if (!row) return res.status(404).json({ message: 'Schedule not found' });

  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim() || row.name;
  if (req.body?.description !== undefined) patch.description = String(req.body.description).trim() || null;
  if (req.body?.is_active !== undefined) patch.is_active = Boolean(req.body.is_active);
  if (req.body?.offsets !== undefined) {
    const offsets = cleanOffsets(req.body.offsets);
    if (!offsets.length) return res.status(400).json({ message: 'Choose at least one day to send a reminder on.' });
    patch.offsets = offsets;
  }

  await row.update(patch);
  res.json({ success: true, data: present(row) });
});

/**
 * Put one or more invoices on a schedule — or back on the company default.
 *
 * Takes a list rather than one id because "these invoices" is how the need
 * actually arises: a corporate client with eight invoices on different terms,
 * chosen together from a list. A single-id endpoint would have the screen
 * looping and half-failing.
 *
 * `schedule_id: null` clears the override, which is how an invoice returns to
 * the company default — and is why clearing is an explicit action rather than a
 * deletion of the schedule.
 */
const assignToInvoices = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const ids = (Array.isArray(req.body?.invoice_ids) ? req.body.invoice_ids : [])
    .map(Number).filter(Number.isFinite);
  if (!ids.length) return res.status(400).json({ message: 'Choose at least one invoice.' });

  const scheduleId = req.body?.schedule_id == null ? null : Number(req.body.schedule_id);

  if (scheduleId !== null) {
    const schedule = await ReminderSchedule.findOne({
      where: { id: scheduleId, ...(companyId ? { company_id: companyId } : {}) },
    });
    if (!schedule) return res.status(404).json({ message: 'Schedule not found' });
  }

  const [, metadata] = await sequelize.query(
    `UPDATE invoices SET reminder_schedule_id = :scheduleId
      WHERE id IN (:ids) ${companyId ? 'AND company_id = :companyId' : ''}`,
    {
      replacements: { scheduleId, ids, ...(companyId ? { companyId } : {}) },
      type: QueryTypes.UPDATE,
    },
  );

  const updated = Number(metadata?.rowCount ?? metadata?.affectedRows ?? metadata ?? 0);
  res.json({
    success: true,
    data: {
      updated,
      schedule_id: scheduleId,
      // Said back, because "8 chosen, 6 updated" is the one outcome a person
      // needs to notice — two of them belonged to another company.
      requested: ids.length,
    },
  });
});

/** What a single invoice is actually on, and where that came from. */
const getForInvoice = asyncHandler(async (req, res) => {
  const companyId = companyOf(req);
  const invoice = await Invoice.findOne({
    where: { id: req.params.id, ...(companyId ? { company_id: companyId } : {}) },
    attributes: ['id', 'reminder_schedule_id', 'company_id'],
  });
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

  const { scheduleForInvoice } = require('../../../../shared/src/reminderSchedule');
  const resolved = await scheduleForInvoice(sequelize, {
    invoiceId: invoice.id, companyId: invoice.company_id,
  });

  res.json({
    success: true,
    data: {
      ...resolved,
      summary: resolved.offsets.map(describeOffset),
      // True only when this invoice carries its own; otherwise it is inheriting.
      overridden: Boolean(invoice.reminder_schedule_id),
    },
  });
});

module.exports = {
  getDefault, saveDefault,
  listSchedules, createSchedule, updateSchedule,
  assignToInvoices, getForInvoice,
};
