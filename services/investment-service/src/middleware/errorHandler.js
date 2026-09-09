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
  logger.error(err.stack || err.message);
  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || (err.name?.startsWith('Sequelize') ? 400 : 500);
  const human = humanizeError(err);

  res.status(status).json({
    message: human || err.message || 'Something went wrong. Please try again.',
    errors: err.errors || undefined,
  });
};

module.exports = { notFound, errorHandler };
