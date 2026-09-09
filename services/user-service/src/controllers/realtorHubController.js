const { Op, fn, col } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize, TrainingModule, TrainingEnrollment, RealtorStat, Recruit } = require('../models');

const MANAGER_ROLES = ['super_admin', 'admin', 'branch_manager'];

const isManager = (req) => MANAGER_ROLES.includes(req.user?.type);
const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const uniqueStrings = (items) => items.filter((item, index) => items.indexOf(item) === index);

const normalizeResourceLinks = (value) => {
  if (Array.isArray(value)) return uniqueStrings(value.map((item) => String(item || '').trim()).filter(Boolean));
  return uniqueStrings(String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
};

const normalizeQuizData = (value) => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const options = Array.isArray(item?.options) ? item.options.slice(0, 4).map((option) => String(option || '').trim()) : [];
      while (options.length < 4) options.push('');
      const correctIndex = Number(item?.correct_index);

      return {
        question: String(item?.question || '').trim(),
        options,
        correct_index: Number.isInteger(correctIndex) && correctIndex >= 0 && correctIndex < 4 ? correctIndex : 0,
      };
    })
    .filter((item) => item.question && item.options.every(Boolean));
};

const modulePayload = (body, userId) => {
  const hasQuiz = Boolean(body.has_quiz);
  return {
    title: String(body.title || '').trim(),
    category: String(body.category || '').trim().toLowerCase(),
    duration: String(body.duration || '').trim(),
    description: String(body.description || '').trim() || null,
    video_url: String(body.video_url || '').trim() || null,
    resource_links: normalizeResourceLinks(body.resource_links),
    status: String(body.status || 'draft').trim().toLowerCase(),
    has_quiz: hasQuiz,
    quiz_data: hasQuiz ? normalizeQuizData(body.quiz_data) : [],
    created_by: userId,
  };
};

const statPoints = (payload) => Math.round((toNumber(payload.total_sales) * 10) + (toNumber(payload.leads_closed) * 5) + (toNumber(payload.inspections_count) * 2));

const statPayload = (body) => {
  const payload = {
    realtor_id: toPositiveInt(body.realtor_id),
    realtor_name: String(body.realtor_name || '').trim(),
    branch: String(body.branch || '').trim(),
    total_sales: toNumber(body.total_sales),
    inspections_count: toNumber(body.inspections_count),
    leads_closed: toNumber(body.leads_closed),
    active_deals: toNumber(body.active_deals),
    period_start: body.period_start || null,
    period_end: body.period_end || null,
  };

  return { ...payload, points: statPoints(payload) };
};

const recruitPayload = (body, req) => {
  const manager = isManager(req);
  return {
    name: String(body.name || '').trim(),
    email: String(body.email || '').trim(),
    phone: String(body.phone || '').trim() || null,
    status: String(body.status || 'applied').trim().toLowerCase(),
    join_date: body.join_date,
    referred_by_id: manager ? (toPositiveInt(body.referred_by_id) || req.user.id) : req.user.id,
    referred_by_name: (manager ? String(body.referred_by_name || '').trim() : req.user.name) || req.user.name,
    commission_earned: toNumber(body.commission_earned),
    notes: String(body.notes || '').trim() || null,
  };
};

const formatTrainingModule = (module, enrolledCount = 0) => ({
  ...module.get({ plain: true }),
  enrolled_count: Number(enrolledCount || 0),
});

const rangeBounds = (range, startDate, endDate) => {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (range === 'custom' && (startDate || endDate)) {
    return {
      start: startDate ? new Date(`${startDate}T00:00:00`) : null,
      end: endDate ? new Date(`${endDate}T23:59:59`) : null,
    };
  }

  if (range === 'this_week') {
    const start = new Date(now);
    const day = start.getDay();
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }

  if (range === 'this_quarter') {
    const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }

  if (range === 'this_month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    return { start, end };
  }

  return { start: null, end: null };
};

const authorizeRecruitAccess = (req, recruit) => {
  if (isManager(req)) return true;
  return recruit.referred_by_id === req.user.id;
};

const listTrainingModules = asyncHandler(async (req, res) => {
  const where = {};
  if (isManager(req)) {
    if (req.query.status) where.status = String(req.query.status).toLowerCase();
  } else {
    where.status = 'active';
  }

  const [modules, counts] = await Promise.all([
    TrainingModule.findAll({ where, order: [['id', 'DESC']] }),
    TrainingEnrollment.findAll({
      attributes: ['module_id', [fn('COUNT', col('id')), 'enrolled_count']],
      group: ['module_id'],
      raw: true,
    }),
  ]);

  const countMap = Object.fromEntries(counts.map((item) => [String(item.module_id), Number(item.enrolled_count || 0)]));
  res.json({ data: modules.map((item) => formatTrainingModule(item, countMap[String(item.id)])) });
});

const createTrainingModule = asyncHandler(async (req, res) => {
  const created = await TrainingModule.create(modulePayload(req.body, req.user.id));
  res.status(201).json({ data: formatTrainingModule(created, 0) });
});

const updateTrainingModule = asyncHandler(async (req, res) => {
  const module = await TrainingModule.findByPk(req.params.id);
  if (!module) return res.status(404).json({ message: 'Training module not found' });
  await module.update(modulePayload(req.body, module.created_by || req.user.id));
  res.json({ data: formatTrainingModule(module) });
});

const deleteTrainingModule = asyncHandler(async (req, res) => {
  const module = await TrainingModule.findByPk(req.params.id);
  if (!module) return res.status(404).json({ message: 'Training module not found' });
  await TrainingEnrollment.destroy({ where: { module_id: module.id } });
  await module.destroy();
  res.json({ message: 'Training module deleted successfully' });
});

const enrollTrainingModule = asyncHandler(async (req, res) => {
  const module = await TrainingModule.findByPk(req.params.id);
  if (!module) return res.status(404).json({ message: 'Training module not found' });
  if (!isManager(req) && module.status !== 'active') {
    return res.status(403).json({ message: 'This module is not available yet' });
  }

  const realtorId = isManager(req) ? (toPositiveInt(req.body.realtor_id) || req.user.id) : req.user.id;
  const realtorName = isManager(req) ? (String(req.body.realtor_name || '').trim() || req.user.name) : req.user.name;

  const [enrollment, created] = await TrainingEnrollment.findOrCreate({
    where: { module_id: module.id, realtor_id: realtorId },
    defaults: {
      realtor_name: realtorName,
      status: 'in_progress',
      score: 0,
      answers: [],
    },
  });

  if (!created && enrollment.status === 'enrolled') {
    await enrollment.update({ status: 'in_progress' });
  }

  res.status(created ? 201 : 200).json({ data: enrollment });
});

const submitTrainingQuiz = asyncHandler(async (req, res) => {
  const module = await TrainingModule.findByPk(req.params.id);
  if (!module) return res.status(404).json({ message: 'Training module not found' });

  const realtorId = isManager(req) ? (toPositiveInt(req.body.realtor_id) || req.user.id) : req.user.id;
  const realtorName = isManager(req) ? (String(req.body.realtor_name || '').trim() || req.user.name) : req.user.name;

  const [enrollment] = await TrainingEnrollment.findOrCreate({
    where: { module_id: module.id, realtor_id: realtorId },
    defaults: { realtor_name: realtorName, status: 'in_progress', score: 0, answers: [] },
  });

  const questions = Array.isArray(module.quiz_data) ? module.quiz_data : [];
  const answers = Array.isArray(req.body.answers) ? req.body.answers.map((value) => Number(value)) : [];
  const correctCount = questions.reduce((total, question, index) => total + (Number(question.correct_index) === answers[index] ? 1 : 0), 0);
  const score = !module.has_quiz || !questions.length ? 100 : Math.round((correctCount / questions.length) * 100);
  const status = score >= 70 ? 'passed' : 'failed';

  await enrollment.update({
    realtor_name: enrollment.realtor_name || realtorName,
    answers,
    score,
    status,
    completed_at: new Date(),
  });

  res.json({
    data: {
      ...enrollment.get({ plain: true }),
      score,
      status,
      passed: status === 'passed',
      module_title: module.title,
    },
  });
});

const listTrainingProgress = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.module_id) where.module_id = req.query.module_id;

  if (isManager(req)) {
    if (req.query.realtor_id) where.realtor_id = req.query.realtor_id;
  } else {
    where.realtor_id = req.user.id;
  }

  const enrollments = await TrainingEnrollment.findAll({
    where,
    include: [{ model: TrainingModule, as: 'module' }],
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });

  res.json({ data: enrollments.map((item) => item.get({ plain: true })) });
});

const getTrainingCertificate = asyncHandler(async (req, res) => {
  const module = await TrainingModule.findByPk(req.params.id);
  if (!module) return res.status(404).json({ message: 'Training module not found' });

  const realtorId = isManager(req) ? (toPositiveInt(req.query.realtor_id) || req.user.id) : req.user.id;
  const enrollment = await TrainingEnrollment.findOne({ where: { module_id: module.id, realtor_id: realtorId } });
  if (!enrollment) return res.status(404).json({ message: 'Certificate not found' });

  res.json({
    data: {
      passed: enrollment.status === 'passed',
      realtor_name: enrollment.realtor_name,
      module_title: module.title,
      completed_at: enrollment.completed_at,
    },
  });
});

const leaderboardWhere = (req) => {
  const where = {};
  if (req.query.branch) where.branch = req.query.branch;

  const { start, end } = rangeBounds(req.query.range || 'this_month', req.query.start_date, req.query.end_date);
  if (start || end) {
    where[Op.and] = [];
    if (start) where[Op.and].push({ period_end: { [Op.gte]: start.toISOString().slice(0, 10) } });
    if (end) where[Op.and].push({ period_start: { [Op.lte]: end.toISOString().slice(0, 10) } });
  }

  return where;
};

const decorateLeaderboard = (rows) => rows.map((row, index) => {
  const plain = row.get({ plain: true });
  return {
    ...plain,
    rank: index + 1,
    points: Number(plain.points || 0),
    total_sales: Number(plain.total_sales || 0),
    trend: Number(plain.active_deals || 0) > 0 || Number(plain.leads_closed || 0) > 0 ? 'up' : 'down',
  };
});

const listLeaderboard = asyncHandler(async (req, res) => {
  const stats = await RealtorStat.findAll({
    where: leaderboardWhere(req),
    order: [['points', 'DESC'], ['total_sales', 'DESC'], ['leads_closed', 'DESC']],
  });

  res.json({ data: decorateLeaderboard(stats) });
});

const listLeaderboardStats = asyncHandler(async (req, res) => {
  const stats = await RealtorStat.findAll({
    where: leaderboardWhere(req),
    order: [['period_start', 'DESC'], ['points', 'DESC'], ['id', 'DESC']],
  });

  res.json({ data: stats.map((row) => ({ ...row.get({ plain: true }), total_sales: Number(row.total_sales || 0), points: Number(row.points || 0) })) });
});

const saveLeaderboardStat = asyncHandler(async (req, res) => {
  const payload = statPayload(req.body);
  let stat;

  if (req.body.id) {
    stat = await RealtorStat.findByPk(req.body.id);
    if (!stat) return res.status(404).json({ message: 'Leaderboard stat not found' });
    await stat.update(payload);
  } else {
    stat = await RealtorStat.create(payload);
  }

  res.status(req.body.id ? 200 : 201).json({ data: { ...stat.get({ plain: true }), total_sales: Number(stat.total_sales || 0), points: Number(stat.points || 0) } });
});

const listRecruits = asyncHandler(async (req, res) => {
  const where = {};
  const search = String(req.query.search || '').trim();

  if (!isManager(req)) where.referred_by_id = req.user.id;
  if (isManager(req) && req.query.referred_by_id) where.referred_by_id = req.query.referred_by_id;
  if (req.query.status) where.status = String(req.query.status).toLowerCase();
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
      { referred_by_name: { [Op.like]: `%${search}%` } },
    ];
  }

  const recruits = await Recruit.findAll({ where, order: [['join_date', 'DESC'], ['id', 'DESC']] });
  res.json({ data: recruits.map((row) => ({ ...row.get({ plain: true }), commission_earned: Number(row.commission_earned || 0) })) });
});

const createRecruit = asyncHandler(async (req, res) => {
  const created = await Recruit.create(recruitPayload(req.body, req));
  res.status(201).json({ data: { ...created.get({ plain: true }), commission_earned: Number(created.commission_earned || 0) } });
});

const updateRecruit = asyncHandler(async (req, res) => {
  const recruit = await Recruit.findByPk(req.params.id);
  if (!recruit) return res.status(404).json({ message: 'Recruit not found' });
  if (!authorizeRecruitAccess(req, recruit)) return res.status(403).json({ message: 'You do not have permission to manage this recruit' });

  await recruit.update(recruitPayload(req.body, req));
  res.json({ data: { ...recruit.get({ plain: true }), commission_earned: Number(recruit.commission_earned || 0) } });
});

const deleteRecruit = asyncHandler(async (req, res) => {
  const recruit = await Recruit.findByPk(req.params.id);
  if (!recruit) return res.status(404).json({ message: 'Recruit not found' });
  if (!authorizeRecruitAccess(req, recruit)) return res.status(403).json({ message: 'You do not have permission to manage this recruit' });

  await recruit.destroy();
  res.json({ message: 'Recruit deleted successfully' });
});

module.exports = {
  MANAGER_ROLES,
  listTrainingModules,
  createTrainingModule,
  updateTrainingModule,
  deleteTrainingModule,
  enrollTrainingModule,
  submitTrainingQuiz,
  listTrainingProgress,
  getTrainingCertificate,
  listLeaderboard,
  listLeaderboardStats,
  saveLeaderboardStat,
  listRecruits,
  createRecruit,
  updateRecruit,
  deleteRecruit,
};
