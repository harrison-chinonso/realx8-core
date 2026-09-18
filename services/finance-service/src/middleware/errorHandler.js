const logger = require('../config/logger');

const notFound = (req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
};

/**
 * Translate Sequelize and generic errors into a user-readable message.
 * Never leaks stack traces to the client.
 */
const humanizeError = (err) => {
  const name = err.name || '';

  // express-validator already structured these — pass through
  if (err.status === 422 && err.errors) return null;

  // Sequelize unique constraint: "users.email must be unique" → "email already exists"
  if (name === 'SequelizeUniqueConstraintError') {
    const fields = (err.errors || []).map((e) => e.path).filter(Boolean);
    if (fields.length) {
      return `${fields.join(', ')} already exists.`;
    }
    return 'A record with these details already exists.';
  }

  // Sequelize validation: collect all field messages
  if (name === 'SequelizeValidationError') {
    const msgs = (err.errors || []).map((e) => `${e.path}: ${e.message}`).filter(Boolean);
    if (msgs.length) return msgs.join(' | ');
    return err.message;
  }

  // Foreign key: explain the constraint in plain English
  if (name === 'SequelizeForeignKeyConstraintError') {
    return 'This record is linked to other data and cannot be removed or modified directly.';
  }

  // Database connection issues
  if (name === 'SequelizeConnectionError' || name === 'SequelizeConnectionRefusedError') {
    return 'Database connection failed. Please try again shortly.';
  }

  return null; // use err.message as-is
};

const errorHandler = (err, req, res, next) => {
  /*
   * A Sequelize error keeps the useful part in `err.parent`.
   *
   * `err.stack` alone printed a bare "Error" followed by frames — which is what
   * production logged, every sixty seconds, while /notes/pending-approval was
   * failing. The actual sentence ("UNION could not convert type
   * enum_debit_notes_party_type to enum_credit_notes_party_type") was sitting
   * one property away and never reached the log, so the outage looked like an
   * unnamed error in a file rather than a bug anybody could fix.
   */
  const cause = err.parent?.message || err.original?.message;
  logger.error([
    err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message,
    cause && cause !== err.message ? `caused by: ${cause}` : null,
    err.sql ? `sql: ${String(err.sql).replace(/\s+/g, ' ').slice(0, 400)}` : null,
    err.stack,
  ].filter(Boolean).join('\n'));
  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || (err.name?.startsWith('Sequelize') ? 400 : 500);
  const human = humanizeError(err);

  /**
   * A 500 says nothing about itself.
   *
   * Everything humanizeError recognises is a 4xx the caller can act on, and its
   * text is written for them. What falls through is an unhandled fault, and
   * `err.message` there is whatever the failing layer said — "Unknown column
   * 'x' in field list", a driver's connection string, the shape of a query.
   * That is reconnaissance handed to whoever provoked it, in exchange for a
   * message no legitimate caller can do anything with. The detail still goes to
   * the log above, with the stack, which is where it is useful.
   */
  const body = status >= 500 && !human
    ? 'Something went wrong. Please try again.'
    : (human || err.message || 'Something went wrong. Please try again.');

  res.status(status).json({
    message: body,
    errors: err.errors || undefined,
  });
};

module.exports = { notFound, errorHandler };
