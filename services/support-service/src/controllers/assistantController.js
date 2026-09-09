const { QueryTypes } = require('sequelize');
const asyncHandler = require('../utils/asyncHandler');
const { sequelize } = require('../models');
const { answerMessage } = require('../assistant/answer');
const { assistantConfig } = require('../assistant/provider');
const { AssistantConversation, AssistantMessage } = require('../models');


/** Tenant display values, so the assistant speaks as this company's brand. */
const brandFor = async (companyId) => {
  const rows = await sequelize.query(
    `SELECT \`key\`, \`value\`, company_id FROM settings
      WHERE \`group\` = 'appearance' AND \`key\` IN ('app_name', 'currency')
        AND (company_id IS NULL OR company_id = :companyId)`,
    { replacements: { companyId: companyId ?? null }, type: QueryTypes.SELECT },
  );
  const global = {}; const company = {};
  rows.forEach((r) => { (r.company_id == null ? global : company)[r.key] = r.value; });
  const cfg = { ...global, ...company };
  return { appName: cfg.app_name || 'the app', currency: cfg.currency || 'NGN' };
};


/** A short label for the history list, from the opening question. */
const titleFrom = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * Loads a conversation the caller owns, or starts one.
 * Ownership is checked on user_id, never on company: a conversation contains
 * someone's budget and plans and is not their admin's to read.
 */
const resolveConversation = async (user, conversationId, firstMessage) => {
  if (conversationId) {
    const existing = await AssistantConversation.findOne({
      where: { id: Number(conversationId), user_id: user.id },
    });
    if (existing) return existing;
  }
  return AssistantConversation.create({
    user_id: user.id,
    company_id: user.company_id ?? null,
    title: titleFrom(firstMessage),
  });
};

/**
 * One assistant turn, streamed.
 *
 * Sends Server-Sent Events so text appears as it is written. Tool activity is
 * announced as its own event rather than as text, so the user sees "checking
 * your invoices…" instead of the model's internal calls.
 *
 * The caller's bearer token is threaded into every tool call, so the assistant
 * can only ever read what this user could already open in the app.
 */
const chat = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user?.id) return res.status(401).json({ message: 'Unauthenticated' });

  const config = await assistantConfig(user.company_id ?? null);
  if (!config.enabled) return res.status(503).json({ message: 'The assistant is turned off.' });

  const text = String(req.body.message || '').trim();
  if (!text) return res.status(400).json({ message: 'Send a message.' });

  const conversation = await resolveConversation(user, req.body.conversation_id, text);

  await AssistantMessage.create({ conversation_id: conversation.id, role: 'user', content: text.slice(0, 4000) });

  const brand = await brandFor(user.company_id ?? null);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Proxies buffer by default, which would defeat the point of streaming.
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { conversation_id: conversation.id });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    send('tool', { name: 'thinking' });
    const result = await answerMessage(text, {
      token,
      userId: user.id,
      userName: user.name,
      role: user.effectiveType || user.type,
      currency: brand.currency,
      appName: brand.appName,
    });

    // No model means the whole answer exists at once. It is still emitted in
    // pieces so the reply lands the way a person reads it, and so the widget
    // needs no special case for the two engines.
    if (!aborted) {
      for (const chunk of result.text.split(/(?<=\n\n)/)) {
        send('delta', { text: chunk });
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }

    await AssistantMessage.create({
      conversation_id: conversation.id,
      role: 'assistant',
      content: result.text,
      tools_used: result.tools?.length ? result.tools.join(',') : null,
    });
    await conversation.changed('updatedAt', true);
    await conversation.save();

    send('done', { conversation_id: conversation.id, tools_used: result.tools ?? [], handoff: Boolean(result.handoff) });
  } catch (error) {
    console.error('[assistant] turn failed:', error.message);
    send('error', { message: 'Something went wrong working that out.' });
  } finally {
    res.end();
  }
});

/** The caller's own conversations, most recent first. */
const listConversations = asyncHandler(async (req, res) => {
  const rows = await AssistantConversation.findAll({
    where: { user_id: req.user.id },
    order: [['updatedAt', 'DESC']],
    limit: 30,
  });
  res.json({ data: rows.map((c) => ({ id: c.id, title: c.title, updated_at: c.updatedAt })) });
});

/** Messages in one conversation the caller owns. */
const getConversation = asyncHandler(async (req, res) => {
  const conversation = await AssistantConversation.findOne({
    where: { id: Number(req.params.id), user_id: req.user.id },
  });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });

  const messages = await AssistantMessage.findAll({
    where: { conversation_id: conversation.id },
    order: [['id', 'ASC']],
  });
  res.json({
    data: {
      id: conversation.id,
      title: conversation.title,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
  });
});

/** Users can clear their own history — it is their data. */
const deleteConversation = asyncHandler(async (req, res) => {
  const conversation = await AssistantConversation.findOne({
    where: { id: Number(req.params.id), user_id: req.user.id },
  });
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  await AssistantMessage.destroy({ where: { conversation_id: conversation.id } });
  await conversation.destroy();
  res.json({ message: 'Conversation deleted.' });
});

/** Lets the widget know whether to show itself at all. */
const status = asyncHandler(async (req, res) => {
  const config = await assistantConfig(req.user?.company_id ?? null);
  const brand = await brandFor(req.user?.company_id ?? null);
  res.json({
    data: {
      enabled: config.enabled,
      name: config.assistantName,
      app_name: brand.appName,
      reason: config.enabled ? null : 'The assistant has been switched off for this company.',
    },
  });
});

module.exports = { chat, status, listConversations, getConversation, deleteConversation };
