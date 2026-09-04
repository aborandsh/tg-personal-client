// src/routes.js — REST API for the mobile app (behind requireApiToken).
const express = require('express');
const router = express.Router();

module.exports = function makeRoutes(getTd) {
  // getTd() -> TdSession | null

  const wrap = fn => (req, res) => {
    const td = getTd();
    if (!td) return res.status(503).json({ error: 'tdlib not started' });
    if (td.state !== 'ready') return res.status(409).json({ error: `tdlib not ready (state: ${td.state})` });
    fn(req, res, td).catch(e => {
      const code = e.status || (e.code === 429 ? 429 : 500);
      res.status(code).json({ error: e.message, td_code: e.code });
    });
  };

  router.get('/me', wrap(async (req, res, td) => {
    res.json(await td.invoke({ _: 'getMe' }));
  }));

  // ---- chats ---------------------------------------------------------------
  router.get('/chats', wrap(async (req, res, td) => {
    const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 100);
    const offset = parseInt(req.query.offset || '0', 10) || 0; // offset_chat_id
    const r = await td.invoke({
      _: 'getChats',
      chat_list: { _: 'chatListMain' },
      limit_chat_ids: limit + offset,
    });
    const ids = (r.chat_ids || []).slice(offset, offset + limit);
    // hydrate each chat (tdlib caches these; cheap)
    const chats = [];
    for (const id of ids) {
      try { chats.push(await td.invoke({ _: 'getChat', chat_id: id })); } catch { /* skip */ }
    }
    res.json({ count: chats.length, chats });
  }));

  router.get('/chats/:id/messages', wrap(async (req, res, td) => {
    const chatId = Number(req.params.id);
    const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 100);
    const fromMsgId = parseInt(req.query.from_message_id || '0', 10) || 0;
    const r = await td.invoke({
      _: 'getChatHistory',
      chat_id: chatId,
      from_message_id: fromMsgId,
      offset: fromMsgId ? 1 : 0, // when paging, skip the anchor itself
      limit,
      only_local: false,
    });
    res.json({ count: (r.messages || []).length, messages: r.messages || [] });
  }));

  router.post('/chats/:id/messages', wrap(async (req, res, td) => {
    const chatId = Number(req.params.id);
    const { text, reply_to_message_id, file_id, type } = req.body || {};
    let input;

    if (file_id && type === 'photo') {
      input = { _: 'inputMessagePhoto', photo: { _: 'inputFileRemote', id: file_id }, caption: { _: 'formattedText', text: text || '' } };
    } else if (file_id && type === 'file') {
      input = { _: 'inputMessageDocument', document: { _: 'inputFileRemote', id: file_id }, caption: { _: 'formattedText', text: text || '' } };
    } else if (file_id && type === 'voice') {
      input = { _: 'inputMessageVoiceNote', voice_note: { _: 'inputFileRemote', id: file_id }, caption: { _: 'formattedText', text: '' } };
    } else {
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'text (or file_id+type) required' });
      }
      input = { _: 'inputMessageText', text: { _: 'formattedText', text } };
    }

    const msg = await td.invoke({
      _: 'sendMessage',
      chat_id: chatId,
      reply_to_message_id: reply_to_message_id || 0,
      input_message_content: input,
    });
    res.json(msg);
  }));

  // ---- files ----------------------------------------------------------------
  router.get('/files/:id', wrap(async (req, res, td) => {
    const fileId = Number(req.params.id);
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return res.status(400).json({ error: 'bad file id' });
    }
    const f = await td.invoke({ _: 'getRemoteFile', remote_file_id: String(fileId), file_type: { _: 'fileTypeUnknown' } });
    // download (TDLib tracks progress via updates; we do a bounded await)
    const dl = await td.invoke({
      _: 'downloadFile',
      file_id: f.id,
      priority: 1,
      offset: 0,
      limit: 0, // whole file
      synchronous: true,
    });
    if (!dl.local || !dl.local.path) {
      return res.status(504).json({ error: 'download not complete yet; retry with file id ' + f.id });
    }
    res.sendFile(dl.local.path);
  }));

  return router;
};
