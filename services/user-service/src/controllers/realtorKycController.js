const asyncHandler = require('../utils/asyncHandler');
const { buildCompanyScope } = require('../utils/crudFactory');
const { RealtorKyc, User, sequelize } = require('../models');
const { createNotifier } = require('../../../../shared/src/notifier');
const { appUrl } = require('../../../../shared/src/appOrigin');

const { notifyUser } = createNotifier(sequelize);
const { createDispatcher } = require('../../../../shared/src/notificationDispatcher');
const { raiseRealtorCharge, verificationFeeMinor } = require('../utils/realtorChargeGateway');
// Recipients come from configuration, not from these call sites.
const notify = createDispatcher(sequelize);

const effectiveType = (req) => req.user?.effectiveType || req.user?.type;
const isRealtor = (req) => effectiveType(req) === 'realtor';

/** KYC review is a company-admin task, like realtor placement. */
const isReviewer = (req) => !req.user?.isSuperiorAdmin
  && !!req.user?.company_id
  && ['admin', 'super_admin'].includes(effectiveType(req));

const ID_TYPES = ['national_id', 'drivers_license', 'passport', 'voters_card'];
const ADDRESS_TYPES = ['utility_bill', 'bank_statement', 'tenancy_agreement', 'other'];

/** The realtor's own submission, or null if they have never submitted. */
const getMyKyc = asyncHandler(async (req, res) => {
  if (!isRealtor(req)) {
    return res.status(403).json({ message: 'Only realtors submit verification details.' });
  }
  const record = await RealtorKyc.findOne({ where: { user_id: req.user.id }, order: [['id', 'DESC']] });
  res.json({ data: record });
});

/**
 * Submit or re-submit verification.
 *
 * An approved record is final — re-submitting would silently revoke a
 * verification an admin already granted. A rejected or pending one may be
 * replaced, which is how a realtor fixes a bad upload.
 */
const submitKyc = asyncHandler(async (req, res) => {
  if (!isRealtor(req)) {
    return res.status(403).json({ message: 'Only realtors submit verification details.' });
  }

  const existing = await RealtorKyc.findOne({ where: { user_id: req.user.id }, order: [['id', 'DESC']] });
  if (existing?.status === 'approved') {
    return res.status(409).json({ message: 'Your verification is already approved.' });
  }

  const idType = String(req.body.id_type || '');
  const addressType = String(req.body.address_document_type || '');
  const idNumber = String(req.body.id_number || '').trim();
  const idDoc = String(req.body.id_document_url || '').trim();
  const addressDoc = String(req.body.address_document_url || '').trim();
  const addressLine = String(req.body.address_line || '').trim();

  if (!ID_TYPES.includes(idType)) return res.status(400).json({ message: 'Select a valid means of identification.' });
  if (!idNumber) return res.status(400).json({ message: 'Enter the identification number.' });
  if (!idDoc) return res.status(400).json({ message: 'Upload a copy of your identification.' });
  if (!ADDRESS_TYPES.includes(addressType)) return res.status(400).json({ message: 'Select a valid proof of address type.' });
  if (!addressLine) return res.status(400).json({ message: 'Enter your residential address.' });
  if (!addressDoc) return res.status(400).json({ message: 'Upload your proof of address.' });

  const payload = {
    user_id: req.user.id,
    id_type: idType,
    id_number: idNumber,
    id_document_url: idDoc,
    address_document_type: addressType,
    address_line: addressLine,
    address_document_url: addressDoc,
    status: 'pending',
    review_notes: null,
    reviewed_by: null,
    reviewed_at: null,
    submitted_at: new Date(),
    company_id: req.user?.company_id ?? null,
  };

  // Replace the previous attempt rather than accumulating rejected rows.
  const record = existing ? await existing.update(payload) : await RealtorKyc.create(payload);

  /*
   * The fee, if the company charges one.
   *
   * Best-effort on purpose. This submission is not written in a transaction,
   * so the alternatives are a 500 after the verification row has already been
   * saved — leaving the realtor unable to tell whether they submitted — or a
   * verification with no bill, which an admin can raise by hand. The second is
   * the lesser failure, and it is logged rather than swallowed.
   *
   * raiseRealtorCharge returns the existing note when one is already open, so
   * resubmitting after a rejection does not bill twice.
   */
  let charge = null;
  try {
    charge = await raiseRealtorCharge({
      realtorId: req.user.id,
      companyId: req.user?.company_id ?? null,
      amountMinor: await verificationFeeMinor(req.user?.company_id ?? null),
      sourceType: 'realtor_verification',
      sourceId: record.id,
      reason: 'Identity verification fee',
    });
  } catch (chargeError) {
    console.error(`[realtor-kyc] could not raise the verification fee: ${chargeError.message}`);
  }
  // Was silent: a submission sat in the queue with nobody told it needed
  // reviewing. Reaches whoever holds users.manage by default.
  notify.dispatch({
    eventKey: 'realtor_kyc_submitted',
    subjectUserId: req.user?.id ?? null,
    companyId: req.user?.company_id ?? null,
    title: () => 'Identity verification submitted',
    body: (role, ctx) => (role === 'subject'
      ? 'Your identity verification has been submitted and is awaiting review.'
      : `${ctx.subject?.name || 'A realtor'} has submitted an identity verification for review.`),
    actionLabel: 'Review verifications',
    actionUrl: appUrl('realtor-kyc', req),
  }).catch(() => {});

  // The note rides back with the record so the realtor is told what they owe
  // on the screen that just took their documents, not on a later visit.
  res.status(existing ? 200 : 201).json({ data: record, charge });
});

/** Company admins review submissions from their own realtors. */
const listKyc = asyncHandler(async (req, res) => {
  if (!isReviewer(req)) {
    return res.status(403).json({ message: 'Only a company administrator can review verifications.' });
  }
  const where = { company_id: req.user.company_id };
  if (req.query.status) where.status = String(req.query.status);

  const records = await RealtorKyc.findAll({
    where,
    include: [{ model: User, as: 'realtor', attributes: ['id', 'name', 'email', 'phone', 'realtor_code'] }],
    order: [['id', 'DESC']],
  });
  res.json({ data: records });
});

const review = (status) => asyncHandler(async (req, res) => {
  if (!isReviewer(req)) {
    return res.status(403).json({ message: 'Only a company administrator can review verifications.' });
  }

  const record = await RealtorKyc.findOne({
    where: { id: req.params.id, company_id: req.user.company_id },
  });
  if (!record) return res.status(404).json({ message: 'Verification not found' });
  if (record.status !== 'pending') {
    return res.status(409).json({ message: `This verification has already been ${record.status}.` });
  }

  const notes = String(req.body.notes ?? '').trim();
  if (status === 'rejected' && !notes) {
    return res.status(400).json({ message: 'A reason is required when rejecting a verification.' });
  }

  await record.update({
    status,
    review_notes: notes || null,
    reviewed_by: req.user?.id ?? null,
    reviewed_at: new Date(),
  });

  notify.dispatch({
    eventKey: status === 'approved' ? 'realtor_kyc_approved' : 'realtor_kyc_rejected',
    subjectUserId: record.user_id,
    companyId: record.company_id ?? null,
    context: { record },
    title: () => (status === 'approved' ? 'Your verification was approved' : 'Verification needs attention'),
    body: (role, ctx) => {
      if (role !== 'subject') {
        return `${ctx.subject?.name || 'A realtor'}'s identity verification was `
          + `${status === 'approved' ? 'approved' : 'rejected'}.${notes ? ` Note: ${notes}` : ''}`;
      }
      return status === 'approved'
        ? `Your identity verification has been approved.${notes ? ` Note: ${notes}` : ''}`
        : `Your identity verification was not accepted. Reason: ${notes}`;
    },
    data: { kyc_id: record.id },
    // Approved realtors are sent to the dashboard where the badge now shows;
    // a rejection needs the form itself so they can correct and resubmit.
    actionLabel: status === 'approved' ? 'Go to your dashboard' : 'Update your submission',
    actionUrl: appUrl(status === 'approved' ? 'dashboard' : 'realtor/verification', req),
  }).catch(() => {});

  res.json({ data: record });
});

module.exports = {
  getMyKyc,
  submitKyc,
  listKyc,
  approveKyc: review('approved'),
  rejectKyc: review('rejected'),
};
